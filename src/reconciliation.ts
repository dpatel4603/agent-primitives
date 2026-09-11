import { createPublicClient, http, parseEventLogs } from 'viem'
import { base, baseSepolia, tempo, tempoModerato } from 'viem/chains'
import { Header } from 'mppx/x402'
import { Receipt } from 'mppx'
import { ApiError } from './fedspend.ts'
import type { Entry, PaymentMetadata } from './gateway.ts'
const events = [
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'AuthorizationUsed', inputs: [{ name: 'authorizer', type: 'address', indexed: true }, { name: 'nonce', type: 'bytes32', indexed: true }] },
] as const
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function verifyEvidence(payment: PaymentMetadata, receipt: { status: string; transactionHash: string; logs: readonly any[] }) {
  if (receipt.status !== 'success') throw new ApiError(409, 'Transaction did not succeed')
  if (payment.protocol === 'mpp' && (!payment.transaction_hash || !same(payment.transaction_hash, receipt.transactionHash))) throw new ApiError(409, 'Transaction is not the original validated MPP payment')
  const logs = parseEventLogs({ abi: events, logs: receipt.logs as any, strict: false }).filter(log => same(log.address, payment.asset))
  if (!logs.some(log => log.eventName === 'Transfer' && log.args.to && same(log.args.to, payment.recipient) && log.args.value === BigInt(payment.amount) && (!payment.payer || (log.args.from && same(log.args.from, payment.payer))))) throw new ApiError(409, 'Matching token transfer not found')
  if (payment.protocol === 'x402' && !logs.some(log => log.eventName === 'AuthorizationUsed' && log.args.authorizer && log.args.nonce && payment.payer && payment.nonce && same(log.args.authorizer, payment.payer) && same(log.args.nonce, payment.nonce))) throw new ApiError(409, 'Matching x402 authorization nonce not found')
}
export async function confirmPayment(payment: PaymentMetadata, transactionHash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new ApiError(400, 'Provide a transaction hash')
  const chain = [base, baseSepolia, tempo, tempoModerato].find(c => `eip155:${c.id}` === payment.network)
  if (!chain) throw new ApiError(409, 'Unsupported reconciliation network')
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 10000, retryCount: 1 }) })
  const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` })
  if (await client.getBlockNumber() < receipt.blockNumber + 2n) throw new ApiError(409, 'Wait for at least three block confirmations')
  verifyEvidence(payment, receipt)
}
export function completedEntry(key: string, entry: Entry, reference: string): Entry {
  if (entry.state !== 'settling' || !entry.prepared || !entry.payment) throw new ApiError(409, 'Only a prepared, uncertain payment can be reconciled')
  const payment = entry.payment
  const headers: [string, string][] = [
    ['content-type', 'application/json'], ['cache-control', 'no-store'], ['x-request-id', key],
    ['payment-receipt', Receipt.serialize({ method: payment.protocol === 'mpp' ? 'tempo' : 'evm', reference, status: 'success', timestamp: new Date().toISOString() })],
  ]
  if (payment.protocol === 'x402') headers.push(['payment-response', Header.encodePaymentResponse({ network: payment.network, payer: payment.payer!, success: true, transaction: reference })])
  const { prepared, ...other } = entry
  return { ...other, state: 'complete', response: { body: prepared, status: 200, headers } }
}
