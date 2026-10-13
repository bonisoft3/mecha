// The package in a Durable Object under wrangler dev: a data directory loads and
// verifies, PGlite boots over it with no runtime wasm compilation, PL/pgSQL
// triggers and DO blocks run, the snowball dictionaries load, an ICU collation
// over the root locale ignores accents and case, a schema applies inside the
// object, and no timer is left pending once a request completes, after a clean
// boot or after an eviction. Needs dist/ (`just build`).
import assert from 'node:assert/strict'
import { startWorker } from '../wrangler-dev.ts'
import { fixture, seed } from './seed.ts'
import { load } from '../load.ts'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// wrangler's output streams outlive each restart's step.
for (const codec of ['raw', 'deflate']) Deno.test({ name: `PGlite serves a ${codec} data directory in a Durable Object`, sanitizeResources: false, sanitizeOps: false }, async (t) => {
  Deno.statSync(new URL('../dist/pglite.wasm', import.meta.url))
  const tmp = await Deno.makeTempDir({ prefix: 'pglite-workerd-' })
  await seed(`${tmp}/seeded`, true)
  await seed(`${tmp}/empty`, false)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  const call = async (path: string, name: string, init?: RequestInit) => {
    const res = await fetch(`${worker.origin}${path}${path.includes('?') ? '&' : '?'}do=${name}&codec=${codec}`, init)
    const text = await res.text()
    assert.ok(res.ok, `${path}: ${res.status} ${text}`)
    return JSON.parse(text)
  }
  const send = (name: string) => (route: string, init?: RequestInit) => fetch(`${worker.origin}/import/${route}${route.includes('?') ? '&' : '?'}do=${name}&codec=${codec}`, init)
  const rows = (sql: string, name = 'seeded') => call('/sql', name, { method: 'POST', body: JSON.stringify({ sql }) })
  const idleTimers = async (name = 'seeded') => { await delay(1000); return (await call('/state', name)).timers }
  try {
    await t.step('filesystem formats preserve partial and sparse writes', async () => {
      assert.deepEqual(await call('/filesystem-cases', 'filesystem'), { ok: true })
    })
    await load(`${tmp}/seeded`, send('seeded'), { log: () => {} })
    await load(`${tmp}/empty`, send('fresh'), { log: () => {} })

    await t.step('a load cut by a restart resumes from what the object holds', async () => {
      let calls = 0
      const cut = async (route: string, init?: RequestInit) => {
        if (route.startsWith('chunk') && ++calls === 5) {
          await worker.restart()
          throw new TypeError('connection lost')
        }
        return await send('resumed')(route, init)
      }
      const lines: string[] = []
      const done = await load(`${tmp}/empty`, cut, { log: (l) => lines.push(l) })
      assert.ok(lines.some((l) => l.includes('resuming')), lines.join('\n'))
      assert.ok((done.chunksVerified ?? 0) > 0)
    })
    await t.step('a load leaves a complete directory alone', async () => {
      assert.deepEqual(await load(`${tmp}/seeded`, send('seeded'), { log: () => {} }), { skipped: 'complete' })
    })
    await t.step('an object with no complete directory does not open one', async () => {
      const res = await fetch(`${worker.origin}/sql?do=unloaded&codec=${codec}`, { method: 'POST', body: JSON.stringify({ sql: 'SELECT 1' }) })
      assert.equal(res.status, 500)
      assert.match(await res.text(), /no complete data directory/)
    })
    await t.step('boots with no runtime wasm compilation', async () => {
      await worker.restart()
      const probe = await call('/probe', 'seeded')
      assert.match(probe.runtimeCompile, /disallowed by embedder/)
      assert.equal(probe.webAssemblyFunction, 'undefined')
      assert.deepEqual(await rows('SELECT 1 AS one'), [{ one: 1 }])
    })
    await t.step('an open directory refuses an import', async () => {
      const res = await send('seeded')('dir?path=/x', { method: 'POST' })
      await res.body?.cancel()
      assert.equal(res.status, 409)
    })
    await t.step('a trigger restamps an UPDATE', async () => {
      const [before] = await rows("SELECT txid FROM team WHERE name = 'Flamengo-RJ'")
      const [after] = await rows("UPDATE team SET name = name WHERE name = 'Flamengo-RJ' RETURNING txid")
      assert.notEqual(after.txid, before.txid)
    })
    await t.step('a DO block runs', async () => {
      await rows('DO $$ BEGIN PERFORM 1; END $$')
    })
    await t.step('the snowball dictionaries load', async () => {
      const [{ v }] = await rows("SELECT to_tsvector('portuguese', 'goleadas históricas')::text v")
      assert.equal(v, "'gol':1 'histór':2")
    })
    await t.step('the root collation ignores accents and case', async () => {
      assert.deepEqual(await rows("SELECT name FROM team WHERE search_name = 'GREMIO-rs'"), [{ name: 'Grêmio-RS' }])
    })
    await t.step('recovery preserves committed pages and excludes rolled-back updates', async () => {
      await call('/exec', 'seeded', { method: 'POST', body: `
        CREATE TABLE recovery_probe (id integer PRIMARY KEY, value text NOT NULL);
        INSERT INTO recovery_probe SELECT n, md5(n::text) FROM generate_series(1, 5000) n;
      ` })
      await call('/exec', 'seeded', { method: 'POST', body: `
        BEGIN;
        UPDATE recovery_probe SET value = 'uncommitted';
        ROLLBACK;
      ` })
      await worker.restart()
      assert.deepEqual(await rows('SELECT count(*)::int AS n, bool_and(value = md5(id::text)) AS intact FROM recovery_probe'), [{ n: 5000, intact: true }])
    })
    await t.step('no timer is pending once a request completes', async () => {
      await rows('SELECT count(*) FROM team a CROSS JOIN team b')
      assert.deepEqual(await idleTimers(), [])
    })
    await t.step('nor after the boot that follows an eviction', async () => {
      await worker.restart()
      await rows('SELECT count(*) FROM team')
      // Crash recovery's startup-progress timer fires every 10 s.
      await delay(10_000)
      assert.deepEqual(await idleTimers(), [])
    })
    await t.step('/abort resets the object, and the next request boots it again', async () => {
      const before = (await call('/state', 'seeded')).bornAt
      const res = await fetch(`${worker.origin}/abort?do=seeded&codec=${codec}`, { method: 'POST' })
      await res.body?.cancel()
      assert.ok(!res.ok)
      const after = await call('/state', 'seeded')
      assert.notEqual(after.bornAt, before)
      assert.equal(after.open, false)
      assert.deepEqual(await rows('SELECT count(*)::int AS n FROM team'), [{ n: 3 }])
      assert.deepEqual(await idleTimers(), [])
    })
    await t.step('a schema applies inside the object', async () => {
      await call('/exec', 'fresh', { method: 'POST', body: await Deno.readTextFile(fixture) })
      assert.deepEqual(await rows("SELECT name FROM team WHERE search_name = 'atletico-mg'", 'fresh'), [{ name: 'Atlético-MG' }])
      assert.deepEqual(await idleTimers('fresh'), [])
    })
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
