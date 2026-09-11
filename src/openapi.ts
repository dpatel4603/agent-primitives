import { PATH, PRICE, x402Asset } from './payments.ts'
import type { Config } from './payments.ts'
const text = { type: 'string' }
const nullableText = { type: ['string', 'null'] }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
export const inputSchema = {
  ...object({
    recipient: { type: 'string', minLength: 2, maxLength: 200, description: 'Exact legal name. Ambiguous brand names are rejected; use recipient_uei for precise lookup.' },
    recipient_uei: { type: 'string', pattern: '^[A-Z0-9]{12}$' },
    start_date: { type: 'string', format: 'date', description: 'On or after 2007-10-01; defaults to three years before today' },
    end_date: { type: 'string', format: 'date', description: 'Defaults to today' },
    award_types: { type: 'string', enum: ['contracts', 'grants'], default: 'contracts', description: 'Choose contracts or grants; USAspending prohibits mixing groups' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
  }, ['recipient']), additionalProperties: false,
}
const candidate = object({ recipient_name: nullableText, uei: nullableText, duns: nullableText }, ['recipient_name', 'uei'])
const award = object({
  'Award ID': nullableText, 'Recipient Name': text, 'Recipient UEI': nullableText, 'Award Amount': { type: 'number' },
  'Start Date': nullableText, 'End Date': nullableText, 'Awarding Agency': nullableText, 'Awarding Sub Agency': nullableText,
  'Award Type': nullableText, Description: nullableText, generated_internal_id: text,
  source_url: { type: 'string', format: 'uri' }, retrieved_at: { type: 'string', format: 'date-time' },
}, ['Recipient Name', 'Award Amount', 'generated_internal_id', 'source_url', 'retrieved_at'])
export const outputSchema = object({
  request_id: text, query: inputSchema, resolved_recipient: text,
  resolution: object({ method: { type: 'string', enum: ['uei', 'exact_legal_name'] }, recipient_uei: nullableText, scope: text }),
  candidate_recipients: { type: 'array', items: candidate }, returned_award_count: { type: 'integer', minimum: 0 },
  returned_award_amount_sum: { type: 'number', description: 'Only this page of award amounts; not revenue or period spending' },
  page: { type: 'integer' }, has_more: { type: 'boolean' }, next_page: { type: ['integer', 'null'] },
  awards: { type: 'array', items: award },
  provenance: object({ source: text, source_url: { type: 'string', format: 'uri' }, retrieved_at: { type: 'string', format: 'date-time' }, note: text, messages: { type: 'array', items: text } }),
})
const errorSchema = object({ error: text, request_id: text, retryable: { type: 'boolean' }, candidate_recipients: { type: 'array', items: candidate }, recipient_ueis: { type: 'array', items: text }, state: text }, ['error'])
const jsonResponse = (description: string, schema: unknown) => ({ description, content: { 'application/json': { schema } } })
export function openapi(config: Config) {
  const origin = config.PUBLIC_BASE_URL.replace(/\/$/, '')
  const protocols: Record<string, unknown>[] = [{ mpp: { method: 'tempo', intent: 'charge', currency: config.MPP_CURRENCY } }]
  const offers: Record<string, unknown>[] = [{ method: 'tempo', intent: 'charge', amount: '20000', currency: config.MPP_CURRENCY }]
  if (config.X402_ENABLED === 'true') {
    const asset = x402Asset(config)
    protocols.push({ x402: { scheme: 'exact', network: asset.network, asset: asset.address, payTo: config.X402_RECIPIENT } })
  }
  return {
    openapi: '3.1.0', info: { title: 'Agent Primitives', version: '0.2.0', 'x-guidance': 'Use a confirmed recipient_uei for paid results. Name-only requests return a 409 with observed UEIs to confirm; no payment is submitted. Each page costs $0.02. Repeat the identical request and payment credential after a lost response to retrieve its saved result. Do not submit a new payment on a reconciliation error. Totals cover only the returned page. Recorded end dates are not predictions of recompetes.' },
    servers: [{ url: origin }],
    'x-service-info': { categories: ['data', 'research', 'government'], docs: { homepage: origin, apiReference: `${origin}/openapi.json`, llms: `${origin}/llms.txt` } },
    paths: {
      [PATH]: { post: { operationId: 'companyFederalAwards', summary: 'Look up one page of a company’s US federal awards',
        requestBody: { required: true, content: { 'application/json': { schema: inputSchema, example: { recipient: 'PALANTIR USG INC', recipient_uei: 'HNN4F9JZWDY8', award_types: 'contracts', limit: 10, page: 1 } } } },
        'x-payment-info': { price: { mode: 'fixed', amount: PRICE, currency: 'USD' }, protocols, offers },
        responses: {
          '200': jsonResponse('Prepared award records with payment receipt', outputSchema),
          '402': { description: 'Payment required; unpaid probes do not query USAspending', headers: { 'WWW-Authenticate': { schema: text }, ...(config.X402_ENABLED === 'true' ? { 'Payment-Required': { schema: text } } : {}) } },
          ...Object.fromEntries([[400, 'Invalid request'], [409, 'Ambiguous entity, conflicting retry, processing or reconciliation required'], [413, 'Request too large'], [429, 'Rate limited'], [502, 'Upstream unavailable or incompatible'], [503, 'Request preparation or payment reconciliation failure']].map(([code, description]) => [code, jsonResponse(String(description), errorSchema)])),
        },
      } },
      '/health': { get: { security: [], responses: { '200': jsonResponse('Process health only; does not establish upstream or payment availability', object({ ok: { type: 'boolean' } })) } } },
      '/sample': { get: { security: [], responses: { '200': jsonResponse('Example request', { type: 'object' }) } } },
      '/llms.txt': { get: { security: [], responses: { '200': { description: 'Agent usage instructions', content: { 'text/plain': { schema: text } } } } } },
    },
  }
}
