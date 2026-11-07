import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createShapes, RETAINED } from './shapes.ts'

async function fixture(tables = ['item']) {
  const db = await PGlite.create()
  await db.exec("CREATE TABLE item(id integer PRIMARY KEY, value integer NOT NULL, scope_id text NOT NULL DEFAULT 'public:')")
  if (tables.includes('other')) await db.exec('CREATE TABLE other (LIKE item INCLUDING ALL)')
  let tail: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn)
    tail = result.then(() => {}, () => {})
    return result
  }
  const failures: Error[] = []
  const notifications: { op: string; table: string }[] = []
  let afterRead: (() => Promise<void>) | null = null
  const holdRead = () => {
    let release!: () => void
    let arrived!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { arrived = resolve })
    afterRead = () => { arrived(); return wait }
    return { ready, release }
  }
  const shapes = await createShapes({ db, tables, serialize,
    serializeLow: async fn => { const result = await serialize(fn); const pause = afterRead; afterRead = null; if (pause) await pause(); return result },
    fail: error => failures.push(error) })
  await db.listen('shape', payload => { notifications.push(JSON.parse(payload)) })
  const serve = (query = 'offset=-1', reach = () => Promise.resolve(['public:'])) => shapes.serve(new Request('http://shape/?table=item&' + query), reach)
  const write = async (sql: string) => { await serialize(() => db.exec(sql)); await serialize(async () => {}) }
  const close = async () => { await serialize(async () => {}); await db.close(); assert.deepEqual(failures, []) }
  return { db, shapes, serialize, serve, write, close, notifications, holdRead }
}
const position = (r: Response) => `offset=${r.headers.get('electric-offset')}&handle=${r.headers.get('electric-handle')}`
async function reset(response: Response) {
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), [{ headers: { control: 'must-refetch' } }])
}

for (const operation of ['INSERT', 'UPDATE', 'DELETE']) Deno.test(`bulk ${operation} emits one reset and the snapshot recovers`, async () => {
  const f = await fixture()
  try {
    if (operation !== 'INSERT') await f.write(`INSERT INTO item SELECT i,i FROM generate_series(1,${RETAINED + 1}) i`)
    const before = await f.serve('offset=now'); f.notifications.length = 0
    await f.write(operation === 'INSERT' ? `INSERT INTO item SELECT i,i FROM generate_series(1,${RETAINED + 1}) i` : operation === 'UPDATE' ? 'UPDATE item SET value=value+1' : 'DELETE FROM item')
    assert.deepEqual(f.notifications.map(x => x.op), ['RESET'])
    await reset(await f.serve(position(before)))
    const fresh = await f.serve()
    const rows = (await fresh.json() as { value?: unknown }[]).filter(x => x.value)
    assert.equal(rows.length, operation === 'DELETE' ? 0 : RETAINED + 1)
    assert.notEqual(fresh.headers.get('electric-handle'), before.headers.get('electric-handle'))
    f.notifications.length = 0
    await f.write('UPDATE item SET value=0 WHERE false; DELETE FROM item WHERE false; INSERT INTO item SELECT 0,0 WHERE false')
    assert.equal(f.notifications.length, 0)
    const caughtUp = await f.serve(position(fresh))
    assert.equal(caughtUp.status, 200)
    assert.deepEqual(await caughtUp.json(), [{ headers: { control: 'up-to-date', global_last_seen_lsn: '0' } }])
  } finally { await f.close() }
})

Deno.test('one transaction bounds many statements and discards queued pre-reset row reads', async () => {
  const f = await fixture()
  try {
    const before = await f.serve('offset=now')
    const query = f.db.query.bind(f.db)
    let reads = 0
    f.db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('WHERE "id" = $1')) reads++
      return query(sql, ...args as Parameters<typeof query> extends [string, ...infer R] ? R : never)
    }) as typeof f.db.query
    await f.write(`DO $$ BEGIN FOR i IN 1..${RETAINED + 50} LOOP INSERT INTO item VALUES(i,i); END LOOP; END $$`)
    assert.equal(f.notifications.length, RETAINED + 1)
    assert.equal(f.notifications.filter(x => x.op === 'RESET').length, 1)
    assert.equal(reads, 0, 'obsolete queued entries must not read or fill the new generation')
    await reset(await f.serve(position(before)))
    const fresh = await f.serve('offset=now')
    f.notifications.length = 0
    await f.write('UPDATE item SET value=42 WHERE id=1')
    const change = await f.serve(position(fresh))
    assert.equal(change.status, 200)
    const messages = await change.json() as { value?: { value: string }; headers: { operation?: string } }[]
    assert.equal(messages[0].headers.operation, 'update')
    assert.equal(messages[0].value?.value, '42')
    assert.equal(f.notifications.length, 1)
    assert.equal(reads, 1)
  } finally { await f.close() }
})

Deno.test('the notification budget is shared across tables in one transaction', async () => {
  const f = await fixture(['item', 'other'])
  try {
    const before = await f.serve('offset=now')
    const other = await f.shapes.serve(new Request('http://shape/?table=other&offset=now'), () => Promise.resolve(['public:']))
    const count = Math.floor(RETAINED * 0.6)
    await f.write(`BEGIN; INSERT INTO item SELECT i,i FROM generate_series(1,${count}) i;
      INSERT INTO other SELECT i,i FROM generate_series(1,${count}) i;
      UPDATE item SET value=value+1; COMMIT`)
    assert.equal(f.notifications.length, count + 2)
    assert.deepEqual(f.notifications.filter(x => x.op === 'RESET').map(x => x.table), ['other', 'item'])
    await reset(await f.serve(position(before)))
    await reset(await f.shapes.serve(new Request('http://shape/?table=other&' + position(other)), () => Promise.resolve(['public:'])))
  } finally { await f.close() }
})

Deno.test('rollback emits nothing, while truncate resets even an empty table', async () => {
  const f = await fixture()
  try {
    const before = await f.serve('offset=now')
    await f.write(`BEGIN; INSERT INTO item SELECT i,i FROM generate_series(1,${RETAINED + 1}) i; ROLLBACK`)
    assert.equal(f.notifications.length, 0)
    const caughtUp = await f.serve(position(before))
    assert.equal(caughtUp.status, 200)
    assert.deepEqual(await caughtUp.json(), [{ headers: { control: 'up-to-date', global_last_seen_lsn: '0' } }])
    await f.write('TRUNCATE item')
    await reset(await f.serve(position(before)))
    assert.deepEqual(f.notifications.map(x => x.op), ['RESET'])
  } finally { await f.close() }
})

Deno.test('reset wakes long polls and fences delayed scope and subset reads', async () => {
  const f = await fixture()
  try {
    const before = await f.serve('offset=now')
    const live = f.serve(position(before) + '&live=true')
    await f.write(`INSERT INTO item SELECT i,i FROM generate_series(1,${RETAINED + 1}) i`)
    await reset(await live)
    const fresh = await f.serve('offset=now')
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const subset = f.serve(position(fresh) + '&subset__where=true', async () => { await held; return ['public:'] })
    await f.write('TRUNCATE item')
    release()
    await reset(await subset)
    await reset(await f.serve(position(fresh) + '&subset__where=true'))
    const current = await f.serve('offset=now')
    await f.write('INSERT INTO item VALUES(1,1)')
    let resume!: () => void
    const deferred = new Promise<void>(resolve => { resume = resolve })
    const log = f.serve(position(current), async () => { await deferred; return ['public:'] })
    await f.write('TRUNCATE item')
    resume()
    await reset(await log)
  } finally { await f.close() }
})

Deno.test('a completed subset read cannot answer with its old generation after reset', async () => {
  const f = await fixture()
  try {
    await f.write('INSERT INTO item VALUES(1,1)')
    const before = await f.serve('offset=now')
    for (const query of [position(before) + '&subset__where=true', 'offset=-1']) {
      const gate = f.holdRead()
      const response = f.serve(query)
      await gate.ready
      await f.write('TRUNCATE item')
      gate.release()
      await reset(await response)
    }
  } finally { await f.close() }
})

for (const syncMode of ['on-demand', 'eager'] as const) Deno.test(`Electric ${syncMode} collection reloads and confirms bulk updates and deletes after reset`, async () => {
  const { createCollection, createLiveQueryCollection, eq } = await import('@tanstack/db')
  const { electricCollectionOptions } = await import('@tanstack/electric-db-collection')
  const f = await fixture()
  await f.write(`INSERT INTO item SELECT i,i FROM generate_series(1,${RETAINED + 1}) i`)
  const requests: URL[] = []
  const collection = createCollection(electricCollectionOptions({
    id: 'shape-reset-regression', getKey: (row: { id: number; value: number }) => row.id, syncMode,
    shapeOptions: {
      url: 'http://shape/', params: { table: 'item' },
      fetchClient: (input, init) => {
        const request = new Request(input, init)
        requests.push(new URL(request.url))
        return f.shapes.serve(request, () => Promise.resolve(['public:']))
      },
    },
  }))
  const view = createLiveQueryCollection({ query: q => q.from({ row: collection }).where(({ row }) => eq(row.id, 1)) })
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (condition()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('active collection did not recover after shape reset')
  }
  try {
    view.startSyncImmediate()
    await until(() => view.get(1)?.value === 1)
    const subsets = () => requests.filter(url => url.searchParams.has('subset__where')).length
    const before = subsets()
    const change = async (sql: string) => await f.serialize(async () => {
      await f.db.exec('BEGIN')
      await f.db.exec(sql)
      const txid = Number((await f.db.query<{ id: string }>('SELECT pg_current_xact_id()::xid::text AS id')).rows[0].id)
      await f.db.exec('COMMIT')
      return txid
    })
    const updated = await change('UPDATE item SET value=value+100')
    await collection.utils.awaitTxId(updated, 10_000)
    await until(() => view.get(1)?.value === 101)
    if (syncMode === 'on-demand') assert.ok(subsets() > before, 'existing demand must reload without recreating the collection')
    const deleted = await change('DELETE FROM item')
    await collection.utils.awaitTxId(deleted, 10_000)
    await until(() => view.size === 0)
  } finally {
    await view.cleanup()
    await collection.cleanup()
    await f.close()
  }
})

Deno.test('shape upgrades remove retired row and statement triggers with qualified relation names', async () => {
  const db = await PGlite.create()
  const notifications: string[] = []
  try {
    await db.exec(`CREATE TABLE kept(id integer PRIMARY KEY, scope_id text DEFAULT 'public:');
      CREATE TABLE retired(id integer PRIMARY KEY, scope_id text DEFAULT 'public:');
      CREATE SCHEMA "Archive"; CREATE TABLE "Archive".kept(LIKE kept INCLUDING ALL);
      CREATE VIEW retired_view AS SELECT * FROM retired;
      CREATE FUNCTION shape_notify() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_notify('shape','legacy'); RETURN NEW; END $$;
      CREATE TRIGGER shape_notify AFTER INSERT ON retired FOR EACH ROW EXECUTE FUNCTION shape_notify();
      CREATE TRIGGER shape_notify_insert AFTER INSERT ON "Archive".kept REFERENCING NEW TABLE AS shape_rows
        FOR EACH STATEMENT EXECUTE FUNCTION shape_notify();
      CREATE TRIGGER shape_notify INSTEAD OF INSERT ON retired_view FOR EACH ROW EXECUTE FUNCTION shape_notify();`)
    await db.listen('shape', payload => { notifications.push(payload) })
    await createShapes({ db, tables: ['kept', 'retired_view'], schema: { retired_view: { durability: 'server' } },
      serialize: fn => fn(), fail: error => { throw error } })
    await db.exec('INSERT INTO retired VALUES(1); INSERT INTO "Archive".kept VALUES(1); INSERT INTO retired_view VALUES(2)')
    assert.deepEqual(notifications, [])
    assert.deepEqual((await db.query('SELECT id FROM retired ORDER BY id')).rows, [{ id: 1 }, { id: 2 }])
    assert.deepEqual((await db.query(`SELECT n.nspname AS schema,c.relname AS relation,count(*)::integer AS triggers
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE t.tgfoid='shape_notify()'::regprocedure GROUP BY n.nspname,c.relname`)).rows,
    [{ schema: 'public', relation: 'kept', triggers: 4 }])
  } finally { await db.close() }
})

Deno.test('keyed shape filters initial snapshot, subset snapshot, and live changes by column predicate', async () => {
  const f = await fixture()
  try {
    await f.write("INSERT INTO item VALUES (1, 10, 'user:alice'), (2, 20, 'user:bob'), (3, 10, 'user:carol')")
    const key = { column: 'value', value: '10' }
    const snap = await f.shapes.serve(new Request('http://shape/?table=item&offset=-1'), () => Promise.resolve([]), key)
    const snapRows = (await snap.json() as { value?: { id: string } }[]).filter(x => x.value).map(x => x.value!.id)
    assert.deepEqual(snapRows, ['1', '3'])

    const sub = await f.shapes.serve(new Request('http://shape/?table=item&subset__where="id"%20%3D%203'), () => Promise.resolve([]), key)
    const subBody = await sub.json() as { data: { value: { id: string } }[] }
    assert.deepEqual(subBody.data.map(x => x.value.id), ['3'])

    await f.write("INSERT INTO item VALUES (4, 99, 'user:dave'), (5, 10, 'user:erin'); DELETE FROM item WHERE id = 1")
    const changes = await f.shapes.serve(new Request('http://shape/?table=item&' + position(snap)), () => Promise.resolve([]), key)
    const msgs = (await changes.json() as { value?: { id: string }; headers: { operation?: string } }[]).filter(x => x.value)
    assert.deepEqual(msgs.map(m => ({ op: m.headers.operation, id: m.value!.id })), [
      { op: 'insert', id: '5' },
      { op: 'delete', id: '1' },
    ])
  } finally { await f.close() }
})

// Regression: when the first change to a shape is an insert/update whose row
// is deleted before its read-back runs, splicing the superseded entry from
// `entries` advanced `entries[0].offset` past 1 without evicting anything for
// retention, causing a client at offset 0_0 to receive a false 409 must-refetch.
Deno.test('a row inserted and deleted before read-back does not expire a client at offset 0_0', async () => {
  const f = await fixture()
  try {
    const snap = await f.serve('offset=-1')
    assert.equal(snap.headers.get('electric-offset'), '0_0')
    await f.write("BEGIN; INSERT INTO item VALUES (1, 10, 'public:'); DELETE FROM item WHERE id = 1; COMMIT")
    const changes = await f.serve(position(snap))
    assert.equal(changes.status, 200)
    const msgs = (await changes.json() as { value?: { id: string }; headers: { operation?: string } }[]).filter(x => x.value)
    assert.deepEqual(msgs.map(m => ({ op: m.headers.operation, id: m.value!.id })), [
      { op: 'delete', id: '1' },
    ])
  } finally { await f.close() }
})

