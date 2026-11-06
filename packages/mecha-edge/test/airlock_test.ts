import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'
import { STUB_PORT } from './airlock-effects.ts'

const sql = (file: string) => Deno.readTextFile(new URL(`../../../services/${file}`, import.meta.url))

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) throw new Error(`${what}: still ${JSON.stringify(value)} after ${ms}ms`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// The object and the dispatcher as two Workers on one local queue, the way a
// release deploys them: the object answers while an effect is in flight, the
// effect runs in the dispatcher, and its answer settles the machine.
Deno.test({ name: 'edge effects run in the dispatcher Worker and settle in the object', sanitizeResources: false, sanitizeOps: false }, async () => {
  const hits = new Map<string, number>()
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const stub = Deno.serve({ port: STUB_PORT, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const [, , mode, id] = new URL(req.url).pathname.split('/')
    hits.set(id, (hits.get(id) ?? 0) + 1)
    if (mode === 'slow') await held
    if (mode === 'error') return new Response('upstream down', { status: 500 })
    return Response.json({ answered: id })
  })
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-airlock-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec(await sql('durex/graphile.sql'))
    await db.exec(`${await sql('ticker/schedule.sql')}\n${await sql('airlock/airlock.sql')}`)
    await db.exec(`CREATE TABLE effect_row (id text PRIMARY KEY, status text NOT NULL);
      CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;
      CREATE TABLE settled_seen (settled int NOT NULL);
      GRANT SELECT ON effect_row TO service; GRANT ALL ON settled_seen TO service;
      CREATE FUNCTION see_settled() RETURNS integer LANGUAGE sql AS $$
        INSERT INTO settled_seen SELECT count(*) FROM effect_row WHERE status <> 'running' RETURNING 1 $$;
      CHECKPOINT`)
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('airlock-wrangler.jsonc', import.meta.url), `${tmp}/state`, [new URL('airlock-dispatcher-wrangler.jsonc', import.meta.url)])
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const claim = async (id: string, effect: string, mode: string) => {
      const res = await fetch(at('/effect'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, effect, mode }) })
      assert.equal(res.status, 201, await res.text())
    }
    type Row = { status: string; entered: number; kind: string | null; data: unknown } | null
    const row = async (id: string) => await (await fetch(at(`/effect/${id}`))).json() as Row

    // The object returns at once and keeps answering while the run is held
    // in the dispatcher; the release settles it.
    const started = Date.now()
    await claim('a', 'stub', 'slow')
    assert.ok(Date.now() - started < 5_000, 'the claim does not wait on the effect')
    await until('the dispatcher reaches the stub', async () => hits.get('a') ?? 0, (n) => n === 1)
    assert.deepEqual(await row('a'), { status: 'running', entered: 1, kind: null, data: null })
    release()
    assert.deepEqual(await until('a settles', () => row('a'), (r) => r?.status !== 'running'), { status: 'done', entered: 1, kind: 'done', data: { answered: 'a' } })
    // An answer settled in an object booted by the effect calls alone, which
    // never installed its drains: the settle's write woke nothing.
    await until("a's settle reaches the drain", async () => ((await (await fetch(at('/effect/seen'))).json()) as { settled: number }).settled, (n) => n >= 1)

    // An error schedules the next run after a backoff; the last one settles unknown.
    await claim('b', 'stub', 'error')
    assert.deepEqual(await until('b runs out of attempts', () => row('b'), (r) => r?.status !== 'running'), { status: 'failed', entered: 3, kind: 'unknown', data: null })
    assert.equal(hits.get('b'), 3)

    await claim('c', 'once', 'error')
    assert.deepEqual(await until('c settles', () => row('c'), (r) => r?.status !== 'running'), { status: 'failed', entered: 1, kind: 'unknown', data: null })

    // A bridge not deployed here settles failed in the object, with no run.
    await claim('d', 'bridged', 'ok')
    assert.deepEqual(await until('d settles', () => row('d'), (r) => r?.status !== 'running'), {
      status: 'failed', entered: 0, kind: 'failed', data: { bridge: 'fixture', target: 'cloudflare', reason: 'not deployed' },
    })
    assert.equal(hits.get('d'), undefined)
  } finally {
    await worker.stop()
    await stub.shutdown()
  }
})
