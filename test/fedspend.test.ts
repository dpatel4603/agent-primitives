import test from 'node:test'
import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { ApiError, Fedspend, parseQuery } from '../src/fedspend.ts'
import { outputSchema, openapi } from '../src/openapi.ts'
import { query, row, config } from './helpers.ts'
const reject = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status
for (const body of [null, [], 1, { ...query, recipient: 1 }, { ...query, limit: '10' }, { ...query, page: 0 }, { ...query, limit: 1.2 }, { ...query, award_types: '__proto__' }, { ...query, award_types: 'all' }, { ...query, start_date: '2026-02-30' }, { ...query, start_date: '2006-01-01' }, { ...query, extra: true }, { ...query, recipient_uei: 'BAD' }]) {
  test(`reject invalid input ${JSON.stringify(body)}`, () => assert.throws(() => parseQuery(body), reject(400)))
}
test('date defaults and explicit pagination', () => { assert.equal(parseQuery({ recipient: 'Palantir' }, new Date('2026-09-11')).start_date, '2023-09-11'); assert.equal(parseQuery({ ...query, page: 3 }).page, 3) })
test('UEI query pins upstream identity, returns source links and validated schema', async () => {
  let sent: any
  const client = new Fedspend(async (_url, init) => { sent = JSON.parse(init!.body as string); return Response.json({ results: [row], page_metadata: { hasNext: true, page: 2 }, messages: [] }) })
  const result = { ...await client.lookup(parseQuery({ ...query, page: 2 })), request_id: 'request' }
  assert.deepEqual(sent.filters.recipient_search_text, [query.recipient_uei]); assert.equal(sent.page, 2)
  assert.equal(result.next_page, 3); assert.equal(result.returned_award_amount_sum, 100)
  assert.equal(result.awards[0].source_url, 'https://www.usaspending.gov/award/CONT_AWD_123')
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv)
  const validate = ajv.compile(outputSchema)
  assert.equal(validate(result), true, JSON.stringify(validate.errors))
})
test('brand names do not silently select the first autocomplete result', async () => {
  let calls = 0
  const client = new Fedspend(async () => { calls++; return Response.json({ results: [{ recipient_name: 'PALANTIR USG INC', uei: null }] }) })
  await assert.rejects(client.lookup(parseQuery({ recipient: 'Palantir' })), reject(409)); assert.equal(calls, 1)
})
test('exact name without UEI requires explicit identity confirmation before paying', async () => {
  const client = new Fedspend(async url => String(url).includes('autocomplete') ? Response.json({ results: [{ recipient_name: query.recipient, uei: null }] }) : Response.json({ results: [row], page_metadata: { hasNext: false, page: 1 } }))
  await assert.rejects(client.lookup(parseQuery({ recipient: query.recipient })), e => reject(409)(e) && (e as ApiError).details.recipient_ueis[0] === query.recipient_uei)
})
for (const rows of [[{ ...row, 'Recipient UEI': 'OTHER1234567' }], [{ ...row, 'Award Amount': null }], [row, row]]) {
  test(`reject corrupt/ambiguous awards ${JSON.stringify(rows)}`, async () => {
    const client = new Fedspend(async () => Response.json({ results: rows, page_metadata: { hasNext: false, page: 1 } }))
    await assert.rejects(client.lookup(parseQuery(query)), e => e instanceof ApiError)
  })
}
test('transient upstream error is retried once; persistent failure is not converted to empty data', async () => {
  let calls = 0
  const client = new Fedspend(async () => { calls++; return new Response('unavailable', { status: 503 }) })
  await assert.rejects(client.lookup(parseQuery(query)), reject(502)); assert.equal(calls, 2)
})
test('discovery uses scanner pricing/protocol shape and explicit schemas', () => {
  const spec = openapi(config); const operation = spec.paths['/v1/fedspend/company'].post
  assert.equal(operation['x-payment-info'].price.mode, 'fixed')
  assert.ok(Array.isArray(operation['x-payment-info'].protocols))
  assert.ok(operation.requestBody.content['application/json'].schema)
  assert.ok(operation.responses['200'].content['application/json'].schema)
  assert.equal(operation['x-payment-info'].protocols.length, 1)
})
for (const data of [
  { results: [{ ...row, 'Recipient Name': null }], page_metadata: { page: 1, hasNext: false } },
  { results: [row], page_metadata: { page: 2, hasNext: false } },
  { results: [row], page_metadata: { page: 1, hasNext: false }, messages: [{}] },
]) test('source drift is rejected before delivering an invalid response', async () => {
  await assert.rejects(new Fedspend(async () => Response.json(data)).lookup(parseQuery(query)), reject(502))
})
