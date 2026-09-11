import test from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { Store } from 'mppx/server'
import { Header } from 'mppx/x402'
import { Credential, Challenge } from 'mppx'
import { createPayments, PATH } from '../src/payments.ts'
import { config, query } from './helpers.ts'
// Public deterministic fixture key, never fund this account.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const dual = { ...config, X402_ENABLED: 'true', X402_NETWORK: 'base-sepolia', X402_RECIPIENT: config.MPP_RECIPIENT, X402_FACILITATOR_URL: 'https://facilitator.example' }
const request = (signature?: string) => new Request(`https://api.example.com${PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'Payment-Signature': signature } : {}) }, body: JSON.stringify(query) })
async function signedPayment(payments: ReturnType<typeof createPayments>) {
  const initial = await payments.pay(request()); assert.equal(initial.status, 402)
  if (initial.status !== 402) throw new Error('missing challenge')
  const challenge = Header.decodePaymentRequired(initial.challenge.headers.get('payment-required')!)
  const accepted = challenge.accepts[0]
  const authorization = { from: account.address, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 120), nonce: `0x${'22'.repeat(32)}` }
  const signature = await account.signTypedData({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: accepted.asset as `0x${string}` }, types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] }, primaryType: 'TransferWithAuthorization', message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } as any })
  return { x402Version: 2 as const, accepted, resource: challenge.resource, payload: { authorization, signature } }
}
test('MPP-only public challenge is valid and does not advertise x402', async () => {
  const payments = createPayments(config, Store.memory()); const result = await payments.pay(request())
  assert.equal(result.status, 402)
  if (result.status !== 402) return
  assert.match(result.challenge.headers.get('www-authenticate')!, /^Payment /)
  assert.equal(result.challenge.headers.get('payment-required'), null)
})
test('x402 preflight checks signature and facilitator validity without settlement; encoding changes preserve identity', async () => {
  const payments = createPayments(dual, Store.memory()); const payload = await signedPayment(payments)
  const header = Header.encodePaymentSignature(payload as any)
  const original = globalThis.fetch; let calls = 0
  globalThis.fetch = async url => { calls++; assert.ok(String(url).endsWith('/verify')); return Response.json({ isValid: true }) }
  try {
    assert.equal(await payments.validate(request(header)), null)
    const alternate = Buffer.from(JSON.stringify({ payload: payload.payload, resource: payload.resource, accepted: payload.accepted, x402Version: 2 }, null, 2)).toString('base64')
    assert.deepEqual(await payments.inspect(request(header)), await payments.inspect(request(alternate)))
    const wrong = structuredClone(payload); wrong.payload.authorization.to = account.address
    assert.equal((await payments.validate(request(Header.encodePaymentSignature(wrong as any))))?.status, 402)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
test('real x402 path verifies and settles through facilitator only on pay', async () => {
  const original = globalThis.fetch; const calls: string[] = []
  globalThis.fetch = async url => {
    calls.push(String(url))
    if (String(url).endsWith('/verify')) return Response.json({ isValid: true, payer: account.address })
    if (String(url).endsWith('/settle')) return Response.json({ success: true, payer: account.address, network: 'eip155:84532', transaction: `0x${'33'.repeat(32)}` })
    throw new Error('Unexpected network request')
  }
  try {
    const payments = createPayments(dual, Store.memory()); const payload = await signedPayment(payments)
    const result = await payments.pay(request(Header.encodePaymentSignature(payload as any)))
    assert.equal(result.status, 200)
    assert.deepEqual(calls, ['https://facilitator.example/verify', 'https://facilitator.example/settle'])
    if (result.status === 200) assert.ok(result.withReceipt(new Response('OK')).headers.get('payment-response'))
  } finally { globalThis.fetch = original }
})
test('malformed and wrong-method native credentials cannot create payment identities', async () => {
  const payments = createPayments(config, Store.memory())
  await assert.rejects(payments.inspect(new Request(`https://api.example.com${PATH}`, { method: 'POST', headers: { authorization: 'Bearer fake' } })))
})
test('runtime Bazaar includes input/output schemas and preserves mppx binding', async () => {
  const payments = createPayments(dual, Store.memory()); const result = await payments.pay(request())
  if (result.status !== 402) throw new Error('Missing challenge')
  const challenge = Header.decodePaymentRequired(result.challenge.headers.get('payment-required')!)
  assert.ok(challenge.extensions?.mppx)
  assert.ok((challenge.extensions?.bazaar.schema as any).properties.output.properties.example)
})
test('unfunded x402 authorization is rejected by read-only preflight', async () => {
  const payments = createPayments(dual, Store.memory()); const payload = await signedPayment(payments)
  const original = globalThis.fetch; const calls: string[] = []
  globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ isValid: false, invalidReason: 'insufficient_funds' }) }
  try { assert.equal((await payments.validate(request(Header.encodePaymentSignature(payload as any))))?.status, 402); assert.deepEqual(calls, ['https://facilitator.example/verify']) }
  finally { globalThis.fetch = original }
})
test('equivalent Tempo signature encodings use canonical transaction identity', async () => {
  const Tx = await import('ox/tempo/TxEnvelopeTempo')
  const Envelope = await import('ox/tempo/SignatureEnvelope')
  const Secp = await import('ox/Secp256k1')
  const Rlp = await import('ox/Rlp'); const Hex = await import('ox/Hex')
  const { keccak256 } = await import('viem')
  const tx = Tx.from({ chainId: 42431, nonce: 0n, gas: 100000n, maxFeePerGas: 1000000000n, calls: [{ to: config.MPP_CURRENCY as `0x${string}`, data: '0x', value: 0n }] })
  const signature = Secp.sign({ payload: Tx.getSignPayload(tx), privateKey: `0x${'11'.repeat(32)}` })
  const canonical = Tx.serialize(Tx.from(tx, { signature }))
  const fields = Rlp.toHex(Hex.slice(canonical, 1)) as any[]
  fields[fields.length - 1] = Envelope.serialize(Envelope.from(signature), { magic: true })
  const alternate = Hex.concat('0x76', Rlp.fromHex(fields))
  assert.notEqual(alternate, canonical)
  const challenge = Challenge.from({ secretKey: config.MPP_SECRET_KEY, realm: 'api.example.com', method: 'tempo', intent: 'charge', request: { amount: '20000', currency: config.MPP_CURRENCY, recipient: config.MPP_RECIPIENT, methodDetails: { chainId: 42431 } }, expires: new Date(Date.now() + 60000) })
  const req = (serialized: string) => new Request(`https://api.example.com${PATH}`, { method: 'POST', headers: { authorization: Credential.serialize({ challenge, payload: { type: 'transaction', signature: serialized } }) } })
  const payments = createPayments(config, Store.memory())
  const a = await payments.inspect(req(canonical)); const b = await payments.inspect(req(alternate))
  assert.equal(a.key, b.key); assert.equal(a.payment?.transaction_hash, keccak256(canonical)); assert.equal(b.payment?.transaction_hash, a.payment?.transaction_hash)
})
