import { Hono } from 'hono'
import { openapi } from './openapi.ts'
import { PATH } from './payments.ts'
import type { Config } from './payments.ts'
export { PaymentState } from './state.ts'
type Bindings = Config & { PAYMENT_STATE: DurableObjectNamespace }
const app = new Hono<{ Bindings: Bindings }>()
app.get('/', c => c.json({ name: 'Agent Primitives', version: '0.2.0', price: '$0.02 per page', discovery: `${c.env.PUBLIC_BASE_URL}/openapi.json`, instructions: `${c.env.PUBLIC_BASE_URL}/llms.txt` }))
app.get('/health', c => c.json({ ok: true }))
app.get('/sample', c => c.json({ method: 'POST', path: PATH, body: { recipient: 'PALANTIR USG INC', recipient_uei: 'HNN4F9JZWDY8', award_types: 'contracts', limit: 10, page: 1 } }))
app.get('/openapi.json', c => c.json(openapi(c.env)))
app.get('/llms.txt', c => c.text(`# Agent Primitives\n\nPOST ${c.env.PUBLIC_BASE_URL}${PATH}\nContent-Type: application/json\nBody: {"recipient":"PALANTIR USG INC","recipient_uei":"HNN4F9JZWDY8","award_types":"contracts","limit":10,"page":1}\n\nPrice: $0.02 per page through MPP on Tempo${c.env.X402_ENABLED === 'true' ? ' or x402 USDC on ' + c.env.X402_NETWORK : ''}.\nUse a confirmed recipient_uei. Name-only requests return 409 with candidates to confirm, before payment submission. No corporate parent/subsidiary expansion is implied.\nUse next_page to paginate. Each page is live and costs separately. Amounts are page-only award amounts, not total revenue or spending during the search dates.\nFor lost responses retry the same JSON and exact payment credential; completed results are returned without settling again.\n409/503 reconciliation errors require operator review: do not create another payment.\nRecorded end dates are not predictions of future recompetes.\n`))
app.post(PATH, c => {
  const id = c.env.PAYMENT_STATE.idFromName('federal-awards-v1')
  return c.env.PAYMENT_STATE.get(id).fetch(c.req.raw)
})
app.onError((error, c) => { console.error(JSON.stringify({ event: 'request.error', name: error.name })); return c.json({ error: 'Service configuration or storage unavailable' }, 503) })
export default app
