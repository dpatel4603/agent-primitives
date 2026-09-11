import { Mppx, tempo, evm } from 'mppx/server'
import type { Store } from 'mppx/server'
import { assets, Header, Types } from 'mppx/x402'
import { Credential } from 'mppx'
import { keccak256 } from 'viem'
import { Transaction } from 'viem/tempo'
import { inputSchema, outputSchema } from './schema.ts'
import { ApiError } from './fedspend.ts'
import { canonicalize, sha256 } from './gateway.ts'
import type { Payments, PaymentResult } from './gateway.ts'
export type Config = {
  PUBLIC_BASE_URL: string; MPP_SECRET_KEY: string; MPP_RECIPIENT: string; MPP_CURRENCY: string; TEMPO_TESTNET: string;
  X402_ENABLED?: string; X402_RECIPIENT?: string; X402_NETWORK?: string; X402_FACILITATOR_URL?: string; UPSTREAM_USER_AGENT?: string;
}
export const PRICE = '0.02'
export const PATH = '/v1/fedspend/company'
export function x402Asset(config: Config) {
  if (config.X402_NETWORK === 'base') return assets.base.USDC
  if (config.X402_NETWORK === 'base-sepolia') return assets.baseSepolia.USDC
  throw new Error('X402_NETWORK must be base or base-sepolia')
}
export function validateConfig(config: Config) {
  const origin = new URL(config.PUBLIC_BASE_URL)
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_BASE_URL must be an origin without a path or credentials')
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') throw new Error('Public origin requires HTTPS')
  if (config.MPP_SECRET_KEY.length < 32) throw new Error('MPP_SECRET_KEY must contain at least 32 characters')
  for (const value of [config.MPP_RECIPIENT, config.MPP_CURRENCY]) if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw new Error('Configure valid nonzero MPP addresses')
  if (!['true', 'false'].includes(config.TEMPO_TESTNET)) throw new Error('TEMPO_TESTNET must be true or false')
  if (config.X402_ENABLED === 'true') {
    x402Asset(config)
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.X402_RECIPIENT ?? '') || /^0x0{40}$/.test(config.X402_RECIPIENT!)) throw new Error('Configure X402_RECIPIENT')
    if (!config.X402_FACILITATOR_URL || new URL(config.X402_FACILITATOR_URL).protocol !== 'https:') throw new Error('Configure an HTTPS X402_FACILITATOR_URL')
  }
}
export function createPayments(config: Config, store: Store.AtomicStore): Payments {
  validateConfig(config)
  const common = { realm: new URL(config.PUBLIC_BASE_URL).host, secretKey: config.MPP_SECRET_KEY }
  const options = { amount: PRICE, description: 'One page of verified federal award records', scope: `POST ${PATH}` }
  const nativeServer = Mppx.create({ ...common, methods: [tempo.charge({ currency: config.MPP_CURRENCY as `0x${string}`, recipient: config.MPP_RECIPIENT as `0x${string}`, testnet: config.TEMPO_TESTNET === 'true', store })] })
  const native = nativeServer.charge(options)
  const x402 = config.X402_ENABLED === 'true' ? Mppx.create({ ...common, methods: [evm.charge({
    currency: x402Asset(config), recipient: config.X402_RECIPIENT as `0x${string}`,
    x402: { facilitator: config.X402_FACILITATOR_URL, fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) },
  })] }).charge(options) : undefined
  // A separate EVM instance replaces settlement with a local no-op. The SDK
  // still validates signatures, route binding, amount, recipient and expiry.
  // Its synthetic receipt NEVER reaches the gateway or a client.
  const x402Validator = config.X402_ENABLED === 'true' ? Mppx.create({ ...common, methods: [evm.charge({
    currency: x402Asset(config), recipient: config.X402_RECIPIENT as `0x${string}`,
    x402: {}, settle: async () => ({ reference: 'validation-only-never-a-payment' }),
  })] }).charge(options) : undefined
  const rawPay = async (request: Request): Promise<PaymentResult> => {
    if (request.headers.has('payment-signature')) {
      if (!x402) throw new Error('x402 is not configured')
      return x402(request)
    }
    if (request.headers.has('authorization') || !x402) return native(request)
    const [mppChallenge, x402Challenge] = await Promise.all([native(request.clone()), x402(request.clone())])
    if (mppChallenge.status !== 402 || x402Challenge.status !== 402) throw new Error('Unexpected unpaid payment result')
    const headers = new Headers(mppChallenge.challenge.headers)
    const required = x402Challenge.challenge.headers.get('payment-required')
    if (required) headers.set('Payment-Required', required)
    return { status: 402, challenge: new Response(mppChallenge.challenge.body, { status: 402, headers }) }
  }
  const pay = async (request: Request): Promise<PaymentResult> => {
    const result = await rawPay(request)
    if (result.status !== 402) return result
    const encoded = result.challenge.headers.get('payment-required')
    if (!encoded) return result
    const required = Header.decodePaymentRequired(encoded)
    required.extensions = { ...required.extensions, bazaar: {
      info: { input: { type: 'http', method: 'POST', bodyType: 'json', body: { recipient: 'PALANTIR USG INC', recipient_uei: 'HNN4F9JZWDY8', award_types: 'contracts', limit: 10, page: 1 } }, output: { type: 'json', example: {
        request_id: 'example-only', query: { recipient: 'PALANTIR USG INC', recipient_uei: 'HNN4F9JZWDY8', award_types: 'contracts', limit: 10, page: 1, start_date: '2024-01-01', end_date: '2026-09-11' },
        resolved_recipient: 'PALANTIR USG INC', resolution: { method: 'uei', recipient_uei: 'HNN4F9JZWDY8', scope: 'Confirmed UEI only' },
        candidate_recipients: [], returned_award_count: 0, returned_award_amount_sum: 0, page: 1, has_more: false, next_page: null, awards: [],
        provenance: { source: 'USAspending.gov', source_url: 'https://api.usaspending.gov/docs/endpoints', retrieved_at: '2026-09-11T00:00:00Z', note: 'Illustrative empty-response example, not a live query result.', messages: [] },
      } } },
      schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { input: { type: 'object', properties: { type: { type: 'string', const: 'http' }, method: { type: 'string', enum: ['POST'] }, bodyType: { type: 'string', enum: ['json'] }, body: inputSchema }, required: ['type', 'method', 'bodyType', 'body'], additionalProperties: false }, output: { type: 'object', properties: { type: { type: 'string' }, example: outputSchema }, required: ['type'] } }, required: ['input'] },
    } }
    const headers = new Headers(result.challenge.headers)
    headers.set('payment-required', Header.encodePaymentRequired(required))
    return { status: 402, challenge: new Response(result.challenge.body, { status: 402, headers }) }
  }
  return {
    pay,
    async inspect(request) {
      try {
        const x = request.headers.get('payment-signature')
        if (x) {
          if (!x402) throw new Error('x402 is disabled')
          const p = Header.decodePaymentSignature(x)
          const payload = p.payload as { authorization: { from: string; nonce: string; to: string; value: string }; signature: string }
          const auth = payload.authorization
          return {
            key: await sha256(`x402:${p.accepted.network}:${p.accepted.asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`),
            proof: await sha256(JSON.stringify(canonicalize(payload))),
            payment: { protocol: 'x402', network: p.accepted.network, asset: p.accepted.asset, payer: auth.from, recipient: auth.to, amount: auth.value, nonce: auth.nonce },
          }
        }
        const credential = Credential.deserialize(request.headers.get('authorization') ?? '')
        if (credential.challenge.method !== 'tempo' || credential.challenge.intent !== 'charge') throw new Error('Unsupported MPP method')
        const proof = await sha256(JSON.stringify(canonicalize(credential)))
        const payload = credential.payload as { type: string; hash?: string; signature?: `0x${string}` }
        const req = credential.challenge.request
        const details = req.methodDetails as { chainId?: number } | undefined
        const transaction_hash = payload.type === 'hash' ? payload.hash : payload.type === 'transaction' && payload.signature ? keccak256(await Transaction.serialize(Transaction.deserialize(payload.signature))) : undefined
        if (!transaction_hash) throw new Error('Only transaction and hash proofs are supported for paid charges')
        const network = `eip155:${details?.chainId ?? (config.TEMPO_TESTNET === 'true' ? 42431 : 4217)}`
        return { key: await sha256(`mpp:${network}:${transaction_hash.toLowerCase()}`), proof,
          payment: { protocol: 'mpp', network, asset: String(req.currency), recipient: String(req.recipient), amount: String(req.amount), transaction_hash },
        }
      } catch { throw new ApiError(400, 'Malformed or unsupported payment credential') }
    },
    async validate(request) {
      if (request.headers.has('payment-signature')) {
        if (!x402Validator) throw new ApiError(400, 'x402 is not configured')
        const result = await x402Validator(request.clone())
        if (result.status === 402) return result.challenge
        const payload = Header.decodePaymentSignature(request.headers.get('payment-signature')!)
        const response = await fetch(`${config.X402_FACILITATOR_URL!.replace(/\/$/, '')}/verify`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ paymentPayload: payload, paymentRequirements: payload.accepted, x402Version: 2 }),
        })
        if (!response.ok) throw new ApiError(503, 'Payment verification service unavailable; no payment submitted')
        const verification = Types.VerifyResponseSchema.parse(await response.json())
        if (verification.isValid) return null
        const headers = new Headers(request.headers); headers.delete('payment-signature')
        const challenge = await pay(new Request(request.url, { method: request.method, headers, body: await request.text() }))
        return challenge.status === 402 ? challenge.challenge : Response.json({ error: 'Payment not valid' }, { status: 402 })
      }
      try {
        await nativeServer.validateCredential(request.headers.get('authorization')!, {
          scope: options.scope, request: { amount: PRICE },
          capturedRequest: { url: new URL(request.url), method: request.method, headers: request.headers, hasBody: true },
        })
        return null
      } catch {
        const headers = new Headers(request.headers); headers.delete('authorization')
        const result = await native(new Request(request.url, { method: request.method, headers, body: await request.text() }))
        return result.status === 402 ? result.challenge : Response.json({ error: 'Invalid payment credential' }, { status: 402 })
      }
    },
  }
}

