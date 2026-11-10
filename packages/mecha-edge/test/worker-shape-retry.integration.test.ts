import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { signJwt } from '../../../services/auth/jwt.ts'

Deno.test({ name: 'pending shape and entity GETs survive an operator restart', sanitizeOps: false, sanitizeResources: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-shape-restart-' })
  const workerSource = new URL('../src/worker.ts', import.meta.url).pathname
  await Deno.writeTextFile(`${tmp}/worker.ts`, `
import { DurableObject } from 'cloudflare:workers'
import { edgeWorker } from ${JSON.stringify(workerSource)}
export class Cluster extends DurableObject {
  handle = 'note-' + crypto.randomUUID().slice(0, 8)
  held = false
  holdCrud = false
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/test/status') return Response.json({ held: this.held })
    if (url.pathname === '/test/arm') { this.holdCrud = true; return Response.json({ armed: true }) }
    if (url.pathname === '/import/restart') this.ctx.abort('asked by the Worker')
    if (req.headers.get('x-test-request') !== 'preserved') throw new Error('request headers changed')
    if (url.pathname === '/crud/app_user') {
      if (req.method !== 'GET' || url.searchParams.get('select') !== 'id' || url.searchParams.get('id') !== 'eq.user') throw new Error('entity request changed')
      if (this.holdCrud) {
        this.held = true
        await new Promise(resolve => setTimeout(resolve, 20_000))
      }
      return Response.json([{ id: 'user', authorization: req.headers.get('authorization') }], { headers: { 'x-mecha-scope': 'private' } })
    }
    if (url.pathname !== '/electric/v1/shape') throw new Error('unexpected fixture route')
    const headers = { 'electric-handle': this.handle, 'electric-offset': '0_0' }
    if (url.searchParams.get('offset') === 'now') return Response.json([], { headers })
    if (url.searchParams.get('table') !== 'note' || url.searchParams.get('offset') !== '0_0') throw new Error('request parameters changed')
    if (url.searchParams.get('handle') !== this.handle) return Response.json([{ headers: { control: 'must-refetch' } }], { status: 409, headers })
    this.held = true
    await new Promise(resolve => setTimeout(resolve, 20_000))
    return Response.json([], { headers })
  }
}
export default { fetch(req, env, ctx) {
  if (new URL(req.url).pathname.startsWith('/test/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
  return edgeWorker.fetch(req, env, ctx)
} }
`)
  await Deno.writeTextFile(`${tmp}/wrangler.jsonc`, JSON.stringify({
    name: 'mecha-shape-restart-test', main: 'worker.ts', compatibility_date: '2026-09-01',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster'] }],
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    vars: { JWT_SECRET: 'test-secret', IMPORT_TOKEN: 'test-import' },
  }))
  const worker = await startWorker(pathToFileURL(`${tmp}/wrangler.jsonc`), `${tmp}/state`)
  const controller = new AbortController()
  let pending: Promise<Response> | undefined
  try {
    const interruptedRead = async (path: string, headers: Record<string, string>) => {
      pending = fetch(worker.origin + path, {
        headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      const deadline = Date.now() + 10_000
      for (;;) {
        const status = await fetch(`${worker.origin}/test/status`, { signal: AbortSignal.timeout(5_000) })
        const state = await status.json() as { held: boolean }
        if (state.held) break
        assert.ok(Date.now() < deadline, 'the pending read did not reach the object')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      // Real ctx.abort errors carry durableObjectReset, without retryable.
      const restart = await fetch(`${worker.origin}/import/restart`, { method: 'POST', headers: { authorization: 'Bearer test-import' }, signal: AbortSignal.timeout(10_000) })
      assert.equal(restart.status, 200)
      assert.deepEqual(await restart.json(), { restarted: true })
      return await pending
    }
    const initial = await fetch(`${worker.origin}/electric/v1/shape?table=note&offset=now`, { headers: { 'x-test-request': 'preserved' }, signal: AbortSignal.timeout(10_000) })
    assert.equal(initial.status, 200)
    const handle = initial.headers.get('electric-handle')!
    await initial.body?.cancel()
    const response = await interruptedRead(`/electric/v1/shape?table=note&offset=0_0&handle=${handle}&live=true`, { 'x-test-request': 'preserved' })
    const body = await response.text()
    assert.equal(response.status, 409)
    assert.notEqual(response.headers.get('electric-handle'), handle)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(JSON.parse(body), [{ headers: { control: 'must-refetch' } }])
    for (const guest of [false, true]) {
      const authorization = `Bearer ${await signJwt('test-secret', { role: 'app_user', sub: guest ? 'guest' : 'member', guest, exp: Math.floor(Date.now() / 1000) + 60 })}`
      const arm = await fetch(`${worker.origin}/test/arm`, { method: 'POST', signal: AbortSignal.timeout(5_000) })
      assert.deepEqual(await arm.json(), { armed: true })
      const entity = await interruptedRead('/crud/app_user?select=id&id=eq.user', { authorization, 'x-test-request': 'preserved' })
      const result = await entity.text()
      assert.equal(entity.status, 200)
      assert.deepEqual(JSON.parse(result), [{ id: 'user', authorization }])
      if (guest) assert.equal(entity.headers.get('x-edge-cache'), 'miss')
    }
  } finally {
    controller.abort()
    try {
      if (pending) {
        try {
          const response = await pending
          if (!response.bodyUsed) await response.body?.cancel()
        } catch (error) { if (!(error instanceof Error) || error.name !== 'AbortError') throw error }
      }
    } finally {
      await worker.stop()
      await Deno.remove(tmp, { recursive: true })
    }
  }
})
