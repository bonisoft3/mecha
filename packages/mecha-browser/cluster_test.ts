// The page's shape server against the protocol Electric's client parses: a
// value is Postgres's text for it. Sent typed, a boolean `true` met the
// client's `v === "true" || v === "t"` and read as false, so a page filtering
// on `featured=is.true` showed nothing.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createDatabase } from './src/database.ts'
import { isVisibleInSnapshot, ShapeStream } from '@electric-sql/client'
import { type Cluster, createCluster } from './cluster.ts'

const rls = await Deno.readTextFile(new URL('../../services/database/rls/rls.sql', import.meta.url))
const schema = `
  CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
  CREATE TABLE flag (
    id uuid PRIMARY KEY, featured boolean NOT NULL, n int, tags text[], meta jsonb, note text,
    scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
  );
  INSERT INTO flag (id, featured, n, tags, meta) VALUES ('00000000-0000-4000-8000-000000000001', true, 3, '{a,b}', '{"k": 1}');
`

Deno.test('request views boot without shapes while physical server sources still invalidate live reads', async () => {
  const db = await PGlite.create()
  try {
    const cluster = await createCluster({
      db, sql: [rls, schema, `
        CREATE ROLE app_user;
        CREATE VIEW flag_read WITH (security_invoker=true) AS SELECT * FROM flag;
        GRANT SELECT ON flag, flag_read TO app_user;
      `], tables: ['flag', 'flag_read'],
      schema: { flag: { durability: 'server' }, flag_read: { durability: 'server' } },
      log: console.error, fail: (e) => { throw e },
    })
    const read = () => cluster.handle(new Request('http://cluster.local/crud/flag_read?select=n'))
    assert.deepEqual(await (await read()).json(), [{ n: 3 }])
    await db.query('UPDATE flag SET n = 4')
    assert.deepEqual(await (await read()).json(), [{ n: 4 }])
    const shape = await cluster.handle(new Request('http://cluster.local/electric/v1/shape?table=flag&offset=-1'))
    assert.equal(shape.status, 200)
    const unsupported = await cluster.handle(new Request('http://cluster.local/electric/v1/shape?table=flag_read&offset=-1'))
    assert.equal(unsupported.status, 400)
    assert.deepEqual((await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'flag_read'::regclass")).rows, [])
  } finally {
    await db.close()
  }
})

Deno.test('a live view still fails the shape primary-key contract', async () => {
  const db = await PGlite.create()
  try {
    await assert.rejects(() => createCluster({
      db, sql: [rls, schema, 'CREATE VIEW flag_read AS SELECT * FROM flag'], tables: ['flag_read'],
      schema: { flag_read: { durability: 'live' } }, log: console.error, fail: (e) => { throw e },
    }), /flag_read carries a shape and has no primary key/)
  } finally {
    await db.close()
  }
})

Deno.test('a shape answers every value as Postgres text, in its snapshot and in its log', async () => {
  const db = await PGlite.create()
  const cluster = await createCluster({ db, sql: [rls, schema], tables: ['flag'], log: console.error, fail: (e) => { throw e } })
  const shape = (q: string) => cluster.handle(new Request(`http://cluster.local/electric/v1/shape?table=flag&${q}`))

  const first = await shape('offset=-1')
  const snapshot = (await first.json()) as { value?: Record<string, unknown> }[]
  assert.deepEqual(snapshot[0].value, {
    id: '00000000-0000-4000-8000-000000000001', featured: 'true', n: '3', tags: '{a,b}', meta: '{"k": 1}', note: null, scope_id: 'public:',
  })

  await db.query(`UPDATE flag SET featured = false, n = NULL`)
  // The notification is read back in a queued task.
  await new Promise((r) => setTimeout(r, 50))
  const next = await shape(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`)
  const log = (await next.json()) as { value?: Record<string, unknown> }[]
  assert.equal(log[0].value?.featured, 'false')
  assert.equal(log[0].value?.n, null)
  await db.close()
})

// A collection synced on demand opens its shape from now and loads each view's
// rows as a subset snapshot, which the stack's Electric serves and the page's
// cluster has to serve the same way, or the page's views stay empty.
const scoped = `
  CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
  CREATE TABLE item (
    id int PRIMARY KEY, game int NOT NULL, hidden boolean NOT NULL DEFAULT false,
    amount numeric, ratio float8,
    txid bigint NOT NULL DEFAULT txid_current(),
    scope_id text GENERATED ALWAYS AS (CASE WHEN hidden THEN 'nobody:' ELSE 'public:' END) STORED NOT NULL
  );
  INSERT INTO item (id, game, hidden) VALUES (1, 7, false), (2, 7, true), (3, 8, false);
  UPDATE item SET amount = 1e400 WHERE id = 2;
`
type Msg = { key?: string; value?: Record<string, unknown>; headers: Record<string, unknown> }

/** A cluster over `scoped`, and a shape request of its item table. */
async function scopedCluster(fail: (e: Error) => void = (e) => { throw e }, log: (line: string) => void = console.error) {
  const db = await PGlite.create()
  const cluster = await createCluster({ db, sql: [rls, scoped], tables: ['item'], log, fail })
  const get = (q: string) => cluster.handle(new Request(`http://cluster.local/electric/v1/shape?table=item&${q}`))
  return { db, cluster, get }
}

/** A subset's parameters, as a query. */
const subset = (where: string, params?: string) =>
  `subset__where=${encodeURIComponent(where)}${params === undefined ? '' : `&subset__params=${encodeURIComponent(params)}`}`

/** The ids a subset answered. */
const ids = async (res: Response) => ((await res.json()) as { data: Msg[] }).data.map((m) => m.value?.id)

/** A real ShapeStream of item from now, up to date, whose live requests wait
 * until `open()`, so a write can land between its position and a snapshot. */
async function gatedStream(cluster: Cluster) {
  let open: () => void = () => {}
  const gate = new Promise<void>((r) => (open = r))
  const fetchClient = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (new URL(url).searchParams.get('live') === 'true') {
      await Promise.race([gate, new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))])
    }
    return cluster.handle(new Request(url, init))
  }
  const stream = new ShapeStream<Record<string, unknown>>({
    url: 'http://cluster.local/electric/v1/shape', params: { table: 'item', replica: 'full' }, log: 'changes_only', offset: 'now', fetchClient,
  })
  const seen: Msg[] = []
  stream.subscribe((ms) => { for (const m of ms as Msg[]) if (m.key) seen.push(m) })
  while (!stream.isUpToDate) await new Promise((r) => setTimeout(r, 10))
  return { stream, seen, open }
}

// Regression: the cluster answered a refused subset `{message}` or `{error}`,
// and the store counts a 400 a refusal only when `errors.subset` names it, as
// Electric's does: every predicate a program stated wrong was retried forever
// under the browser tier, its read never settled and its region stayed
// loading, where the stack raises a ProgramError naming the table.
async function refused(res: Response, what: string): Promise<string> {
  assert.equal(res.status, 400, what)
  const body = (await res.json()) as { errors?: { subset?: Record<string, string[]> } }
  const named = Object.values(body.errors?.subset ?? {}).flat()
  assert.equal(named.length, 1, `${what}: ${JSON.stringify(body)}`)
  return named[0]
}

Deno.test('a subset is the rows both the scope and its predicate admit, with the snapshot they were read in', async () => {
  const { db, get } = await scopedCluster()

  const now = await get('offset=now&log=changes_only&replica=full')
  assert.deepEqual(await now.json(), [{ headers: { control: 'up-to-date', global_last_seen_lsn: '0' } }])
  assert.equal(now.headers.get('electric-offset'), '0_0')
  assert.ok(now.headers.get('electric-schema'))

  const res = await get(`log=changes_only&${subset('"game" = $1', '{"1":"7"}')}`)
  const { metadata, data } = (await res.json()) as { metadata: Record<string, unknown>; data: Msg[] }
  assert.deepEqual(data.map((m) => m.value?.id), ['1'])
  assert.equal(metadata.database_lsn, '1')
  assert.deepEqual(Object.keys(metadata).sort(), ['database_lsn', 'snapshot_mark', 'xip_list', 'xmax', 'xmin'])

  const ordered = await get(`subset__order_by=${encodeURIComponent('"id" DESC')}&subset__limit=1`)
  assert.deepEqual(await ids(ordered), ['3'])
  // The compiler's forms that name no column: `true = true` is every subset
  // with no filter, and a boolean comparison folds to a bare TRUE or FALSE.
  // A grammar of column comparisons alone refused them, and the store raised
  // every unfiltered view's read as a ProgramError.
  for (const [where, want] of [['true = true', ['1', '3']], ['true', ['1', '3']], ['false', []]] as const) {
    const res = await get(subset(where))
    assert.equal(res.status, 200, where)
    assert.deepEqual((await ids(res)).sort(), want, where)
  }
  // Refused as Electric refuses them: what the gate does not admit, and a
  // predicate Postgres cannot read, which a 500 would have the client retry.
  await refused(await get('subset__offset=1'), 'subset__offset')
  // Regression: a repeated subset parameter was read at its first value,
  // where Electric reads its last and the stack's gate refuses it.
  await refused(await get('subset__where=true&subset__where=false'), 'a repeated subset__where')
  await refused(await get('subset__limit=1&subset__limit=2'), 'a repeated subset__limit')
  assert.equal((await get('offset=now&replica=default')).status, 400)
  assert.match(await refused(await get(subset('"nope" = $1', '{"1":"1"}')), 'a column it lacks'), /nope/)
  await refused(await get(subset('"game" = $1', '{"1":"x"}')), 'a literal its column cannot hold')
  await refused(await get('subset__limit=-1'), 'subset__limit')
  await refused(await get('subset__limit=1&offset=x_1'), 'offset')
  // Regression: the predicate was spliced into SQL as it came, so a
  // parenthesis closed early ORed rows past the shape's reach onto it (row 2
  // is in no scope), and a subquery or a function ran as the superuser. A
  // quoted name is a column only until a `(` follows it: `"pg_sleep"(0)`
  // passed the grammar and slept, and `"query_to_xml"` ran a SELECT over any
  // table. A cast, arithmetic, or a LIKE pattern raises an error a row's
  // value decides, on rows outside the reach as well.
  for (const where of [
    'true) OR (true', '"id" IN (SELECT "id" FROM app_user)', 'EXISTS (SELECT 1)', 'pg_sleep(1) IS NULL', "'a' || current_user",
    '"pg_sleep"(0) IS NULL', `"query_to_xml"('select 1', TRUE, FALSE, '') IS NOT NULL`, `LENGTH("query_to_xml" ('select 1', TRUE, FALSE, '')) > 0`,
    '"game"::int4 > 0', '"game" + 1 > 0', `$1 LIKE "id"`, '"game" LIKE', '($1)(1)', `UPPER("scope_id") = 'PUBLIC:'`,
  ]) {
    await refused(await get(subset(where)), where)
  }
  // Regression: the grammar admitted a column compared with a column, which
  // Postgres casts on every row it evaluates when the two are different
  // numeric types: `"amount" = "ratio"` raises `out of range for type double
  // precision` on row 2 (amount 1e400, in no scope) whenever the planner runs
  // it before the scope. A typed literal picks the type the column is cast to
  // the same way: `"amount" = "float8" '1'` raises on row 2 where
  // `"amount" = 1.5` reads none. A comparison is a column against a $n or a
  // literal, whose type Postgres infers from the column.
  for (const where of ['"amount" = "ratio"', `"amount" = "float8" '1'`, '"game" = "id"', `"game" = "int4" '7'`, '"game" = ANY("id")', '"game" = $1 $1']) {
    assert.match(await refused(await get(subset(where, where.includes('$') ? '{"1":"7"}' : undefined)), where), /is not a predicate a subset may state/)
  }
  await assert.rejects(db.query(`SELECT id FROM item WHERE amount = "float8" '1'`), /out of range for type double precision/)
  assert.deepEqual((await db.query(`SELECT id FROM item WHERE amount = 1.5`)).rows, [])
  for (const order of ['(SELECT 1)', '"id" DESC; DROP TABLE item', 'random()']) {
    await refused(await get(`subset__order_by=${encodeURIComponent(order)}`), order)
  }
  assert.deepEqual(await ids(await get(subset('"game" = $1 AND ("id" = $2 OR NOT ("hidden" IS NULL))', '{"1":"7","2":"2"}'))), ['1'])
  assert.deepEqual(await ids(await get(subset(`"game" = 8 AND "hidden" = 'f'`))), ['3'])
  assert.deepEqual((await ids(await get(subset('"game" = ANY($1)', '{"1":"{7,8}"}')))).sort(), ['1', '3'])
  // Regression: a LIKE pattern ending in its escape raised only once a row's
  // value matched what came before it, so `pub\` answered 400 where `zzz\`
  // answered 200. A pattern is no predicate a subset states, so both are
  // refused before any row is read.
  for (const pattern of ['pub\\', 'zzz\\']) {
    assert.match(await refused(await get(subset('"scope_id" LIKE $1', JSON.stringify({ 1: pattern }))), pattern), /is not a predicate a subset may state/)
  }
  // Regression: the params were bound in key order, and the client leaves a
  // null out of them, so {"1","3"} bound $1 and $2 and left $3 unbound: the
  // query failed, or a later $n filtered on an earlier value.
  const gap = await get(subset('"game" = $1 OR "id" = $2 OR "game" = $3', '{"1":"7","3":"8"}'))
  assert.equal(gap.status, 200)
  assert.deepEqual((await ids(gap)).sort(), ['1', '3'])
  for (const params of ['{"4":"7"}', '{"1":7}', '[7]']) {
    await refused(await get(subset('"game" = $1', params)), params)
  }
  // Regression: every failure of the subset's query was a 400, which the
  // store takes for a predicate it stated wrong and never retries. Only one
  // Postgres refuses is; the rest is the server's.
  const query = db.query.bind(db)
  db.query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes(' AND (')) throw Object.assign(new Error('the page ran out of memory'), { code: '53200' })
    return await query(sql, params)
  }) as typeof db.query
  assert.equal((await get(subset('"game" = $1', '{"1":"7"}'))).status, 500)
  db.query = query
  await db.close()
})

Deno.test("a real ShapeStream merges a late subset with the changes around it, each change once", async () => {
  const { db, cluster } = await scopedCluster()
  const { stream, seen, open } = await gatedStream(cluster)

  // Written before the snapshot: in it, and never delivered a second time.
  await db.query('UPDATE item SET game = 7 WHERE id = 3')
  await new Promise((r) => setTimeout(r, 50))
  const { metadata, data } = await stream.requestSnapshot({ where: '"game" = $1', params: { '1': '7' } })
  assert.deepEqual(data.map((m) => m.value.id).sort(), [1, 3])
  assert.ok(isVisibleInSnapshot(Number((await db.query<{ t: string }>('SELECT xmin::text AS t FROM item WHERE id = 3')).rows[0].t), metadata))

  // Written after it: delivered, and judged by no snapshot.
  await db.query('UPDATE item SET game = 9 WHERE id = 1')
  open()
  for (let i = 0; i < 100 && !seen.some((m) => m.headers.operation === 'update'); i++) await new Promise((r) => setTimeout(r, 20))
  const ops = seen.map((m) => `${m.headers.operation} ${m.value?.id}`)
  assert.deepEqual(ops, ['insert 1', 'insert 3', 'update 1'])
  stream.unsubscribeAll()
  await db.close()
})

// A write is confirmed by its transaction: the CRUD response names it and its
// changes carry it, both as the 32-bit xid Electric reports. The row's own txid
// column is the 64-bit xid8 rows are ordered by, which differs from the xid
// once the epoch moves; a column holding an epoch-1 value shows no message
// reads it, so a page never awaits one domain against the other.
Deno.test('a write is named, and its changes carry, the 32-bit xid and never the row txid column', async () => {
  const epochOne = 2 ** 32
  const db = await PGlite.create()
  const cluster = await createCluster({
    db, sql: [rls, `
      CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
      CREATE TABLE note (id int PRIMARY KEY, body text, txid bigint NOT NULL, scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
      CREATE ROLE app_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON note TO app_user;
      INSERT INTO note (id, body, txid) VALUES (1, 'seeded', ${epochOne + 5});
    `], tables: ['note'], log: console.error, fail: (e) => { throw e },
  })
  const shape = (q: string) => cluster.handle(new Request(`http://cluster.local/electric/v1/shape?table=note&${q}`))
  const write = (method: string, query: string, body?: unknown) => cluster.handle(new Request(`http://cluster.local/crud/note${query}`, {
    method, headers: { 'content-type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const xmin = async (id: number) => Number((await db.query<{ x: string }>('SELECT xmin::text AS x FROM note WHERE id = $1', [id])).rows[0].x)

  const first = await shape('offset=-1')
  const snapshot = (await first.json()) as Msg[]
  assert.deepEqual(snapshot[0].headers.txids, [await xmin(1)])
  assert.equal(snapshot[0].value?.txid, String(epochOne + 5))

  const named: number[] = []
  for (const [method, query, body] of [['POST', '', { id: 2, body: 'written', txid: epochOne + 7 }], ['PATCH', '?id=eq.2', { body: 'edited' }], ['DELETE', '?id=eq.2', undefined]] as const) {
    const res = await write(method, query, body)
    assert.ok(res.ok, `${method} ${res.status}`)
    named.push(Number(res.headers.get('x-txid')))
  }
  assert.ok(named.every((t) => t > 0 && t < epochOne), `named ${named}`)
  await new Promise((r) => setTimeout(r, 50))
  const log = (await (await shape(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`)).json()) as Msg[]
  const changes = log.filter((m) => m.key)
  assert.deepEqual(changes.map((m) => [m.headers.operation, m.headers.txids]), [['insert', [named[0]]], ['update', [named[1]]], ['delete', [named[2]]]])
  assert.equal(changes[0].value?.txid, String(epochOne + 7))
  await db.close()
})

// Regression: a change is numbered as its notification arrives and filled when
// its row is read back. A read-back that threw left the entry unfilled and its
// rejection unhandled, and every read of the log stopped before it: a live
// request waited out its timeout and answered nothing, for good. Answered as a
// 500 instead, Electric's client retried it without end, and the page sat on
// stale rows with the cause on the console alone.
Deno.test('a change whose row cannot be read back fails the page, and every read of its table for good', async () => {
  const failed: Error[] = []
  const { db, cluster, get } = await scopedCluster((e) => failed.push(e))
  const first = await get('offset=-1')
  const at = `offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`
  await first.body?.cancel()
  const live = get(`${at}&live=true`)

  const query = db.query.bind(db)
  db.query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('json_object') && sql.includes('WHERE "id" = $1')) throw new Error('the row would not render')
    return await query(sql, params)
  }) as typeof db.query
  await query('UPDATE item SET game = 9 WHERE id = 1')
  const started = Date.now()
  const waited = await live
  assert.equal(waited.status, 410)
  assert.ok(Date.now() - started < 5_000, 'the live request was answered when the change failed, not at its timeout')
  assert.match(((await waited.json()) as { error: string }).error, /the row would not render/)
  await query('UPDATE item SET game = 8 WHERE id = 1')
  await new Promise((r) => setTimeout(r, 50))
  db.query = query
  assert.deepEqual(failed.map((e) => e.message), ['cluster lost a change to item: the row would not render'], 'the page is told once')

  // What Electric's client makes of it: a status it does not retry, which
  // stops the stream and fails a subset's read.
  const stream = new ShapeStream<Record<string, unknown>>({
    url: 'http://cluster.local/electric/v1/shape', params: { table: 'item' },
    fetchClient: (input: RequestInfo | URL, init?: RequestInit) => cluster.handle(new Request(String(input instanceof Request ? input.url : input), init)),
    onError: () => {},
  })
  const stopped = await new Promise<unknown>((resolve) => stream.subscribe(() => {}, resolve))
  assert.equal((stopped as { status?: number }).status, 410)
  stream.unsubscribeAll()
  await db.close()
})

// Regression: a change whose row was gone by its read-back left the log
// without waking the live requests waiting on that change, and each waited out
// its 20 s timeout to answer 204. A TRUNCATE in the change's transaction
// removes the row with no notification of its own to wake them.
Deno.test('a change whose row is gone by its read-back answers the live request at once', async () => {
  const { db, get } = await scopedCluster()
  const first = await get('offset=-1')
  const at = `offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`
  await first.body?.cancel()
  const live = get(`${at}&live=true`)
  await db.exec('BEGIN; UPDATE item SET game = 9 WHERE id = 1; TRUNCATE item; COMMIT;')
  const started = Date.now()
  const waited = await live
  assert.ok(Date.now() - started < 5_000, 'the live request was answered when the change dropped, not at its timeout')
  assert.equal(waited.status, 204)
  await db.close()
})

// Regression: a subset answered the log's tail as its position, and the client
// moves its stream to the position a subset answers. A change written while
// the stream's live request was in flight, to a row outside the subset, was
// then behind the stream and never delivered: the collection kept the stale
// row, and a write of this tab's own reverted on screen.
Deno.test('a subset leaves the stream where it was, so a change outside it still arrives', async () => {
  const { db, cluster } = await scopedCluster(undefined, () => {})
  const { stream, seen, open } = await gatedStream(cluster)

  // Row 3 is in game 8, outside the subset of game 7.
  await db.query('UPDATE item SET game = 9 WHERE id = 3')
  await new Promise((r) => setTimeout(r, 50))
  const { data } = await stream.requestSnapshot({ where: '"game" = $1', params: { '1': '7' } })
  assert.deepEqual(data.map((m) => m.value.id), [1])
  open()
  for (let i = 0; i < 100 && !seen.some((m) => m.headers.operation === 'update'); i++) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen.map((m) => `${m.headers.operation} ${m.value?.id} ${m.value?.game ?? ''}`), ['insert 1 7', 'update 3 9'])
  stream.unsubscribeAll()
  await db.close()
})

Deno.test('the browser database honors case and accent insensitive ICU collations by default', async () => {
  const db = await createDatabase({})
  try {
    await db.exec(`
      CREATE COLLATION search (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
      CREATE TABLE names (name text COLLATE search);
      INSERT INTO names VALUES ('Flamengo'), ('São Paulo'), ('Other');
    `)
    assert.deepEqual((await db.query("SELECT name FROM names WHERE name LIKE '%flamengo%' OR name LIKE '%sao%' ORDER BY name")).rows,
      [{ name: 'Flamengo' }, { name: 'São Paulo' }])
  } finally {
    await db.close()
  }
})
