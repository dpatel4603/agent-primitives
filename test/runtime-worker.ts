// Test-only entry point: this is never imported by src/index.ts or deployed.
import app from '../src/index.ts'
import { PaymentState } from '../src/state.ts'
export class TestState extends PaymentState {
  async seed(key: string, entry: unknown) { await this.ctx.storage.put(`request:${key}`, entry) }
}
export default {
  async fetch(request: Request, env: any, context: ExecutionContext) {
    if (new URL(request.url).pathname === '/__inspect') {
      const stub = env.PAYMENT_STATE.get(env.PAYMENT_STATE.idFromName('federal-awards-v1'))
      return Response.json(await stub.inspectRequest(new URL(request.url).searchParams.get('key')))
    }
    if (new URL(request.url).pathname === '/__seed') {
      const { key, entry } = await request.json() as any
      const stub = env.PAYMENT_STATE.get(env.PAYMENT_STATE.idFromName('federal-awards-v1'))
      await stub.seed(key, entry)
      return Response.json({ ok: true })
    }
    return app.fetch(request, env, context)
  },
}
