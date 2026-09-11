# Launch readiness and operations

## Required before registration

- [ ] Receiving addresses and currencies confirmed by owner for Tempo and Base.
- [ ] Cloudflare authenticated, production origin configured, signing secret provisioned.
- [ ] x402 facilitator confirmed for chosen network, including its authentication requirements.
- [ ] Durable Object migrations deployed and restart/concurrency behavior verified in Workers.
- [ ] Independent PR review findings resolved and CI green.
- [ ] Live `/openapi.json` passes scanner discovery/schema audit.
- [ ] Unpaid runtime probe returns correct MPP and x402 challenges.
- [ ] One successful real paid request on each advertised protocol with matching recipient, amount, receipt and saved response.
- [ ] Lost-response retry returns original response without another settlement.
- [ ] Invalid credential, expired proof, duplicate proof, upstream outage and ambiguous recipient tests verified.
- [ ] Operator payment reconciliation exercised against a deployed Durable Object and real receipt.
- [ ] Register verified production origin with MPP Scan and x402scan and confirm invocable listings.

## Payment states

`preparing` and `prepared` are guaranteed pre-submission. A 60-second fenced lease allows the same proof to resume after interruption. An older worker cannot advance or delete a newer worker's request.

`settling` means submission may have occurred. It is never automatically reset or resubmitted. The prepared answer remains durable for reconciliation.

`complete` stores the answer and receipt once. The original proof can retrieve it even after challenge expiration. Raw credentials are not logged or stored; the ledger retains proof digests and result/receipt evidence.

Production reconciliation remains a launch gate: verify the transaction against the intended network, asset, recipient, exact amount and original authorization. Never clear a settling record solely because a client reports an error. Do not promise an automated refund without an actual refund mechanism.

## Limits and scope

- Request bodies are capped while streaming at 8 KiB with a five-second read deadline; payment headers at 32 KiB.
- Results over 90,000 serialized bytes are rejected before server payment submission; lower the page limit.
- Initial limits are 30 requests per IP per minute, 300 requests globally per minute, and eight concurrently executing requests. Signed-credential verification precedes USAspending work and durable request creation.
- Payment records are retained for audit and recovery. Rate buckets expire; storage growth and retention policy require operational monitoring before scaling.
- One shared Durable Object serializes atomic storage updates; throughput is intentionally bounded for launch.
- No subscriptions, new datasets, extra paid routes, warranty, or recompete predictions are added.

## Operator recovery (no public administrative route)

The Durable Object provides `inspectRequest(requestId)` and `reconcilePaid(requestId, transactionHash)` RPC methods, reachable only through a Cloudflare-authorized binding. The public Worker does not expose those methods over HTTP.

To inspect a production incident, authenticate Wrangler to the owner account. Place a new random local token in `scripts/.dev.vars` as `OPERATOR_TOKEN` (at least 32 characters, file mode 0600). Start the local-only bridge:

```sh
npx wrangler dev --config scripts/operator.wrangler.jsonc
```

Send authenticated requests from a terminal to `http://127.0.0.1:8788/?request_id=REQUEST_ID`, with `Authorization: Bearer YOUR_LOCAL_TOKEN`. GET inspects the retained entry; POST additionally requires `transaction_hash=0x...`.

POST can only complete an existing uncertain payment after read-only on-chain verification. It requires a successful transaction with at least three confirmations, the correct token/recipient/exact amount, and for x402 the original payer plus `AuthorizationUsed` nonce. MPP requires the hash of the transaction already validated before broadcast. Network RPC selection is fixed to supported chains; the operator cannot supply an arbitrary RPC URL. Prepared content is returned unchanged with reconstructed payment receipt headers.

No tool clears uncertain payments or resubmits them. If no qualifying payment exists, keep the entry locked and investigate with the client/facilitator; do not tell a client to pay again until the original authorization can no longer settle. Do not deploy the local bridge as a public Worker. Stop it when incident response is done. The account must already have permission to the production Durable Object.

## Local verification recorded

- 55 regression tests pass; TypeScript passes.
- Worker started under the actual local Cloudflare runtime with a SQLite-backed Durable Object.
- Unpaid POST produced both MPP and x402 challenge headers, including Bazaar input/output metadata.
- `@agentcash/discovery` recognizes exactly one paid route at $0.02 and both configured protocols; endpoint schema check passes.
- GitHub Actions passes. The separate existing Cloudflare Workers Builds check failed; detailed logs require account access.
- All local x402 metadata uses Base Sepolia and a placeholder facilitator; this is not a production payment test.

## Additional launch verification (2026-09-11)

- SQLite Durable Object restart regression passes in actual local workerd; original proof retrieves the persisted body and receipt after a full runtime restart.
- Native transaction identities normalize supported Tempo signature encodings before hashing, matching the SDK settlement hash.
- Native MPP testnet request succeeded through production gateway/payment/source modules in Node with a memory ledger and live USAspending data. The exact-proof retry returned an identical body and receipt and only one settlement invocation. This is not a deployed Worker verification.
- Tempo Moderato transaction: `0x88e86fe11338039cd83ad042e96f73958cb7993ab537792b701ff4afe5231489`. Disposable faucet-funded wallet: `0xd7E89E5759d29881197c43769D433FD8a71F08E1`. No mainnet funds used.
- Final local scanner discovery reports exactly one paid route, both protocols, and no discovery warnings. Award sums now use integer cents to avoid floating-point addition artifacts.

### Local Worker transport and payment verified

Two independent issues caused the initial failure. Local workerd lacked the trusted Sectigo Public Server Authentication Root R46 used by USAspending's certificate chain; supplying the machine's existing trusted CA bundle through `NODE_EXTRA_CA_CERTS` resolved TLS transport without disabling verification. After that, workerd exposed an `Illegal invocation` because the default fetch function was invoked as a property of the source client. Calling it with `globalThis` fixes that application bug. A deterministic actual-Worker regression now exercises the real global fetch against a separate upstream fixture worker.

On this development machine the safe local command is:

```sh
NODE_EXTRA_CA_CERTS=/opt/anaconda3/ssl/cacert.pem npm run dev
```

Use an appropriate trusted CA bundle on other machines; do not disable certificate validation or assume that this machine-specific path exists elsewhere.

Full local Worker + SQLite Durable Object + live USAspending + Tempo Moderato test passed (HTTP 200, two awards). Testnet transaction: `0xd2f4227e99ae726e720a74911d899b7de636a335c6fedbab0ea0a48bfcbc1c55`. Request ID: `58fe8c9fb45dbf1437069ab3c1879ed1c45543850b907dda257a953839c133ea`. Exact-proof retry returned `Idempotency-Replayed: true`, the identical body and identical receipt. Production edge connectivity and mainnet payment are still launch gates.

Independent security review at `0e40eb8` found no additional actionable issues and independently passed all then-current 54 tests. The subsequent fetch fix adds a 55th regression; final follow-up review is recorded in the PR. Tests cover persisted-response recovery, not a process crash during an actual on-chain broadcast.

### Deployment and x402 facilitator

The existing Cloudflare Builds check has no useful GitHub diagnostic output. Confirm build logs after authentication. Initial deployment and new Durable Object migrations require `wrangler deploy`; a nonproduction branch's default `wrangler versions upload` cannot apply a new Durable Object class. Runtime secrets must be configured separately from build variables.

PayAI (`https://facilitator.payai.network`) advertises Base and Base Sepolia v2 support and a no-key allowance of 1,000 lifetime settlements, subject to recipient and shared-IP limits. It is a candidate, not a verified production payment integration. Beyond the allowance, merchant credentials and credits are required. See https://docs.payai.network/x402/facilitators/pricing.
