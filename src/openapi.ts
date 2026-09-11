import { PATH, PRICE, x402Asset } from './payments.ts'
import type { Config } from './payments.ts'
import { inputSchema, outputSchema, errorSchema, text, object, jsonResponse } from './schema.ts'
export { inputSchema, outputSchema } from './schema.ts'
export function openapi(config: Config) {
  const origin = config.PUBLIC_BASE_URL.replace(/\/$/, '')
  const protocols: Record<string, unknown>[] = [{ mpp: { method: 'tempo', intent: 'charge', currency: config.MPP_CURRENCY } }]
  const offers: Record<string, unknown>[] = [{ method: 'tempo', intent: 'charge', amount: '20000', currency: config.MPP_CURRENCY }]
  if (config.X402_ENABLED === 'true') {
    const asset = x402Asset(config)
    protocols.push({ x402: { scheme: 'exact', network: asset.network, asset: asset.address, payTo: config.X402_RECIPIENT } })
  }
  return {
    openapi: '3.1.0', info: { title: 'Agent Primitives', version: '0.2.0', contact: { url: 'https://github.com/dpatel4603/agent-primitives/issues' }, 'x-guidance': 'Use a confirmed recipient_uei for paid results. Name-only requests return a 409 with observed UEIs to confirm; no payment is submitted. Each page costs $0.02. Repeat the identical request and payment credential after a lost response to retrieve its saved result. Do not submit a new payment on a reconciliation error. Totals cover only the returned page. Recorded end dates are not predictions of recompetes.' },
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
