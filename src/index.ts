import { env } from 'cloudflare:workers'
import { Hono } from 'hono'
import { Mppx, discovery, tempo } from 'mppx/hono'

type Bindings = {
  MPP_SECRET_KEY: string
  MPP_RECIPIENT: string
  MPP_CURRENCY: string
  TEMPO_TESTNET: string
  PUBLIC_BASE_URL: string
}

type RequestBody = {
  recipient?: string
  start_date?: string
  end_date?: string
  award_types?: 'contracts' | 'grants' | 'all'
  limit?: number
}

type RecipientMatch = {
  recipient_name: string | null
  recipient_level: string | null
  uei: string | null
  duns: string | null
}

const bindings = env as unknown as Bindings
const app = new Hono()

const mppx = Mppx.create({
  realm: new URL(bindings.PUBLIC_BASE_URL).host,
  methods: [
    tempo.charge({
      currency: bindings.MPP_CURRENCY as `0x${string}`,
      recipient: bindings.MPP_RECIPIENT as `0x${string}`,
      testnet: bindings.TEMPO_TESTNET === 'true',
    }),
  ],
  secretKey: bindings.MPP_SECRET_KEY,
})

const companyLookupPayment = mppx.charge({
  amount: '0.02',
  description: 'Resolve a company and return its largest US federal awards',
})

const awardCodes = {
  contracts: ['A', 'B', 'C', 'D'],
  grants: ['02', '03', '04', '05'],
  all: ['A', 'B', 'C', 'D', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11'],
} as const

function defaultDates() {
  const end = new Date()
  const start = new Date(end)
  start.setUTCFullYear(start.getUTCFullYear() - 3)
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Agent-Primitives/0.1',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`USAspending returned ${response.status}: ${detail.slice(0, 500)}`)
  }

  return (await response.json()) as T
}

async function resolveRecipients(name: string) {
  return postJson<{ count: number; results: RecipientMatch[] }>(
    'https://api.usaspending.gov/api/v2/autocomplete/recipient/',
    { search_text: name, limit: 5 },
  )
}

async function searchAwards(input: Required<RequestBody>) {
  return postJson<{
    spending_level: string
    limit: number
    results: Array<Record<string, unknown>>
    page_metadata: { page: number; hasNext: boolean }
    messages?: string[]
  }>('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
    filters: {
      recipient_search_text: [input.recipient],
      award_type_codes: awardCodes[input.award_types],
      time_period: [{ start_date: input.start_date, end_date: input.end_date }],
    },
    fields: [
      'Award ID',
      'Recipient Name',
      'Recipient UEI',
      'Award Amount',
      'Start Date',
      'End Date',
      'Awarding Agency',
      'Awarding Sub Agency',
      'Award Type',
      'Description',
    ],
    sort: 'Award Amount',
    order: 'desc',
    page: 1,
    limit: input.limit,
  })
}

app.get('/', (c) => c.json({
  name: 'Agent Primitives',
  description: 'Machine-readable, pay-per-call primitives for AI agents',
  price: '$0.02 per company lookup',
  discovery: `${bindings.PUBLIC_BASE_URL}/openapi.json`,
  instructions: `${bindings.PUBLIC_BASE_URL}/llms.txt`,
  source: 'https://www.usaspending.gov/',
}))

app.get('/health', (c) => c.json({ ok: true }))

app.get('/sample', (c) => c.json({
  request: {
    method: 'POST',
    path: '/v1/fedspend/company',
    body: { recipient: 'PALANTIR USG INC', award_types: 'contracts', limit: 5 },
  },
  response_fields: [
    'resolved_recipient',
    'candidate_recipients',
    'returned_award_count',
    'returned_award_amount_sum',
    'has_more',
    'awards',
  ],
}))

app.get('/llms.txt', (c) => c.text(`# Agent Primitives

Machine-readable, pay-per-call primitives for AI agents. The first primitive provides US federal contract and grant data from USAspending.gov.

## Paid endpoint
POST ${bindings.PUBLIC_BASE_URL}/v1/fedspend/company
Price: $0.02 per request via MPP on Tempo.
Content-Type: application/json

Request body:
{
  "recipient": "PALANTIR USG INC",
  "start_date": "2024-01-01",
  "end_date": "2026-12-31",
  "award_types": "contracts",
  "limit": 10
}

Fields other than recipient are optional. award_types accepts contracts, grants, or all.
Inspect the payment challenge without paying:
npx mppx --inspect -X POST -H "content-type: application/json" -d '{"recipient":"PALANTIR USG INC"}' ${bindings.PUBLIC_BASE_URL}/v1/fedspend/company
`))

app.post('/v1/fedspend/company', companyLookupPayment, async (c) => {
  let body: RequestBody
  try {
    body = await c.req.json<RequestBody>()
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  const recipient = body.recipient?.trim()
  if (!recipient || recipient.length < 2 || recipient.length > 200) {
    return c.json({ error: 'recipient must be between 2 and 200 characters' }, 400)
  }

  const dates = defaultDates()
  const startDate = body.start_date ?? dates.start
  const endDate = body.end_date ?? dates.end
  const awardTypes = body.award_types ?? 'contracts'
  const limit = Math.min(Math.max(Math.trunc(body.limit ?? 10), 1), 100)

  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    return c.json({ error: 'Use valid YYYY-MM-DD dates with start_date before end_date' }, 400)
  }
  if (!(awardTypes in awardCodes)) {
    return c.json({ error: 'award_types must be contracts, grants, or all' }, 400)
  }

  try {
    const candidates = await resolveRecipients(recipient)
    const resolved = candidates.results[0]?.recipient_name ?? recipient
    const awards = await searchAwards({
      recipient: resolved,
      start_date: startDate,
      end_date: endDate,
      award_types: awardTypes,
      limit,
    })

    const amountSum = awards.results.reduce((sum, award) => {
      const value = award['Award Amount']
      return sum + (typeof value === 'number' ? value : 0)
    }, 0)

    return c.json({
      query: { recipient, start_date: startDate, end_date: endDate, award_types: awardTypes, limit },
      resolved_recipient: resolved,
      candidate_recipients: candidates.results,
      returned_award_count: awards.results.length,
      returned_award_amount_sum: amountSum,
      has_more: awards.page_metadata.hasNext,
      awards: awards.results,
      provenance: {
        source: 'USAspending.gov',
        retrieved_at: new Date().toISOString(),
        note: 'Amounts sum only the awards returned in this response. has_more indicates additional results.',
      },
    })
  } catch (error) {
    return c.json({
      error: 'Upstream data request failed',
      retryable: true,
    }, 502)
  }
})

discovery(app, mppx, {
  auto: true,
  info: { title: 'Agent Primitives', version: '0.1.0' },
  serviceInfo: {
    categories: ['data', 'research', 'government'],
    docs: {
      homepage: bindings.PUBLIC_BASE_URL,
      apiReference: `${bindings.PUBLIC_BASE_URL}/openapi.json`,
      llms: `${bindings.PUBLIC_BASE_URL}/llms.txt`,
    },
  },
})

export default app
