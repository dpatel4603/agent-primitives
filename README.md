# Agent Primitives

One agent-callable federal-awards API, backed by USAspending.gov. A successful page costs $0.02. MPP on Tempo is supported; x402 USDC on Base or Base Sepolia can be enabled through configuration. Neither a live deployment nor scanner listing is implied by this repository.

## Request

`POST /v1/fedspend/company`

```json
{
  "recipient": "PALANTIR USG INC",
  "recipient_uei": "HNN4F9JZWDY8",
  "start_date": "2024-01-01",
  "end_date": "2026-09-11",
  "award_types": "contracts",
  "limit": 10,
  "page": 1
}
```

- Confirm `recipient_uei` for the intended legal entity. A name-only request returns HTTP 409 with candidate names/observed UEIs to confirm, without submitting payment. A name does not prove a unique entity, and results do not automatically include parents or subsidiaries.
- `award_types` accepts `contracts` or `grants`. The previous `all` option was removed because USAspending prohibits mixed award groups.
- `limit` is 1–100; `page` is 1–10000. Use `next_page` for another separately priced page.
- Dates default to the trailing three years. Dates must exist and start on or after 2007-10-01.
- `returned_award_amount_sum` covers only returned award amounts, not company revenue or spending incurred within the search interval. Pages query live data and can change between calls.
- Each award includes its USAspending source link and retrieval timestamp. Recorded end dates are not predictions of a recompete.

## Payment and retry behavior

Unpaid requests return HTTP 402 with MPP `WWW-Authenticate` and, when configured, x402 `Payment-Required`. Discovery probes perform no USAspending work.

For credential-bearing requests, the server validates input and payment credentials without settlement, prepares and durably saves the result, then submits payment. MPP replay protection and the request ledger use a shared Cloudflare Durable Object. x402 requests are keyed by network, asset, payer and authorization nonce, with the original proof required to recover a response.

After a lost response, retry the identical JSON and original payment credential. A completed request returns its saved body and receipt with `Idempotency-Replayed: true`, without another settlement. Changed queries or proofs conflict. Expired preparation leases can be reclaimed safely; uncertain settlement stays locked for reconciliation. **Do not create a new payment after a reconciliation error.**

No automatic financial refund is promised. An upstream/preparation failure occurs before the server submits payment; a payment a client independently broadcasts before calling this API can already be spent. Interrupted settlement requires receipt/chain reconciliation. See [launch status and operations](docs/LAUNCH-READINESS.md).

## Local development

```sh
npm ci
cp .dev.vars.example .dev.vars
# Generate a local-only signing secret; never reuse test secrets in production.
openssl rand -base64 32
# Paste it into MPP_SECRET_KEY in .dev.vars.
npm run dev
npm run check
```

Use `TEMPO_TESTNET=true` locally. x402 starts disabled. Enable only with an explicit network, receiving address and HTTPS facilitator supporting that network. Free routes: `/`, `/health`, `/sample`, `/llms.txt`, `/openapi.json`. Health means the process is responding, not that payment or upstream services have been verified.

## Production configuration

1. Authenticate with `npx wrangler login`.
2. Set `PUBLIC_BASE_URL` to the real HTTPS origin, without a path.
3. Confirm `MPP_RECIPIENT`, `MPP_CURRENCY`, and `TEMPO_TESTNET=false` for the intended production deployment.
4. Store a new signing secret using `npx wrangler secret put MPP_SECRET_KEY`.
5. To enable x402, set `X402_ENABLED=true`, `X402_NETWORK=base`, `X402_RECIPIENT` and `X402_FACILITATOR_URL` to a facilitator verified to settle Base USDC.
6. Deploy with `npm run deploy`, which creates the configured SQLite-backed Durable Object binding.
7. Complete the launch checks below before registration.

OpenAPI includes explicit input/output schemas, fixed price metadata, protocol declarations, and agent instructions. Runtime challenges remain authoritative. Register the verified origin at [MPP Scan](https://mppscan.com/register) and [x402scan](https://www.x402scan.com/resources/register).

## Checks

`npm run check` runs TypeScript checks and regression tests covering entity ambiguity, UEI constraints, bad source data, pagination, outages, payment ordering, retries, storage leases, real x402 signature verification and mock facilitator settlement. Tests do not send real payments. CI also runs the dependency audit and Worker bundle check.

The live mainnet payment and scanner verification gates are recorded separately; passing unit tests does not establish production readiness.
