// Local-only administrative bridge. Never deployed with the public API.
// Cloudflare login authorizes the remote Durable Object binding.
export default {
  async fetch(request: Request, env: { OPERATOR_TOKEN: string; PAYMENT_STATE: DurableObjectNamespace }) {
    const url = new URL(request.url)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || request.headers.has('origin')) return new Response('Forbidden', { status: 403 })
    if (!env.OPERATOR_TOKEN || env.OPERATOR_TOKEN.length < 32 || request.headers.get('authorization') !== `Bearer ${env.OPERATOR_TOKEN}`) return new Response('Unauthorized', { status: 401 })
    const stub = env.PAYMENT_STATE.get(env.PAYMENT_STATE.idFromName('federal-awards-v1')) as unknown as { inspectRequest(key: string): Promise<unknown>; reconcilePaid(key: string, hash: string): Promise<unknown> }
    const key = url.searchParams.get('request_id') ?? ''
    if (!/^[a-f0-9]{64}$/.test(key)) return new Response('Invalid request ID', { status: 400 })
    if (request.method === 'GET') return Response.json(await stub.inspectRequest(key), { headers: { 'cache-control': 'no-store' } })
    if (request.method === 'POST') {
      const hash = url.searchParams.get('transaction_hash') ?? ''
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) return new Response('Invalid transaction hash', { status: 400 })
      return Response.json(await stub.reconcilePaid(key, hash))
    }
    return new Response('Method not allowed', { status: 405 })
  },
}
