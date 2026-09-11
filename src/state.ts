import { DurableObject } from 'cloudflare:workers'
import type { Store } from 'mppx/server'
import { Fedspend } from './fedspend.ts'
import { createGateway, sha256 } from './gateway.ts'
import type { Entry } from './gateway.ts'
import { createLedger } from './ledger.ts'
import { createPayments } from './payments.ts'
import type { Config } from './payments.ts'
export class PaymentState extends DurableObject<Config> {
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
      const key = `rate:${ipHash}`
      const old = await tx.get<{ start: number; count: number }>(key)
      const rate = !old || now - old.start >= 60000 ? { start: now, count: 0 } : old
      if (rate.count >= 30) return false
      rate.count++
      await tx.put(key, rate)
      return true
    })
    if (!allowed) return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '60' } })
    const gateway = createGateway({ payments: createPayments(this.env, store), lookup: q => new Fedspend(fetch, this.env.UPSTREAM_USER_AGENT).lookup(q), ledger })
    if (await storage.getAlarm() === null) await storage.setAlarm(Date.now() + 3600000)
    const response = await gateway(request)
    console.log(JSON.stringify({ event: 'request.completed', status: response.status, request_id: response.headers.get('x-request-id'), replayed: response.headers.get('idempotency-replayed') === 'true' }))
    return response
  }
  async alarm() {
    // Only ephemeral rates and expired *unpaid* preparations are removed.
    // Settling entries and completed payment records are retained for audit and
    // recovery; do not delete payment evidence on a timer.
    const storage = this.ctx.storage
    const entries = await storage.list<{ start?: number; state?: string; lease_until?: number }>({ limit: 1000 })
    for (const [key, value] of entries) {
      if (key.startsWith('rate:') && (value.start ?? 0) < Date.now() - 3600000) await storage.delete(key)
    }
    await storage.setAlarm(Date.now() + 3600000)
  }
}
