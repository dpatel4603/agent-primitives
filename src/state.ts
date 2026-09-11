import { DurableObject } from 'cloudflare:workers'
import type { Store } from 'mppx/server'
import { Fedspend } from './fedspend.ts'
import { createGateway, sha256 } from './gateway.ts'
import type { Entry } from './gateway.ts'
import { createLedger } from './ledger.ts'
import { completedEntry, confirmPayment } from './reconciliation.ts'
import { createPayments } from './payments.ts'
import type { Config } from './payments.ts'
export class PaymentState extends DurableObject<Config> {
  private active = 0
  // RPC methods are reachable only via an authenticated Cloudflare binding.
  // They are deliberately not routed by the public Worker.
  async inspectRequest(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid request ID')
    return (await this.ctx.storage.get<Entry>(`request:${key}`)) ?? null
  }
  async reconcilePaid(key: string, transactionHash: string) {
    const entry = await this.inspectRequest(key)
    if (!entry?.payment || entry.state !== 'settling') throw new Error('Not an uncertain payment')
    await confirmPayment(entry.payment, transactionHash)
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<Entry>(`request:${key}`)
      if (!current || current.owner !== entry.owner || current.state !== 'settling') throw new Error('Request changed during reconciliation')
      await tx.put(`request:${key}`, completedEntry(key, current, transactionHash))
    })
    return { request_id: key, state: 'complete' }
  }
  async fetch(request: Request): Promise<Response> {
    // All instances share one object's durable replay store and request ledger.
    const storage = this.ctx.storage
    const store: Store.AtomicStore = {
      get: async key => (await storage.get(`replay:${key}`)) ?? null,
      put: async (key, value) => { await storage.put(`replay:${key}`, value) },
      delete: async key => { await storage.delete(`replay:${key}`) },
      update: async (key, fn) => storage.transaction(async tx => {
        const change = fn((await tx.get(`replay:${key}`)) ?? null)
        if (change.op === 'set') await tx.put(`replay:${key}`, change.value)
        if (change.op === 'delete') await tx.delete(`replay:${key}`)
        return change.result
      }),
    }
    const ledger = createLedger(storage)
    const ipHash = await sha256(request.headers.get('cf-connecting-ip') ?? 'local')
    const now = Date.now()
    const allowed = await storage.transaction(async tx => {
      const limits = [[`rate:${ipHash}`, 30], ['rate:global', 300]] as const
      const updates = []
      for (const [key, maximum] of limits) {
        const old = await tx.get<{ start: number; count: number }>(key)
        const rate = !old || now - old.start >= 60000 ? { start: now, count: 0 } : old
        if (rate.count >= maximum) return false
        updates.push({ key, value: { start: rate.start, count: rate.count + 1 } })
      }
      for (const update of updates) await tx.put(update.key, update.value)
      return true
    })
    if (!allowed) return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '60' } })
    if (this.active >= 8) return Response.json({ error: 'Service busy; retry without creating another payment' }, { status: 503, headers: { 'Retry-After': '5' } })
    this.active++
    try {
      const gateway = createGateway({ payments: createPayments(this.env, store), lookup: q => new Fedspend(fetch, this.env.UPSTREAM_USER_AGENT).lookup(q), ledger })
      if (await storage.getAlarm() === null) await storage.setAlarm(Date.now() + 3600000)
      const response = await gateway(request)
      console.log(JSON.stringify({ event: 'request.completed', status: response.status, request_id: response.headers.get('x-request-id'), replayed: response.headers.get('idempotency-replayed') === 'true' }))
      return response
    } finally { this.active-- }
  }
  async alarm() {
    // Only ephemeral rates and expired *unpaid* preparations are removed.
    // Settling entries and completed payment records are retained for audit and
    // recovery; do not delete payment evidence on a timer.
    const storage = this.ctx.storage
    let cursor = await storage.get<string>('rate-cleanup-cursor')
    const entries = await storage.list<{ start: number }>({ prefix: 'rate:', limit: 1000, ...(cursor ? { startAfter: cursor } : {}) })
    for (const [key, value] of entries) {
      if (value.start < Date.now() - 3600000) await storage.delete(key)
      cursor = key
    }
    if (entries.size === 1000 && cursor) await storage.put('rate-cleanup-cursor', cursor)
    else await storage.delete('rate-cleanup-cursor')
    await storage.setAlarm(Date.now() + 3600000)
  }
}
