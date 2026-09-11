import { ApiError, parseQuery } from './fedspend.ts'
import type { Query } from './fedspend.ts'
export type PaymentResult = { status: 402; challenge: Response } | { status: 200; withReceipt: (response: Response) => Response }
export type Identity = { key: string; proof: string }
export interface Payments {
  inspect(request: Request): Promise<Identity>
  validate(request: Request): Promise<Response | null>
  pay(request: Request): Promise<PaymentResult>
}
export type StoredResponse = { body: string; status: number; headers: [string, string][] }
export type Entry = { fingerprint: string; proof: string; owner: string; lease_until: number; state: 'preparing' | 'prepared' | 'settling' | 'complete'; created_at: string; prepared?: string; response?: StoredResponse }
export interface Ledger {
  get(key: string): Promise<Entry | undefined>
  claim(key: string, fingerprint: string, proof: string): Promise<{ acquired: boolean; entry: Entry }>
  put(key: string, owner: string, entry: Entry): Promise<void>
  delete(key: string, owner: string): Promise<void>
}
export const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('')
export const canonicalize = (v: unknown): unknown => Array.isArray(v) ? v.map(canonicalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonicalize(value)])) : v
export async function readBody(request: Request, max = 8192) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) { await reader.cancel(); throw new ApiError(413, 'Request body too large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const joined = new Uint8Array(size); let offset = 0
  for (const c of chunks) { joined.set(c, offset); offset += c.length }
  return new TextDecoder().decode(joined)
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } }) }
export function createGateway(deps: { payments: Payments; lookup(query: Query): Promise<unknown>; ledger: Ledger }) {
  return async (request: Request): Promise<Response> => {
    const mpp = request.headers.get('authorization'); const x402 = request.headers.get('payment-signature')
    if (mpp && x402) return json({ error: 'Use only one payment protocol per request' }, 400)
    let request_id: string | undefined
    let entry: Entry | undefined
    let acquired = false
    let settlementStarted = false
    try {
      if ((mpp?.length ?? 0) + (x402?.length ?? 0) > 32768) throw new ApiError(413, 'Payment credential too large')
      const raw = await readBody(request)
      const paymentRequest = () => new Request(request.url, { method: request.method, headers: request.headers, body: raw })
      if (!mpp && !x402) {
        const result = await deps.payments.pay(paymentRequest())
        return result.status === 402 ? result.challenge : json({ error: 'Payment credential required' }, 402)
      }
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new ApiError(400, 'Request body must be valid JSON') }
      const fingerprint = await sha256(JSON.stringify({ path: new URL(request.url).pathname, body: canonicalize(body) }))
      const query = parseQuery(body)
      const identity = await deps.payments.inspect(paymentRequest())
      request_id = identity.key
      // A saved response requires the original cryptographic proof, not merely
      // knowledge of a payer address/nonce. Expired proofs can recover results.
      const existing = await deps.ledger.get(request_id)
      if (existing) {
        if (existing.proof !== identity.proof || existing.fingerprint !== fingerprint) throw new ApiError(409, 'Payment was already associated with a different proof or request')
        if (existing.state === 'complete' && existing.response) return new Response(existing.response.body, { status: existing.response.status, headers: [...existing.response.headers, ['Idempotency-Replayed', 'true']] })
        if (existing.state === 'settling' || existing.lease_until > Date.now()) return json({ error: 'Request is processing or requires payment reconciliation. Do not submit another payment.', request_id, state: existing.state }, 409, { 'Retry-After': '5' })
      }
      const invalid = await deps.payments.validate(paymentRequest())
      if (invalid) return invalid
      const claim = await deps.ledger.claim(request_id, fingerprint, identity.proof)
      entry = claim.entry; acquired = claim.acquired
      if (!acquired) return json({ error: 'Request already processing; retry the same proof', request_id }, 409, { 'Retry-After': '5' })
      if (!entry.prepared) {
        const result = await deps.lookup(query)
        const prepared = JSON.stringify({ ...(result as Record<string, unknown>), request_id })
        // Keep well below storage limits, including receipts. Persist BEFORE pay.
        if (new TextEncoder().encode(prepared).byteLength > 90000) throw new ApiError(413, 'Result too large; reduce limit and retry. No payment submitted.')
        entry = { ...entry, state: 'prepared', prepared }
        await deps.ledger.put(request_id, entry.owner, entry)
      }
      entry = { ...entry, state: 'settling' }
      await deps.ledger.put(request_id, entry.owner, entry)
      settlementStarted = true
      const payment = await deps.payments.pay(paymentRequest())
      if (payment.status === 402) return json({ error: 'Payment was not confirmed; reconciliation required before submitting another payment', request_id }, 409)
      const response = payment.withReceipt(new Response(entry.prepared, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'X-Request-Id': request_id } }))
      const saved = { body: await response.text(), status: response.status, headers: [...response.headers] as [string, string][] }
      // Store the large body only once after success.
      const { prepared: _, ...completed } = entry
      await deps.ledger.put(request_id, entry.owner, { ...completed, state: 'complete', response: saved })
      return new Response(saved.body, { status: saved.status, headers: saved.headers })
    } catch (error) {
      if (acquired && entry && request_id && !settlementStarted) {
        try { await deps.ledger.delete(request_id, entry.owner) } catch { /* Expiring lease permits safe recovery. */ }
      }
      if (settlementStarted) return json({ error: 'Payment outcome needs reconciliation; do not submit another payment', request_id }, 503)
      if (error instanceof ApiError) return json({ error: error.message, ...error.details, request_id }, error.status)
      return json({ error: 'Request could not be prepared; no payment was submitted', request_id }, 503)
    }
  }
}
