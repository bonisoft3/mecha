// An app's drains in the object (mecha-browser's drains.ts): before them an
// edge release ran no drain at all, so a desk's queue was never applied and
// its boards held the rows the release was built with.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { recordScripts } from '../../pglite-workerd/scripts.ts'
import { seed } from './seed.ts'

// What the drains call, beside the fixture: a projection over the notes
// written as the service role, and a function that fails while `flaky_broken`
// says so and counts the calls that succeed: a failed one's count rolls back.
// The `later` drain's table and function, which a release may bring itself.
const LATER = `CREATE TABLE later (id int PRIMARY KEY); CREATE TABLE later_calls (at timestamptz NOT NULL DEFAULT now());
  GRANT ALL ON later, later_calls TO service;
  CREATE FUNCTION later_count() RETURNS integer LANGUAGE sql AS $$ INSERT INTO later_calls DEFAULT VALUES RETURNING 1 $$;`

async function withDrains(pgdata: string, later = true) {
  const db = await PGlite.create({ dataDir: pgdata })
  try {
    await db.exec(`CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;
      CREATE TABLE tally (label text PRIMARY KEY, n int NOT NULL, as_role text NOT NULL);
      CREATE TABLE flaky_calls (at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE flaky_broken (broken boolean NOT NULL); INSERT INTO flaky_broken VALUES (true);
      GRANT SELECT ON note TO service; GRANT ALL ON tally, flaky_calls, flaky_broken TO service;
      GRANT SELECT, UPDATE ON flaky_broken TO app_user;
      CREATE FUNCTION tally_notes(tag text) RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT pg_has_role(current_user, 'service', 'MEMBER') THEN RAISE EXCEPTION 'tally is the service role''s'; END IF;
        INSERT INTO tally SELECT tag, count(*), current_user FROM note
          ON CONFLICT (label) DO UPDATE SET n = excluded.n, as_role = excluded.as_role;
        RETURN 1;
      END $$;
      CREATE FUNCTION flaky() RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO flaky_calls DEFAULT VALUES;
        IF (SELECT broken FROM flaky_broken) THEN RAISE EXCEPTION 'flaky is broken'; END IF;
        RETURN 0;
      END $$;
      -- The fixture's own owner, so a note exists before the object listens.
      INSERT INTO app_user VALUES ('00000000-0000-4000-8000-000000000001', 'seeded');
      INSERT INTO note (owner, body) VALUES ('00000000-0000-4000-8000-000000000001', 'before the object');`)
    if (later) await db.exec(LATER)
    else await recordScripts(db, [{ name: '003_rls.sql', sql: await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)) }])
    await db.exec('CHECKPOINT')
  } finally {
    await db.close()
  }
}

type State = { alarm: number | null; tally: { label: string; n: number; as_role: string }[]; flaky: number; later: number }

Deno.test({ name: 'the object calls its drains at boot and on a write, as the service role, and a failure stands at the alarm', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-drains-' })
  await seed(`${tmp}/pgdata`)
  await withDrains(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('drains-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    const state = async () => await (await fetch(at('/test/state'))).json() as State
    const settled = async (until: (s: State) => boolean) => {
      for (let i = 0; i < 50; i++) {
        const s = await state()
        if (until(s)) return s
        await new Promise((r) => setTimeout(r, 200))
      }
      return await state()
    }
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })

    // The first request installs the drains: the note written before the
    // object listened is counted with no request naming its table.
    const { token } = await (await fetch(at('/auth/guest'), { method: 'POST' })).json() as { token: string }
    const booted = await settled((s) => s.tally.length > 0 && s.alarm !== null)
    assert.deepEqual(booted.tally, [{ label: 'notes', n: 1, as_role: 'service' }])
    // The failed call is retried at the alarm, which an evicted isolate keeps.
    assert.equal(booted.flaky, 0)
    assert.ok(booted.alarm !== null && booted.alarm > Date.now() + 20_000, `a failed drain's retry stands at the alarm: ${booted.alarm}`)

    const guest = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    // Mended, on a table it does not name: nothing calls it yet.
    const mended = await fetch(at('/crud/flaky_broken?broken=is.true'), { method: 'PATCH', headers: guest, body: JSON.stringify({ broken: false }) })
    assert.ok(mended.ok, await mended.text())
    const wrote = await fetch(at('/crud/note'), { method: 'POST', headers: guest, body: JSON.stringify({ body: 'a guest' }) })
    assert.equal(wrote.status, 201, await wrote.text())
    const counted = await settled((s) => s.tally[0]?.n === 2 && s.flaky > 0)
    assert.deepEqual(counted.tally, [{ label: 'notes', n: 2, as_role: 'service' }])
    // The note owed the failed drain too, called at once and not at its retry.
    assert.equal(counted.flaky, 1)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})

// The release's Worker reaches a kept directory before its migrations do:
// a boot that installed the drains then refused `/import/migrate` over a table
// only the migration creates, and the publish rolled every Worker back.
Deno.test({ name: 'a kept directory migrates before the drains naming its new table install', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-drains-migrate-' })
  await seed(`${tmp}/pgdata`)
  await withDrains(`${tmp}/pgdata`, false)
  const worker = await startWorker(new URL('drains-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const migrated = await fetch(at('/import/migrate'), {
      method: 'POST', headers: { authorization: 'Bearer test-import', 'content-type': 'application/json' },
      body: JSON.stringify([{ name: '010_later.sql', sql: LATER }]),
    })
    assert.equal(migrated.status, 200, await migrated.text())
    // The object ended after the migration; the next one's first request
    // installs the drains on the new schema and calls each, the new one too.
    assert.equal((await fetch(at('/auth/guest'), { method: 'POST' })).status, 200)
    for (let i = 0; i < 50; i++) {
      const res = await fetch(at('/test/state'))
      if (res.ok && (await res.json() as State).later > 0) return
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.fail('the drain over the migrated table was never called')
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
