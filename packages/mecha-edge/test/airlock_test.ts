import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'
import { STUB_PORT } from './airlock-effects.ts'
import { seal, sealLabel } from '../../../services/airlock/seal.ts'

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
  const pins = new Map<string, unknown>()
  const stub = Deno.serve({ port: STUB_PORT, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const [, , mode, id] = new URL(req.url).pathname.split('/')
    hits.set(id, (hits.get(id) ?? 0) + 1)
    if (mode === 'pin') {
      const { pin } = await req.json() as { pin: string }
      pins.set(id, pin)
      return Response.json({ accepted: true })
    }
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
    await db.exec(await sql('airlock/job_key.sql'))
    await db.exec(`CREATE TABLE effect_row (id text PRIMARY KEY, status text NOT NULL, pin text CHECK (pin IS NULL));
      CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;
      GRANT SELECT, INSERT, UPDATE ON effect_row TO app_user;
      CREATE TABLE settled_seen (settled int NOT NULL);
      GRANT SELECT ON effect_row TO service; GRANT ALL ON settled_seen TO service;
      CREATE FUNCTION see_settled() RETURNS integer LANGUAGE sql AS $$
        INSERT INTO settled_seen SELECT count(*) FROM effect_row WHERE status <> 'running' RETURNING 1 $$;
      -- A write that enqueues its own effect at its commit, as an interpreter's does.
      CREATE FUNCTION enqueue_pinned() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('pinned:' || NEW.id, 'pinned', jsonb_build_object('id', NEW.id), jsonb_build_object('id', NEW.id, 'mode', 'pin'));
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'pinned:' || NEW.id), job_key => 'pinned:' || NEW.id);
        NEW.status := 'running';
        RETURN NEW;
      END $$;
      CREATE TRIGGER enqueue_pinned BEFORE INSERT ON effect_row FOR EACH ROW WHEN (NEW.status = 'enqueue') EXECUTE FUNCTION enqueue_pinned();
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
    // A reader's session, as the page's: the edge's crud answers sessions alone.
    const { token } = await (await fetch(at('/auth/guest'), { method: 'POST' })).json() as { token: string }
    const crud = (method: string, path: string, body?: unknown) => fetch(at(path), {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

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

    // A secret field: the page's write carries it sealed, the object keeps it
    // in memory alone, the dispatcher opens it for the handler, and the
    // database never holds even its ciphertext.
    const published = await (await crud('GET', '/crud/airlock_seal?select=kid,key')).json() as { kid: string; key: JsonWebKey }[]
    assert.equal(published.length, 1)
    const sealFor = (id: string, pin: string) => seal(published[0].key, pin, sealLabel('effect_row', 'pin', id))
    const written = await crud('POST', '/crud/effect_row', { id: 's1', status: 'pending', pin: await sealFor('s1', '4321') })
    assert.equal(written.status, 201, await written.clone().text())
    assert.equal((await written.json() as { pin: unknown }[])[0].pin, null)
    await claim('s1', 'pinned', 'pin')
    assert.deepEqual(await until('s1 settles', () => row('s1'), (r) => r?.status !== 'running'), { status: 'done', entered: 1, kind: 'done', data: { accepted: true } })
    assert.equal(pins.get('s1'), '4321')
    const held = await (await fetch(at('/effect/held'))).json() as { held: string; pins: number }
    assert.equal(held.pins, 0)
    assert.equal(held.held.includes('4321') || held.held.includes('seal1.'), false, held.held)
    // A value in the clear is refused at the door, and not repeated.
    const clear = await crud('PATCH', '/crud/effect_row?id=eq.s1', { pin: '4321' })
    assert.equal(clear.status, 400)
    assert.equal((await clear.text()).includes('4321'), false)
    // One write offering a row twice, a value or not, keeps neither.
    for (const first of [null, await sealFor('s3', '1111')]) {
      const twice = await crud('POST', '/crud/effect_row', [{ id: 's3', status: 'pending', pin: first }, { id: 's3', status: 'pending', pin: await sealFor('s3', '2222') }])
      assert.equal(twice.status, 400)
      await twice.body?.cancel()
    }
    // Two effects naming the field of one row both receive it, and it is
    // gone once the second settles: a third, claimed after, finds none.
    const both = await crud('POST', '/crud/effect_row', { id: 's4', status: 'pending', pin: await sealFor('s4', '8642') })
    assert.equal(both.status, 201, await both.clone().text())
    await both.body?.cancel()
    await claim('s4', 'pinned', 'pin')
    await claim('s4', 'repinned', 'pin')
    type Settled = { kind: string | null; data: unknown } | null
    const outcomeOf = (key: string) => until(`${key} settles`, async () => await (await fetch(at(`/effect/ledger?key=${key}`))).json() as Settled, (o) => o?.kind != null)
    assert.equal((await outcomeOf('pinned:s4'))?.kind, 'done')
    assert.equal((await outcomeOf('repinned:s4'))?.kind, 'done')
    assert.equal(hits.get('s4'), 2, 'both effects reached the sink with the value')
    assert.equal(pins.get('s4'), '8642')
    await claim('s4', 'latepin', 'pin')
    assert.deepEqual(await outcomeOf('latepin:s4'), { kind: 'failed', data: { secrets: ['pin'], reason: 'absent' } })
    // A text key that looks like a uuid is kept as it was written, so its
    // run finds its value.
    const upper = 'ABCDEFAB-1234-1234-1234-ABCDEFABCDEF'
    const shaped = await crud('POST', '/crud/effect_row', { id: upper, status: 'pending', pin: await sealFor(upper, '1357') })
    assert.equal(shaped.status, 201, await shaped.clone().text())
    await shaped.body?.cancel()
    await claim(upper, 'pinned', 'pin')
    assert.equal((await outcomeOf(`pinned:${upper}`))?.kind, 'done')
    assert.equal(pins.get(upper), '1357')
    // A write that enqueues its effect at its commit: the claim may reach the
    // object before the write's answer, and finds the value all the same.
    const enqueued = await crud('POST', '/crud/effect_row', { id: 's7', status: 'enqueue', pin: await sealFor('s7', '2468') })
    assert.equal(enqueued.status, 201, await enqueued.clone().text())
    await enqueued.body?.cancel()
    assert.equal((await outcomeOf('pinned:s7'))?.kind, 'done')
    assert.equal(pins.get('s7'), '2468')
    // A PATCH that asks for no representation keeps the value for the row it
    // reached, counted rather than read back; one that reached none keeps nothing.
    const minimal = (id: string, body: unknown) => fetch(at(`/crud/effect_row?id=eq.${id}`), {
      method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(body),
    })
    const made = await crud('POST', '/crud/effect_row', { id: 's5', status: 'pending' })
    await made.body?.cancel()
    const reached = await minimal('s5', { pin: await sealFor('s5', '9753') })
    assert.deepEqual([reached.status, await reached.text()], [204, ''])
    await claim('s5', 'pinned', 'pin')
    assert.equal((await outcomeOf('pinned:s5'))?.kind, 'done')
    assert.equal(pins.get('s5'), '9753')
    const missed = await minimal('s6', { pin: await sealFor('s6', '8642') })
    assert.equal(missed.status, 204)
    await missed.body?.cancel()
    await claim('s6', 'pinned', 'pin')
    assert.deepEqual(await outcomeOf('pinned:s6'), { kind: 'failed', data: { secrets: ['pin'], reason: 'absent' } })
    // A POST that asks for no representation, or names no preference, keeps
    // its value for the row it wrote all the same.
    for (const [id, prefer] of [['s8', 'return=minimal'], ['s9', undefined]] as const) {
      const posted = await fetch(at('/crud/effect_row'), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) },
        body: JSON.stringify({ id, status: 'pending', pin: await sealFor(id, `pin-${id}`) }),
      })
      assert.equal(posted.status, 201, await posted.clone().text())
      await posted.body?.cancel()
      await claim(id, 'pinned', 'pin')
      assert.equal((await outcomeOf(`pinned:${id}`))?.kind, 'done', id)
      assert.equal(pins.get(id), `pin-${id}`)
    }
    // One the object does not hold, as after an eviction, fails the first run.
    await claim('s2', 'pinned', 'pin')
    assert.deepEqual(await until('s2 settles', () => row('s2'), (r) => r?.status !== 'running'), { status: 'failed', entered: 1, kind: 'failed', data: { secrets: ['pin'], reason: 'absent' } })
    assert.equal(pins.has('s2'), false)
  } finally {
    await worker.stop()
    await stub.shutdown()
  }
})
