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
- [ ] Operator payment reconciliation procedure implemented and exercised.
- [ ] Register verified production origin with MPP Scan and x402scan and confirm invocable listings.

## Payment states

`preparing` and `prepared` are guaranteed pre-submission. A 60-second fenced lease allows the same proof to resume after interruption. An older worker cannot advance or delete a newer worker's request.

`settling` means submission may have occurred. It is never automatically reset or resubmitted. The prepared answer remains durable for reconciliation.

`complete` stores the answer and receipt once. The original proof can retrieve it even after challenge expiration. Raw credentials are not logged or stored; the ledger retains proof digests and result/receipt evidence.

Reconciliation remains a launch gate: verify the transaction against the intended network, asset, recipient, exact amount and original authorization. Never clear a settling record solely because a client reports an error. Do not promise an automated refund without an actual refund mechanism.

## Limits and scope

- Request bodies are capped while streaming at 8 KiB; payment headers at 32 KiB.
- Results over 90,000 serialized bytes are rejected before server payment submission; lower the page limit.
- Initial per-IP rate limit is 30 requests per minute. Signed-credential verification precedes USAspending work and durable request creation.
- Payment records are retained for audit and recovery. Rate buckets expire; storage growth and retention policy require operational monitoring before scaling.
- One shared Durable Object serializes atomic storage updates; throughput is intentionally bounded for launch.
- No subscriptions, new datasets, extra paid routes, warranty, or recompete predictions are added.
