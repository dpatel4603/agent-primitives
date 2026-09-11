import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/fedspend.ts'
import { createGateway, readBody } from '../src/gateway.ts'
import type { Payments } from '../src/gateway.ts'
import { createLedger } from '../src/ledger.ts'
import { memoryStorage, query } from './helpers.ts'
function setup() {
  const events: string[] = []; const storage = memoryStorage(); const ledger = createLedger(storage)
  const payments: Payments = {
    inspect: async () => ({ key: 'payment-id', proof: 'original-proof' }),
    validate: async () => { events.push('validate'); return null },
    pay: async request => { events.push('pay'); return request.headers.has('authorization') ? { status: 200, withReceipt: response => { response.headers.set('Payment-Receipt', 'test-receipt'); return response } } : { status: 402, challenge: new Response(null, { status: 402, headers: { 'WWW-Authenticate': 'Payment test' } }) } },
  }
  const lookup = async () => { events.push('lookup'); return { awards: [] } }
  return { events, storage, ledger, payments, lookup }
}
const request = (body: unknown = query, paid = true) => new Request('https://api.example.com/v1/fedspend/company', { method: 'POST', headers: { 'content-type': 'application/json', ...(paid ? { authorization: 'Payment test-proof' } : {}) }, body: JSON.stringify(body) })
test('unpaid empty scanner probe gets 402 without upstream or ledger', async () => {
  const deps = setup(); const res = await createGateway(deps)(request({}, false))
  assert.equal(res.status, 402); assert.deepEqual(deps.events, ['pay']); assert.equal(await deps.ledger.get('payment-id'), undefined)
})
test('validation failure never submits payment', async () => {
  const deps = setup(); const res = await createGateway(deps)(request({ ...query, limit: '10' }))
  assert.equal(res.status, 400); assert.deepEqual(deps.events, [])
})
test('invalid credential never queries upstream or creates ledger', async () => {
  const deps = setup(); deps.payments.validate = async () => new Response(null, { status: 402 })
  assert.equal((await createGateway(deps)(request())).status, 402)
  assert.deepEqual(deps.events, []); assert.equal(await deps.ledger.get('payment-id'), undefined)
})
test('upstream failure releases unpaid claim and never submits payment', async () => {
  const deps = setup(); deps.lookup = async () => { throw new ApiError(502, 'upstream failed') }
  assert.equal((await createGateway(deps)(request())).status, 502)
  assert.deepEqual(deps.events, ['validate']); assert.equal(await deps.ledger.get('payment-id'), undefined)
})
test('prepared body persisted before payment, stored once on success, retry recovers receipt', async () => {
  const deps = setup(); const originalPay = deps.payments.pay
  deps.payments.pay = async req => { assert.equal((await deps.ledger.get('payment-id'))?.state, 'settling'); assert.ok((await deps.ledger.get('payment-id'))?.prepared); return originalPay(req) }
  const gateway = createGateway(deps); const first = await gateway(request()); const second = await gateway(request())
  assert.equal(first.status, 200); assert.equal(second.status, 200)
  assert.equal(await first.text(), await second.text()); assert.equal(second.headers.get('idempotency-replayed'), 'true')
  assert.equal(second.headers.get('payment-receipt'), 'test-receipt'); assert.deepEqual(deps.events, ['validate', 'lookup', 'pay'])
  assert.equal((await deps.ledger.get('payment-id'))?.prepared, undefined)
})
test('different body or guessed proof cannot retrieve a paid response', async () => {
  const deps = setup(); const gateway = createGateway(deps); await gateway(request())
  assert.equal((await gateway(request({ ...query, page: 2 }))).status, 409)
  deps.payments.inspect = async () => ({ key: 'payment-id', proof: 'forged-proof' })
  assert.equal((await gateway(request())).status, 409)
})
test('concurrent identical requests settle once', async () => {
  const deps = setup(); const gateway = createGateway(deps)
  const responses = await Promise.all([gateway(request()), gateway(request())])
  assert.ok(responses.some(r => r.status === 200)); assert.equal(deps.events.filter(e => e === 'pay').length, 1)
})
test('unknown settlement outcome stays locked with prepared recovery data', async () => {
  const deps = setup(); deps.payments.pay = async () => { throw new Error('timeout after broadcast') }
  const gateway = createGateway(deps)
  assert.equal((await gateway(request())).status, 503); assert.equal((await gateway(request())).status, 409)
  assert.equal((await deps.ledger.get('payment-id'))?.state, 'settling'); assert.ok((await deps.ledger.get('payment-id'))?.prepared)
})
test('large chunked body is cancelled without payment', async () => {
  const deps = setup(); let cancelled = false
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9000)) }, cancel() { cancelled = true } })
  const req = new Request('https://api.example.com/v1/fedspend/company', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  assert.equal((await createGateway(deps)(req)).status, 413); assert.equal(cancelled, true); assert.deepEqual(deps.events, [])
})
test('expired preparation lease can be reclaimed; old owner cannot settle or delete', async () => {
  const storage = memoryStorage(); let now = 1000; const ledger = createLedger(storage, () => now)
  const a = await ledger.claim('key', 'body', 'proof'); now += 61000
  const b = await ledger.claim('key', 'body', 'proof'); assert.equal(b.acquired, true)
  await assert.rejects(ledger.put('key', a.entry.owner, { ...a.entry, state: 'settling' }))
  await ledger.delete('key', a.entry.owner); assert.equal((await ledger.get('key'))?.owner, b.entry.owner)
})

test('slow request body has a deadline and cancellation', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const req = new Request('https://api.example.com', { method: 'POST', body, duplex: 'half' } as RequestInit)
  await assert.rejects(readBody(req, 8192, 10), e => e instanceof ApiError && e.status === 408)
  assert.equal(cancelled, true)
})
