// A page's drains and clock: what the container tier's drain stream and
// ticker do, over the one connection. Before these, a page and an edge object
// held their derived rows as the release found them: a desk's request filed in
// the page was never applied, and a midnight tick was a row nothing read.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { type Cluster, createCluster } from './cluster.ts'
import type { Drain } from './drains.ts'

const rls = await Deno.readTextFile(new URL('../../services/database/rls/rls.sql', import.meta.url))
const scheduleSql = await Deno.readTextFile(new URL('../../services/ticker/schedule.sql', import.meta.url))
const schema = `
  CREATE ROLE app_user; CREATE ROLE service NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO app_user, service;
  CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
  CREATE TABLE request (id int PRIMARY KEY, outcome text NOT NULL DEFAULT '', scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
  CREATE TABLE board (id int PRIMARY KEY, n int NOT NULL);
  CREATE TABLE calls (drain text, as_role text, claims text);
  GRANT SELECT, INSERT ON request TO app_user;
  GRANT ALL ON request, board, calls TO service;
  -- A queue drain as an app writes one: guarded on the service role, a batch
  -- of what is pending, and nothing written when there is none.
  CREATE FUNCTION apply(batch_size integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql AS $$
  DECLARE n integer;
  BEGIN
    IF NOT pg_has_role(current_user, 'service', 'MEMBER') THEN RAISE EXCEPTION 'apply is the service role''s'; END IF;
    INSERT INTO calls VALUES ('apply', current_user, current_setting('request.jwt.claims', true));
    UPDATE request SET outcome = 'done' WHERE id IN (SELECT id FROM request WHERE outcome = '' ORDER BY id LIMIT batch_size);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END $$;
  -- A projection recomputed whole, which names its sources and never its sink.
  CREATE FUNCTION project() RETURNS integer LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO calls VALUES ('project', current_user, NULL);
    DELETE FROM board;
    INSERT INTO board SELECT 1, count(*) FROM request WHERE outcome = 'done';
    RETURN 1;
  END $$;
  GRANT EXECUTE ON FUNCTION apply, project TO service;
`
const DRAINS: Drain[] = [
  { name: 'apply', on: ['request'], call: 'apply', body: { batch_size: 2 } },
  { name: 'project', on: ['request'], call: 'project', body: {} },
]

async function page(drains: Drain[], ...sql: string[]): Promise<{ db: PGlite; cluster: Cluster; lines: string[] }> {
  return await pageWith({ drains }, ...sql)
}
async function pageWith(opts: { drains: Drain[]; clock?: 'ticker' | 'disabled' }, ...sql: string[]): Promise<{ db: PGlite; cluster: Cluster; lines: string[] }> {
  const db = await PGlite.create()
  const lines: string[] = []
  const cluster = await createCluster({ db, sql: [rls, schema, ...sql], tables: ['request'], ...opts, log: (l) => lines.push(l), fail: (e) => { throw e } })
  return { db, cluster, lines }
}
const TICKS = `CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text);
  GRANT ALL ON tick TO service;`
const calls = async (db: PGlite) => (await db.query<{ drain: string }>('SELECT drain FROM calls')).rows.map((r) => r.drain)
const outcomes = async (db: PGlite) => (await db.query<{ outcome: string }>('SELECT outcome FROM request ORDER BY id')).rows.map((r) => r.outcome)

Deno.test('a queue left by the last isolate is drained at boot, a batch per settle until a call writes nothing', async () => {
  // Rows the page held before the cluster listened: the boot is the only wake.
  const { db, cluster } = await page(DRAINS, "INSERT INTO request (id) VALUES (1), (2), (3), (4), (5)")
  try {
    await cluster.drains.idle()
    assert.deepEqual(await outcomes(db), ['done', 'done', 'done', 'done', 'done'])
    // Three batches of two, then the call that found none and wrote nothing.
    assert.deepEqual((await calls(db)).filter((d) => d === 'apply').length, 4)
    assert.deepEqual((await db.query('SELECT n FROM board')).rows, [{ n: 5 }])
    const roles = (await db.query<{ as_role: string; claims: string }>("SELECT DISTINCT as_role, claims FROM calls WHERE drain = 'apply'")).rows
    assert.deepEqual(roles, [{ as_role: 'service', claims: '{"role":"service"}' }])
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test("a request's write wakes the drains on its table, and a burst is one call", async () => {
  const { db, cluster } = await page(DRAINS)
  try {
    await cluster.drains.idle()
    await db.exec('DELETE FROM calls')
    const token = (await (await cluster.handle(new Request('http://cluster.local/auth/guest', { method: 'POST' }))).json()).token
    for (const id of [10, 11]) {
      const res = await cluster.handle(new Request('http://cluster.local/crud/request', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id }),
      }))
      assert.equal(res.status, 201, await res.text())
    }
    await cluster.drains.idle()
    assert.deepEqual(await outcomes(db), ['done', 'done'])
    // One settle for both writes: apply takes the two, and its own writes owe
    // it once more, when it finds none and writes nothing. They owe project
    // too, which has not run yet in that pass and reads them when it does.
    assert.deepEqual(await calls(db), ['apply', 'project', 'apply'])
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test('a failed call leaves its queue, is logged, waits its backoff, and is called at once on the next change', async () => {
  const { db, cluster, lines } = await page(
    [{ name: 'apply', on: ['request'], call: 'apply', body: {} }],
    "CREATE OR REPLACE FUNCTION apply(batch_size integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'broken'; END $$",
    'INSERT INTO request (id) VALUES (1)',
  )
  try {
    const before = Date.now()
    await cluster.drains.idle()
    assert.deepEqual(await outcomes(db), [''])
    assert.match(lines.join('\n'), /drain apply failed \(1 in a row\): broken/)
    const retry = cluster.drains.retryAt()!
    assert.ok(retry >= before + 30_000 && retry <= Date.now() + 30_000, `retry at ${retry}`)

    await db.exec(`CREATE OR REPLACE FUNCTION apply(batch_size integer DEFAULT 50) RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN UPDATE request SET outcome = 'done' WHERE outcome = ''; RETURN 0; END $$;
      INSERT INTO request (id) VALUES (2)`)
    await cluster.drains.idle()
    assert.deepEqual(await outcomes(db), ['done', 'done'])
    assert.equal(cluster.drains.retryAt(), null)
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test("the page's clock writes an owed tick at boot, and the drain naming the tick table runs on it", async () => {
  const { db, cluster } = await page(
    [{ name: 'turn', on: ['tick'], call: 'turn', body: {} }],
    scheduleSql,
    `CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text);
     CREATE TABLE turned (tick uuid PRIMARY KEY);
     GRANT ALL ON tick, turned TO service;
     CREATE FUNCTION turn() RETURNS integer LANGUAGE sql AS $$
       INSERT INTO turned SELECT id FROM tick WHERE NOT late ON CONFLICT DO NOTHING RETURNING 1 $$;
     GRANT EXECUTE ON FUNCTION turn TO service;`,
    // A machine's deadline that came due while no page was open.
    `INSERT INTO schedule (name, due_at, emits_entity) VALUES ('deadline', now() - interval '10 seconds', 'tick')`,
  )
  try {
    await cluster.swept()
    await cluster.drains.idle()
    const ticks = (await db.query<{ caller: string; late: boolean }>('SELECT caller, late FROM tick')).rows
    assert.deepEqual(ticks, [{ caller: 'page', late: false }])
    assert.equal((await db.query('SELECT 1 FROM turned')).rows.length, 1)
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test('a drain whose function or argument is not a name is refused at boot', async () => {
  const db = await PGlite.create()
  try {
    await assert.rejects(() => createCluster({
      db, sql: [rls, schema], tables: [], log: () => {}, fail: (e) => { throw e },
      drains: [{ name: 'bad', on: ['request'], call: 'apply', body: { 'x); DROP TABLE request; --': 1 } }],
    }), /drain bad passes .* which is not an argument's name/)
    // A trigger reports `request`, never `public.request`.
    await assert.rejects(() => createCluster({
      db, sql: [], tables: [], log: () => {}, fail: (e) => { throw e },
      drains: [{ name: 'qualified', on: ['public.request'], call: 'apply', body: {} }],
    }), /drain qualified names public.request, which is not a table's name/)
  } finally {
    await db.close()
  }
})

Deno.test('stopping while a call runs ends the drains: no timer, call or failure outlives the database', async () => {
  // A call's own commit owes it again, and its pass used to arm a fresh settle
  // after stop, which then called into the closed database and logged a failure.
  const { db, cluster, lines } = await page(
    [{ name: 'slow', on: ['request'], call: 'slow', body: {} }],
    `CREATE FUNCTION slow() RETURNS integer LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_sleep(0.3); UPDATE request SET outcome = 'seen' WHERE outcome = ''; RETURN 1; END $$;
     GRANT EXECUTE ON FUNCTION slow TO service;`,
    'INSERT INTO request (id) VALUES (1)',
  )
  // Into the boot pass's call, then stop under it.
  await new Promise((r) => setTimeout(r, 1100))
  await cluster.stop()
  await db.close()
  await cluster.drains.idle()
  assert.deepEqual(lines, [])
})

Deno.test("a write does not sweep again what the last sweep left owed: it waits the backoff", async () => {
  // Without the held retry, every write read the failed schedule as owed now
  // and swept it again at once, so a failure under traffic never backed off.
  const { db, cluster, lines } = await page([], scheduleSql, TICKS,
    `INSERT INTO schedule (name, due_at, emits_entity) VALUES ('broken', now() - interval '1 second', 'missing')`)
  try {
    await cluster.swept()
    assert.equal(lines.filter((l) => /schedule broken failed/.test(l)).length, 1)
    const token = (await (await cluster.handle(new Request('http://cluster.local/auth/guest', { method: 'POST' }))).json()).token
    const res = await cluster.handle(new Request('http://cluster.local/crud/request', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1 }),
    }))
    assert.equal(res.status, 201, await res.text())
    await new Promise((r) => setTimeout(r, 200))
    await cluster.swept()
    assert.equal(lines.filter((l) => /schedule broken failed/.test(l)).length, 1)
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test("a frozen archive's page sweeps nothing over the schedules it keeps", async () => {
  const { db, cluster } = await pageWith({ drains: [], clock: 'disabled' }, scheduleSql, TICKS,
    `INSERT INTO schedule (name, due_at, emits_entity) VALUES ('deadline', now() - interval '10 seconds', 'tick')`)
  try {
    await cluster.swept()
    assert.deepEqual((await db.query('SELECT 1 FROM tick')).rows, [])
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test('a body value reaches a text argument as PostgREST passes it, and a truncate wakes the drain', async () => {
  // A bare 50 is an integer literal, and Postgres casts no integer argument
  // to text: the call failed on these tiers alone, every pass.
  const { db, cluster, lines } = await page(
    [{ name: 'note', on: ['request'], call: 'note', body: { label: 50 } }],
    `CREATE TABLE notes (label text); GRANT ALL ON notes TO service;
     CREATE FUNCTION note(label text) RETURNS integer LANGUAGE sql AS $$ INSERT INTO notes VALUES (label) RETURNING 1 $$;
     GRANT EXECUTE ON FUNCTION note TO service; GRANT TRUNCATE ON request TO service;`,
  )
  try {
    await cluster.drains.idle()
    assert.deepEqual(lines, [])
    assert.deepEqual((await db.query('SELECT label FROM notes')).rows, [{ label: '50' }])
    await db.exec('TRUNCATE request')
    await new Promise((r) => setTimeout(r, 50))
    await cluster.drains.idle()
    assert.equal((await db.query('SELECT 1 FROM notes')).rows.length, 2)
  } finally {
    await cluster.stop()
    await db.close()
  }
})

Deno.test('a table no drain names any more loses its triggers', async () => {
  // The edge's directory keeps a trigger across releases; one a release's
  // drains no longer name notified on every write with nothing listening.
  const db = await PGlite.create()
  try {
    const first = await createCluster({ db, sql: [rls, schema], tables: [], drains: DRAINS, log: () => {}, fail: (e) => { throw e } })
    await first.stop()
    const second = await createCluster({ db, sql: [], tables: [], drains: [], log: () => {}, fail: (e) => { throw e } })
    await second.stop()
    assert.deepEqual((await db.query("SELECT tgname FROM pg_trigger WHERE tgname LIKE 'drain_%'")).rows, [])
  } finally {
    await db.close()
  }
})

Deno.test('a deadline a write arms in the past after a clean sweep is swept at once', async () => {
  // A clean sweep held nothing; reading every write through its retry delayed
  // a deadline already past by the backoff.
  const { db, cluster } = await page([], scheduleSql, TICKS)
  try {
    await cluster.swept()
    await db.exec(`INSERT INTO schedule (name, due_at, emits_entity) VALUES ('late', now() - interval '1 second', 'tick')`)
    const token = (await (await cluster.handle(new Request('http://cluster.local/auth/guest', { method: 'POST' }))).json()).token
    assert.equal((await cluster.handle(new Request('http://cluster.local/crud/request', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 9 }),
    }))).status, 201)
    for (let i = 0; i < 20 && (await db.query('SELECT 1 FROM tick')).rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100))
      await cluster.swept()
    }
    assert.equal((await db.query('SELECT 1 FROM tick')).rows.length, 1)
  } finally {
    await cluster.stop()
    await db.close()
  }
})
