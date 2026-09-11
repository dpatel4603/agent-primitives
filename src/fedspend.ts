export class ApiError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message) }
}
export type Query = { recipient: string; recipient_uei?: string; start_date: string; end_date: string; award_types: 'contracts' | 'grants'; limit: number; page: number }
export const awardCodes = {
  contracts: ['A', 'B', 'C', 'D'], grants: ['02', '03', '04', '05'],
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export function parseQuery(body: unknown, now = new Date()): Query {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Request must be a JSON object')
  const b = body as Record<string, unknown>
  const allowed = ['recipient', 'recipient_uei', 'start_date', 'end_date', 'award_types', 'limit', 'page']
  if (Object.keys(b).some(k => !allowed.includes(k))) throw new ApiError(400, 'Unknown request field')
  if (typeof b.recipient !== 'string' || b.recipient.trim().length < 2 || b.recipient.trim().length > 200) throw new ApiError(400, 'recipient must be a string between 2 and 200 characters')
  if (b.recipient_uei !== undefined && (typeof b.recipient_uei !== 'string' || !/^[A-Z0-9]{12}$/.test(b.recipient_uei))) throw new ApiError(400, 'recipient_uei must be a 12-character uppercase UEI')
  const start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - 3)
  const start_date = b.start_date ?? start.toISOString().slice(0, 10)
  const end_date = b.end_date ?? now.toISOString().slice(0, 10)
  if (!validDate(start_date) || !validDate(end_date) || start_date > end_date || start_date < '2007-10-01') throw new ApiError(400, 'Use real YYYY-MM-DD dates, start <= end, starting on or after 2007-10-01')
  const award_types = b.award_types ?? 'contracts'
  if (typeof award_types !== 'string' || !Object.hasOwn(awardCodes, award_types)) throw new ApiError(400, 'award_types must be contracts or grants; mixed award groups are not supported by USAspending')
  const limit = b.limit ?? 10; const page = b.page ?? 1
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be an integer from 1 to 100')
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10000) throw new ApiError(400, 'page must be an integer from 1 to 10000')
  return { recipient: b.recipient.trim(), ...(b.recipient_uei ? { recipient_uei: b.recipient_uei as string } : {}), start_date, end_date, award_types: award_types as Query['award_types'], limit, page }
}
export type Candidate = { recipient_name: string | null; uei: string | null; duns?: string | null }
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export class Fedspend {
  constructor(private fetcher: typeof fetch = fetch, private userAgent = 'Agent-Primitives/0.2') {}
  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher.call(globalThis, `https://api.usaspending.gov/api/v2/${path}/`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': this.userAgent },
          body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
        })
        if (!response.ok) {
          if (attempt === 0 && response.status >= 500) { await response.body?.cancel(); continue }
          throw new ApiError(502, 'USAspending request failed', { upstream_status: response.status, retryable: true })
        }
        const data: unknown = await response.json()
        if (!record(data)) throw new ApiError(502, 'USAspending returned an unexpected schema', { retryable: true })
        return data
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (attempt === 1) throw new ApiError(502, 'USAspending unavailable or timed out', { retryable: true })
      }
    }
    throw new ApiError(502, 'USAspending unavailable', { retryable: true })
  }
  async lookup(query: Query) {
    let candidates: Candidate[] = []
    let resolved = query.recipient
    if (!query.recipient_uei) {
      const data = await this.post('autocomplete/recipient', { search_text: query.recipient, limit: 10 })
      if (!Array.isArray(data.results) || !data.results.every(x => record(x) && (typeof x.recipient_name === 'string' || x.recipient_name === null) && (typeof x.uei === 'string' || x.uei === null))) throw new ApiError(502, 'Recipient source schema changed', { retryable: true })
      candidates = data.results as Candidate[]
      const exact = candidates.filter(c => c.recipient_name && normalize(c.recipient_name) === normalize(query.recipient))
      if (exact.length !== 1) throw new ApiError(409, 'Recipient is ambiguous or no exact legal name matched; provide an exact legal name or recipient_uei', { candidate_recipients: candidates })
      resolved = exact[0].recipient_name!
    }
    const data = await this.post('search/spending_by_award', {
      filters: { recipient_search_text: [query.recipient_uei ?? resolved], award_type_codes: awardCodes[query.award_types], time_period: [{ start_date: query.start_date, end_date: query.end_date }] },
      fields: ['Award ID', 'Recipient Name', 'Recipient UEI', 'Award Amount', 'Start Date', 'End Date', 'Awarding Agency', 'Awarding Sub Agency', 'Award Type', 'Description'],
      sort: 'Award Amount', order: 'desc', page: query.page, limit: query.limit,
    })
    if (!Array.isArray(data.results) || !data.results.every(record) || !record(data.page_metadata) || typeof data.page_metadata.hasNext !== 'boolean' || data.page_metadata.page !== query.page) throw new ApiError(502, 'Award source schema changed', { retryable: true })
    const rows = data.results as Record<string, unknown>[]
    if (rows.length > query.limit || rows.some(r => typeof r['Award Amount'] !== 'number' || !Number.isFinite(r['Award Amount']))) throw new ApiError(502, 'Award source has invalid amounts or page size', { retryable: true })
    const amountCents = rows.map(r => Math.round((r['Award Amount'] as number) * 100))
    let totalCents = 0
    for (const cents of amountCents) {
      totalCents += cents
      if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(totalCents)) throw new ApiError(502, 'Award amounts exceed supported precision', { retryable: true })
    }
    const stringFields = ['Award ID', 'Recipient Name', 'Recipient UEI', 'Start Date', 'End Date', 'Awarding Agency', 'Awarding Sub Agency', 'Award Type', 'Description']
    if (rows.some(r => typeof r['Recipient Name'] !== 'string' || stringFields.some(k => r[k] !== undefined && r[k] !== null && typeof r[k] !== 'string')) || (data.messages !== undefined && (!Array.isArray(data.messages) || !data.messages.every(m => typeof m === 'string')))) throw new ApiError(502, 'Award source fields changed', { retryable: true })
    const identifiers = new Set(rows.map(r => r['Recipient UEI']).filter(x => typeof x === 'string' && x.length > 0))
    if (query.recipient_uei ? rows.some(r => r['Recipient UEI'] !== query.recipient_uei) : identifiers.size > 1 || rows.some(r => typeof r['Recipient Name'] !== 'string' || normalize(r['Recipient Name']) !== normalize(resolved))) throw new ApiError(409, 'Award results do not identify a single matching recipient; specify recipient_uei', { recipient_ueis: [...identifiers] })
    const ids = rows.map(r => r.generated_internal_id)
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new ApiError(502, 'Award source has missing or duplicate identifiers', { retryable: true })
    if (!query.recipient_uei) throw new ApiError(409, 'Confirm the intended recipient_uei and repeat the request; legal names alone do not prove entity identity. No payment submitted.', { candidate_recipients: candidates, recipient_ueis: [...identifiers] })
    const retrieved_at = new Date().toISOString()
    const awards = rows.map(r => ({ ...r, source_url: `https://www.usaspending.gov/award/${encodeURIComponent(r.generated_internal_id as string)}`, retrieved_at }))
    return {
      query, resolved_recipient: rows[0]?.['Recipient Name'] ?? resolved,
      resolution: { method: query.recipient_uei ? 'uei' : 'exact_legal_name', recipient_uei: query.recipient_uei ?? (identifiers.size === 1 ? [...identifiers][0] : null), scope: 'Returned recipient records only; does not include or infer corporate parents or subsidiaries' },
      candidate_recipients: candidates, returned_award_count: awards.length,
      returned_award_amount_sum: totalCents / 100,
      page: query.page, has_more: data.page_metadata.hasNext, next_page: data.page_metadata.hasNext ? query.page + 1 : null,
      awards, provenance: { source: 'USAspending.gov', source_url: 'https://api.usaspending.gov/docs/endpoints', retrieved_at, note: 'Sum covers only returned award amounts, not total revenue or spending incurred within the search dates. Date filters select awards under USAspending semantics. Pages are live and may change between requests.', messages: Array.isArray(data.messages) ? data.messages : [] },
    }
  }
}
