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

- Request bodies are capped while streaming at 8 KiB; payment headers at 32 KiB.
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

- 50 regression tests pass; TypeScript passes.
- Worker started under the actual local Cloudflare runtime with a SQLite-backed Durable Object.
- Unpaid POST produced both MPP and x402 challenge headers, including Bazaar input/output metadata.
- `@agentcash/discovery` recognizes exactly one paid route at $0.02 and both configured protocols; endpoint schema check passes.
- GitHub Actions passes. The separate existing Cloudflare Workers Builds check failed; detailed logs require account access.
- All local x402 metadata uses Base Sepolia and a placeholder facilitator; this is not a production payment test.
