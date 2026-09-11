import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Entry } from './gateway.ts'

// Named service-binding entrypoint only; no public administrative HTTP route.
export class PaymentOperator extends WorkerEntrypoint<{ PAYMENT_STATE: DurableObjectNamespace }> {
  #state() {
    return this.env.PAYMENT_STATE.get(this.env.PAYMENT_STATE.idFromName('federal-awards-v1')) as unknown as {
      inspectRequest(key: string): Promise<Entry | null>
      reconcilePaid(key: string, hash: string): Promise<unknown>
    }
  }
  fetch() { return new Response('Not found', { status: 404 }) }
  inspectRequest(key: string) { return this.#state().inspectRequest(key) }
  reconcilePaid(key: string, hash: string) { return this.#state().reconcilePaid(key, hash) }
}
