// The edge cluster in a Durable Object under wrangler dev, over a data
// directory loaded as a release loads one: guests, row policy per request,
// shapes from the start and held open, a write confirmed by its x-txid in the
// shape stream, and the object resumed after an eviction and after
// ctx.abort(). Needs ../pglite-workerd/dist.
import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

type Message = { key?: string; value?: Record<string, string>; headers: Record<string, unknown> }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

Deno.test({ name: 'the edge cluster serves many subjects from one object', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  Deno.statSync(new URL('../../pglite-workerd/dist/pglite.wasm', import.meta.url))
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-' })
  await seed(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  const at = (path: string) => `${worker.origin}${path}`
  const guest = async () => {
    const res = await fetch(at('/auth/guest'), { method: 'POST' })
    const text = await res.text()
    assert.ok(res.ok, `/auth/guest: ${res.status} ${text}`)
    return JSON.parse(text) as { token: string; user: { id: string } }
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const crud = async (token: string, path: string, init: RequestInit = {}) => {
    const res = await fetch(at(`/crud/${path}`), { ...init, headers: { ...bearer(token), 'content-type': 'application/json', prefer: 'return=representation' } })
    const text = await res.text()
    assert.ok(res.ok, `${path}: ${res.status} ${text}`)
    return { res, rows: JSON.parse(text) }
  }
  const shapeOf = async (token: string, table: string) => {
    const res = await fetch(at('/auth/shape'), { method: 'POST', headers: bearer(token), body: JSON.stringify({ table }) })
    assert.ok(res.ok, `/auth/shape: ${res.status}`)
    const { token: shape, where } = await res.json() as { token: string; where: string }
    return (params: string, init: RequestInit = {}) => fetch(at(`/electric/v1/shape?table=${table}&where=${encodeURIComponent(where)}&${params}`), { ...init, headers: bearer(shape) })
  }
  const idle = async () => { await delay(500); return (await (await fetch(at('/test/timers'))).json()) as { bornAt: string; timers: string[] } }
  try {
    const loading = await fetch(at('/test/public'))
    assert.equal(loading.status, 503)
    assert.deepEqual(await loading.json(), { loading: true })
    const alarmDuringImport = await fetch(at('/test/alarm'))
    assert.equal(alarmDuringImport.status, 200)
    await alarmDuringImport.body?.cancel()
    const beforeImportReset = await fetch(at('/test/set-alarm'))
    await beforeImportReset.body?.cancel()
    const importReset = await fetch(at('/import/reset'), { method: 'POST', headers: { authorization: 'Bearer test-import' } })
    assert.equal(importReset.status, 200)
    await importReset.body?.cancel()
    assert.deepEqual(await (await fetch(at('/test/alarm-state'))).json(), { alarm: null })
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const ready = await fetch(at('/test/public'))
    assert.equal(ready.status, 200)
    assert.deepEqual(await ready.json(), [{ title: 'Brasileirão 2026' }])

    const alice = await guest()
    const bob = await guest()

    await t.step('a navigation to any route gets the document, a missing file a 404', async () => {
      const get = async (path: string, accept: string) => {
        const res = await fetch(at(path), { headers: { accept } })
        return { status: res.status, text: await res.text() }
      }
      assert.deepEqual(await get('/', 'text/html'), { status: 200, text: '<!doctype html><title>edge</title>\n' })
      assert.equal((await get('/campeonato/x', 'text/html,application/xhtml+xml')).status, 200)
      assert.equal((await get('/shell/renderers/missing.js', '*/*')).status, 404)
    })
    await t.step('an import needs the import token', async () => {
      const res = await fetch(at('/import/state'), { headers: bearer(alice.token) })
      await res.body?.cancel()
      assert.equal(res.status, 401)
    })
    await t.step('a request without a session is refused', async () => {
      const res = await fetch(at('/crud/note'))
      await res.body?.cancel()
      assert.equal(res.status, 401)
    })
    await t.step("each subject writes and reads only its own rows", async () => {
      const { res, rows } = await crud(alice.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'só da Alice' }) })
      assert.match(res.headers.get('x-txid') ?? '', /^\d+$/)
      assert.equal(rows[0].owner, alice.user.id)
      assert.equal((await crud(alice.token, 'note')).rows.length, 1)
      assert.equal((await crud(bob.token, 'note')).rows.length, 0)
      assert.deepEqual((await crud(bob.token, 'board?select=title')).rows, [{ title: 'Brasileirão 2026' }])
    })
    await t.step("a shape holds its subject's rows, and only under its token's predicate", async () => {
      const notes = await shapeOf(alice.token, 'note')
      const all = (await (await notes('offset=-1')).json()) as Message[]
      assert.deepEqual(all.filter((m) => m.value).map((m) => m.value!.body), ['só da Alice'])
      const bobs = (await (await (await shapeOf(bob.token, 'note'))('offset=-1')).json()) as Message[]
      assert.equal(bobs.filter((m) => m.value).length, 0)
      const widened = await fetch(at('/electric/v1/shape?table=note&offset=-1&where=true'), { headers: bearer(alice.token) })
      await widened.body?.cancel()
      assert.equal(widened.status, 401)
    })
    await t.step('a held-open request answers with the write, confirmed by its x-txid', async () => {
      const notes = await shapeOf(alice.token, 'note')
      const first = await notes('offset=-1')
      await first.body?.cancel()
      const live = notes(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}&live=true`)
      await delay(300)
      const { res } = await crud(alice.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'ao vivo' }) })
      const answer = await live
      assert.equal(answer.status, 200)
      const changes = ((await answer.json()) as Message[]).filter((m) => m.value)
      assert.deepEqual(changes.map((m) => m.value!.body), ['ao vivo'])
      assert.deepEqual(changes[0].headers.txids, [Number(res.headers.get('x-txid'))])
    })
    await t.step("the Worker's cache: a public table's chunks are every guest's, live is never kept", async () => {
      const alices = await shapeOf(alice.token, 'board')
      const bobs = await shapeOf(bob.token, 'board')
      const state = async (r: Promise<Response>) => { const res = await r; await res.body?.cancel(); return res.headers.get('x-edge-cache') }
      // A Worker that has not met the object's epoch passes the first by.
      assert.match(await state(alices('offset=-1')) ?? '', /^(bypass|miss)$/)
      await state(alices('offset=-1'))
      assert.equal(await state(alices('offset=-1')), 'hit')
      assert.equal(await state(bobs('offset=-1')), 'hit')
      const notes = await shapeOf(alice.token, 'note')
      const first = await notes('offset=-1')
      await first.body?.cancel()
      const live = notes(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}&live=true`)
      await delay(200)
      await crud(alice.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'para o vivo' }) })
      const answered = await live
      await answered.body?.cancel()
      assert.equal(answered.headers.get('x-edge-cache'), 'bypass')
      // The browser keeps what Electric's server would let it, and no live answer.
      assert.equal(answered.headers.get('cache-control'), 'no-store')
      assert.equal(first.headers.get('cache-control'), 'public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746')
      const later = await notes(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`)
      await later.body?.cancel()
      assert.equal(later.headers.get('cache-control'), 'public, max-age=60, stale-while-revalidate=300')
      await crud(alice.token, 'note?body=eq.para%20o%20vivo', { method: 'DELETE' })
    })
    await t.step("a guest's cached read gives way to its own write", async () => {
      const read = async () => {
        const res = await fetch(at('/crud/note?select=body&order=body'), { headers: bearer(alice.token) })
        return { state: res.headers.get('x-edge-cache'), bodies: ((await res.json()) as { body: string }[]).map((n) => n.body) }
      }
      const before = await read()
      const again = await fetch(at('/crud/note?select=body&order=body'), { headers: bearer(alice.token) })
      await again.body?.cancel()
      assert.equal(again.headers.get('x-edge-cache'), 'hit')
      assert.equal(again.headers.get('cache-control'), 'no-store')
      await crud(alice.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'depois do cache' }) })
      const after = await read()
      assert.equal(after.state, 'miss')
      assert.deepEqual(after.bodies, [...before.bodies, 'depois do cache'].sort())
      await crud(alice.token, 'note?body=eq.depois%20do%20cache', { method: 'DELETE' })
    })
    await t.step("a new object's chunks replace the old one's", async () => {
      const board = await shapeOf(alice.token, 'board')
      const res = await board('offset=-1')
      await res.body?.cancel()
      const handle = res.headers.get('electric-handle')!
      await fetch(at('/test/abort'))
      // The old handle is refused by the new object, which teaches the Worker its epoch.
      const stale = await board(`offset=${res.headers.get('electric-offset')}&handle=${handle}`)
      await stale.body?.cancel()
      assert.equal(stale.status, 409)
      assert.equal(stale.headers.get('cache-control'), 'no-store')
      const fresh = await board('offset=-1')
      await fresh.body?.cancel()
      assert.notEqual(fresh.headers.get('electric-handle'), handle)
      assert.equal(fresh.headers.get('x-edge-cache'), 'miss')
    })
    await t.step('no timer is pending once requests complete', async () => {
      assert.deepEqual((await idle()).timers, [])
    })
    await t.step('after ctx.abort() the object resumes: rows kept, sessions valid, shapes refetched', async () => {
      const notes = await shapeOf(alice.token, 'note')
      const before = await notes('offset=-1')
      await before.body?.cancel()
      const bornAt = (await idle()).bornAt
      const res = await fetch(at('/test/abort'))
      await res.body?.cancel()
      assert.notEqual((await idle()).bornAt, bornAt)
      assert.equal((await crud(alice.token, 'note')).rows.length, 2)
      const stale = await notes(`offset=${before.headers.get('electric-offset')}&handle=${before.headers.get('electric-handle')}`)
      await stale.body?.cancel()
      assert.equal(stale.status, 409)
      assert.equal(stale.headers.get('cache-control'), 'no-store')
    })
    await t.step('after an eviction too', async () => {
      await worker.restart()
      assert.equal((await crud(alice.token, 'note')).rows.length, 2)
      assert.equal((await crud(bob.token, 'note')).rows.length, 0)
      assert.deepEqual((await idle()).timers, [])
    })
    await t.step('a reset replaces live data: 503 while the new directory loads, then served', async () => {
      const send = (route: string, init?: RequestInit) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } })
      const pending = await fetch(at('/test/set-alarm'))
      await pending.body?.cancel()
      const res = await send('reset', { method: 'POST' })
      assert.equal(res.status, 200)
      await res.body?.cancel()
      await delay(200)
      assert.deepEqual(await (await fetch(at('/test/alarm-state'))).json(), { alarm: null })
      const alarmDuringImport = await fetch(at('/test/alarm'))
      assert.equal(alarmDuringImport.status, 200)
      await alarmDuringImport.body?.cancel()
      const loading = await fetch(at('/crud/board'), { headers: bearer(alice.token) })
      await loading.body?.cancel()
      assert.equal(loading.status, 503)
      const publicLoading = await fetch(at('/test/public'))
      assert.equal(publicLoading.status, 503)
      assert.deepEqual(await publicLoading.json(), { loading: true })
      const done = await load(`${tmp}/pgdata`, send, { log: () => {} })
      assert.ok((done.chunksVerified ?? 0) > 0)
      assert.deepEqual((await crud(alice.token, 'board?select=title')).rows, [{ title: 'Brasileirão 2026' }])
      assert.equal((await crud(alice.token, 'note')).rows.length, 0)
    })
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
