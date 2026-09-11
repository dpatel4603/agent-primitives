import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeEventTopics, encodeAbiParameters } from 'viem'
import { verifyEvidence, completedEntry } from '../src/reconciliation.ts'
import type { PaymentMetadata, Entry } from '../src/gateway.ts'
const payer = `0x${'11'.repeat(20)}`; const recipient = `0x${'22'.repeat(20)}`; const asset = `0x${'33'.repeat(20)}`; const hash = `0x${'44'.repeat(32)}`; const nonce = `0x${'55'.repeat(32)}`
const payment: PaymentMetadata = { protocol: 'x402', network: 'eip155:8453', asset, payer, recipient, amount: '20000', nonce }
const transfer = { address: asset, topics: encodeEventTopics({ abi: [{ type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] }], eventName: 'Transfer', args: { from: payer, to: recipient } }), data: encodeAbiParameters([{ type: 'uint256' }], [20000n]) }
const used = { address: asset, topics: encodeEventTopics({ abi: [{ type: 'event', name: 'AuthorizationUsed', inputs: [{ name: 'authorizer', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true }] }], eventName: 'AuthorizationUsed', args: { authorizer: payer, nonce } }), data: '0x' }
const receipt = { status: 'success', transactionHash: hash, logs: [transfer, used] }
test('reconciliation accepts original token transfer plus exact x402 nonce', () => assert.doesNotThrow(() => verifyEvidence(payment, receipt)))
for (const change of [{ amount: '30000' }, { recipient: payer }, { asset: payer }, { payer: recipient }, { nonce: hash }]) test(`reconciliation rejects mismatch ${JSON.stringify(change)}`, () => assert.throws(() => verifyEvidence({ ...payment, ...change }, receipt)))
test('a successful transfer without authorization nonce cannot recover x402', () => assert.throws(() => verifyEvidence(payment, { ...receipt, logs: [transfer] })))
test('MPP recovery requires the prevalidated transaction hash', () => {
  assert.doesNotThrow(() => verifyEvidence({ ...payment, protocol: 'mpp', transaction_hash: hash }, receipt))
  assert.throws(() => verifyEvidence({ ...payment, protocol: 'mpp', transaction_hash: nonce }, receipt))
})
test('recovered response preserves prepared result and includes protocol receipt', () => {
  const entry: Entry = { fingerprint: 'fingerprint', proof: 'proof', owner: 'owner', lease_until: 0, state: 'settling', created_at: new Date().toISOString(), payment, prepared: '{"awards":[]}' }
  const complete = completedEntry('key', entry, hash)
  assert.equal(complete.state, 'complete'); assert.equal(complete.prepared, undefined); assert.equal(complete.response?.body, entry.prepared)
  assert.ok(complete.response?.headers.some(([k]) => k === 'payment-response'))
})
