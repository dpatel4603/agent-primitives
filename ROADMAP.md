# Primitive Expansion Rules

The hub starts with one endpoint. New primitives are added only when they meet all five conditions:

1. An agent needs the result during a real workflow.
2. The existing service is human-shaped, key-gated, subscription-only, or absent from MPP discovery.
3. The input and output can be described unambiguously in OpenAPI.
4. A call completes without human review.
5. Gross margin is positive at the advertised per-call price.

## First primitive

`POST /v1/fedspend/company` resolves a company name and returns its largest US federal contracts or grants from USAspending.gov.

## Candidate queue, not commitments

- Company federal award history
- USPTO patent and assignment lookup, after the new ODP API stabilizes
- Public procurement and grant search outside the US
- Media inspection utilities with deterministic outputs
- Document and structured-data transformations missing from current MPP listings

## Expansion test

For each endpoint, track:
- unique paying agents
- paid calls
- gross revenue
- upstream cost
- repeat-agent rate
- failure rate
- search impressions or discovery referrals when available

Keep an endpoint when it receives at least 3 independent paying agents or 20 paid calls in 14 days. Otherwise leave it stable but do not invest further.
