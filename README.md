# Agent Primitives

A public Cloudflare Worker hub that charges agents $0.02 through the Machine Payments Protocol (MPP) to resolve a company and return its largest US federal contracts or grants from USAspending.gov.

## Why this endpoint

MPPscan already contains model proxies, generic web search, weather, SEC filings, and media generation. It does not currently have a focused, agent-ready US federal-awards lookup. The upstream data is public and does not require an API key, so every paid call has essentially zero marginal data cost.

This is an experiment, not a proven business. As checked on September 3, 2026, MPPscan showed about $2,020 of volume in the preceding seven days and $424,270 all-time across the full network.

## Local setup

```bash
npm install
npm run cf-typegen
cp .dev.vars.example .dev.vars
openssl rand -base64 32
# Put the output in MPP_SECRET_KEY inside .dev.vars
npm run dev
```

The checked-in config uses Tempo mainnet and a placeholder recipient address. Replace `MPP_RECIPIENT` in `wrangler.jsonc` before testing a payment.

Inspect the 402 challenge without paying:

```bash
npx mppx --inspect \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"recipient":"PALANTIR USG INC"}' \
  http://localhost:8787/v1/fedspend/company
```

Create and fund a test account, then make the paid request:

```bash
npx mppx account create
npx mppx \
  -X POST \
  -H 'content-type: application/json' \
  -d '{"recipient":"PALANTIR USG INC"}' \
  http://localhost:8787/v1/fedspend/company
```

## Deploy

1. Log in to Cloudflare:

```bash
npx wrangler login
```

2. Generate and store the MPP challenge signing secret:

```bash
openssl rand -base64 32 | npx wrangler secret put MPP_SECRET_KEY
```

3. Create a Tempo mainnet receiving account:

```bash
npx mppx account create --network mainnet
```

4. In `wrangler.jsonc`, set:
   - `PUBLIC_BASE_URL` to the final Worker URL.
   - `MPP_RECIPIENT` to the public address that should receive payments.
   - `MPP_CURRENCY` to the current supported Tempo mainnet stablecoin address from the MPP docs.
   - `TEMPO_TESTNET` to `false`.

5. Deploy:

```bash
npm run deploy
```

6. Validate discovery and payment behavior:

```bash
npx mppx discover validate https://YOUR-WORKER.workers.dev/openapi.json
npx mppx --inspect -X POST -H 'content-type: application/json' \
  -d '{"recipient":"PALANTIR USG INC"}' \
  https://YOUR-WORKER.workers.dev/v1/fedspend/company
```

7. Go to https://www.mppscan.com/register, paste the Worker hostname, and click **Add API**.

Do not submit the listing until the live endpoint, mainnet recipient, price, and returned data have all been verified.

## API

### `POST /v1/fedspend/company` - $0.02

```json
{
  "recipient": "PALANTIR USG INC",
  "start_date": "2024-01-01",
  "end_date": "2026-12-31",
  "award_types": "contracts",
  "limit": 10
}
```

Optional fields:
- `start_date` and `end_date`, defaulting to the trailing three years
- `award_types`: `contracts`, `grants`, or `all`
- `limit`: 1 to 100, default 10

Free routes:
- `GET /`
- `GET /health`
- `GET /sample`
- `GET /llms.txt`
- `GET /openapi.json`

## Before treating this as a real product

- Replace the placeholder contact address in the upstream `User-Agent`.
- Before material traffic, replace the default in-memory replay store with a shared atomic store or Tempo relay.
- Add cache and rate limiting if traffic becomes meaningful.
- Improve legal-entity resolution so similarly named subsidiaries are not silently combined.
- Add a second endpoint only after the first endpoint receives real paid calls.
- Do not describe returned top-page totals as total lifetime federal revenue when `has_more` is true.
