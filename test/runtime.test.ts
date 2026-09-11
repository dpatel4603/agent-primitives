import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { Challenge, Credential } from 'mppx'
import { Store } from 'mppx/server'
import { createPayments, PATH } from '../src/payments.ts'
import { canonicalize, sha256 } from '../src/gateway.ts'
import { config, query } from './helpers.ts'

test('actual Worker and SQLite Durable Object recover response after runtime restart', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-primitives-runtime-'))
  const script = buildSync({ entryPoints: ['test/runtime-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:workers', 'node:*'], target: 'es2022' }).outputFiles[0].text
  const options = { name: 'agent-primitives-runtime-test', script, modules: true, compatibilityDate: '2026-09-03', compatibilityFlags: ['nodejs_compat'], durableObjects: { PAYMENT_STATE: { className: 'TestState', useSQLite: true } }, durableObjectsPersist: dir, bindings: config }
  let mf: Miniflare | undefined
  try {
    mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: dir })
    const probe = await mf.dispatchFetch(`https://api.example.com${PATH}`, { method: 'POST', body: '{}' })
    assert.equal(probe.status, 402); assert.match(probe.headers.get('www-authenticate')!, /^Payment /)
    const spec = await (await mf.dispatchFetch('https://api.example.com/openapi.json')).json() as any
    assert.ok(spec.paths[PATH].post.requestBody)
    // Seed only via the separate test entry point; production has no such route.
    const credential = Credential.serialize({ challenge: Challenge.from({ secretKey: config.MPP_SECRET_KEY, realm: 'api.example.com', method: 'tempo', intent: 'charge', request: { amount: '20000', currency: config.MPP_CURRENCY, recipient: config.MPP_RECIPIENT, methodDetails: { chainId: 42431 } }, expires: '2020-01-01T00:00:00Z' }), payload: { type: 'hash', hash: `0x${'66'.repeat(32)}` } })
    const req = () => new Request(`https://api.example.com${PATH}`, { method: 'POST', body: JSON.stringify(query), headers: { authorization: credential, 'content-type': 'application/json' } })
    const identity = await createPayments(config, Store.memory()).inspect(req())
    const entry = { fingerprint: await sha256(JSON.stringify({ path: PATH, body: canonicalize(query) })), proof: identity.proof, owner: 'fixture', lease_until: 0, state: 'complete', created_at: new Date().toISOString(), response: { body: '{"persisted":true}', status: 200, headers: [['content-type', 'application/json'], ['payment-receipt', 'fixture-receipt']] } }
    assert.equal((await mf.dispatchFetch('https://api.example.com/__seed', { method: 'POST', body: JSON.stringify({ key: identity.key, entry }) })).status, 200)
    assert.ok(await (await mf.dispatchFetch(`https://api.example.com/__inspect?key=${identity.key}`)).json(), 'seed persisted before restart')
    await mf.dispose(); mf = new Miniflare({ ...convertV4MiniflareOptions(options), resourcePersistencePath: dir })
    assert.ok(await (await mf.dispatchFetch(`https://api.example.com/__inspect?key=${identity.key}`)).json(), 'seed persisted after restart')
    const retry = req()
    const result = await mf.dispatchFetch(retry.url, { method: retry.method, headers: Object.fromEntries(retry.headers), body: await retry.text() })
    assert.equal(result.status, 200); assert.equal(result.headers.get('idempotency-replayed'), 'true'); assert.equal(result.headers.get('payment-receipt'), 'fixture-receipt'); assert.deepEqual(await result.json(), { persisted: true })
    assert.equal((await mf.dispatchFetch('https://api.example.com/internal/reconcile')).status, 404)
  } finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }) }
})
