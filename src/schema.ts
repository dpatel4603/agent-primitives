export const text = { type: 'string' }
const nullableText = { type: ['string', 'null'] }
export const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required })
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
export const errorSchema = object({ error: text, request_id: text, retryable: { type: 'boolean' }, candidate_recipients: { type: 'array', items: candidate }, recipient_ueis: { type: 'array', items: text }, state: text }, ['error'])
export const jsonResponse = (description: string, schema: unknown) => ({ description, content: { 'application/json': { schema } } })
