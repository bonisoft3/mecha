import assert from 'node:assert/strict'
import { fixture, host } from './duckdb-fixture.ts'
import { PagedQuery } from '../src/paged-query.ts'
import { PagedExecution } from '../src/paged-execution.ts'
import type { SnapshotProgram } from '../src/snapshot-program.ts'

Deno.test('query stages resume after a failed stage and reclaim intermediates only with the final result', async () => {
  const db = await fixture()
  const conn = db.connect()
  conn.query('CREATE TABLE control AS SELECT true AS fail')
  conn.close()
  const program: SnapshotProgram = { version: 'v1', reads: [], queries: { total: 'SELECT 2 AS value' },
    queryStages: { total: { stages: [
      { name: '__duckstream_total_0', sql: 'SELECT 1 AS value' },
      { name: '__duckstream_total_1', sql: "SELECT CASE WHEN control.fail THEN error('retry stage') ELSE value+1 END AS value FROM __duckstream_total_0,control" },
    ], sql: 'SELECT * FROM __duckstream_total_1' } }, spec: { name: 'total', file: 'total.js', to: ['sink'] } }
  const manifest = { id: 'capture', name: 'total', version: 'v1', revision: 1, tables: {} }
  let query = new PagedQuery(host(db), [program])
  query.initialize(manifest)
  assert.deepEqual(query.materialize('total'), { done: false })
  assert.deepEqual(query.progress().queries, [])
  assert.throws(() => query.materialize('total'), /retry stage/)
  const update = db.connect()
  assert.equal(update.query('SELECT count(*)::INTEGER AS n FROM __duckstream_total_0').toArray()[0].n, 1)
  update.query('UPDATE control SET fail=false')
  update.close()
  query = new PagedQuery(host(db), [program])
  assert.deepEqual(query.materialize('total'), { done: false })
  assert.deepEqual(query.materialize('total'), { done: true })
  assert.deepEqual(query.read('total').rows, [{ value: 2 }])
  assert.deepEqual(query.materialize('total'), { done: true })
  const check = db.connect()
  assert.equal(check.query("SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name LIKE '__duckstream_total_%'").toArray()[0].n, 0)
  check.close()
  db.reset()
})

Deno.test('a staged query cannot commit transaction control through its SQL', async () => {
  const db = await fixture()
  const program: SnapshotProgram = { version: 'v', reads: [], queries: { q: 'SELECT 1' },
    queryStages: { q: { sql: 'SELECT 1', stages: [{ name: '__duckstream_q_0', sql: 'SELECT 1; COMMIT' }] } },
    spec: { name: 'q', file: 'q.js', to: ['sink'] } }
  const query = new PagedQuery(host(db), [program])
  query.initialize({ id: 'q', name: 'q', version: 'v', revision: 1, tables: {} })
  assert.throws(() => query.materialize('q'), /requires one SELECT statement/)
  const check = db.connect()
  assert.equal(check.query("SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name='__duckstream_q_0'").toArray()[0].n, 0)
  check.close()
  assert.deepEqual(query.progress().queries, [])
  db.reset()
})

Deno.test('dynamic SQL cannot hide sequence writes in physical stages or scratch statements', async () => {
  const db = await fixture()
  const execution = new PagedExecution(host(db), ['sink'])
  const sql = `SELECT CASE WHEN n>0 THEN error('failed') ELSE n END AS n FROM "query"('SELECT ' || 'next' || 'val(''duckdb_private.output_position'') AS n')`
  const program: SnapshotProgram = { version: 'v', reads: [], queries: { q: 'SELECT 1' },
    queryStages: { q: { sql: 'SELECT 1', stages: [{ name: '__duckstream_q_0', sql }] } },
    spec: { name: 'q', file: 'q.js', to: ['sink'] } }
  const query = new PagedQuery(host(db), [program])
  query.initialize({ id: 'q', name: 'q', version: 'v', revision: 1, tables: {} })
  assert.throws(() => query.materialize('q'), /query function is not permitted/)
  assert.throws(() => execution.commit(0, { checkpoint: null, writes: {}, statements: [`CREATE TABLE hidden AS ${sql}`], done: false }), /query function is not permitted/)
  assert.throws(() => execution.commit(0, { checkpoint: null, writes: {}, statements: [`CREATE TABLE escaped(n) AS ${sql}`], done: false }), /unsupported execution scratch statement/)
  const check = db.connect()
  assert.equal(check.query("SELECT last_value FROM duckdb_sequences() WHERE sequence_name='output_position'").toArray()[0].last_value, null)
  assert.equal(check.query("SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name IN ('hidden','__duckstream_q_0')").toArray()[0].n, 0)
  check.close()
  assert.deepEqual(query.progress().queries, [])
  assert.equal(execution.state().revision, 0)
  db.reset()
})

Deno.test('source ingestion accepts 1024 rows atomically in 32-row inserts, preserves replay and rejects row and byte overflow', async () => {
  const db = await fixture()
  const sizes: number[] = []
  const wrapped = { connect() {
    const conn = host(db).connect()
    return { query: (sql: string) => conn.query(sql), close: () => conn.close(), prepare(sql: string) {
      const statement = conn.prepare(sql)
      return { close: () => statement.close(), query(...values: string[]) {
        if (sql.startsWith('INSERT INTO "source"')) sizes.push(JSON.parse(values[0]).length)
        return statement.query(...values)
      } }
    } }
  } }
  const program: SnapshotProgram = { version: 'v', reads: ['source'], queries: { rows: 'SELECT value FROM source ORDER BY value' }, spec: { name: 'source', file: 'source.js', to: [] } }
  const identity = { id: 'capture', name: 'source', version: 'v', revision: 1 }
  let query = new PagedQuery(wrapped, [program])
  query.initialize({ ...identity, tables: { source: { columns: [{ name: 'value', type: 'text' }], rows: 1152 } } })
  const rows = Array.from({ length: 1024 }, (_, i) => ({ value: String(i) }))
  const chunk = { ...identity, table: 'source', after: 0, next: 1024, done: false, rows }
  try {
    await assert.rejects(() => query.append({ ...chunk, next: 1025, rows: [...rows, { value: 'overflow' }] }), /exceeds limits/)
    await assert.rejects(() => query.append({ ...chunk, next: 1, rows: [{ value: 'é'.repeat(131072) }] }), /exceeds limits/)
    assert.equal(sizes.length, 0)
    await query.append(chunk)
    assert.equal(sizes.length, 32)
    assert.ok(sizes.every(n => n === 32))
    query = new PagedQuery(wrapped, [program])
    await query.append(chunk)
    assert.equal(sizes.length, 32)
    await assert.rejects(() => query.append({ ...chunk, rows: rows.map((r,i) => i ? r : { value: 'different' }) }), /replay differs/)
    await query.append({ ...identity, table: 'source', after: 1024, next: 1152, done: true, rows: Array.from({ length: 128 }, (_, i) => ({ value: String(1024+i) })) })
    query.materialize('rows')
    assert.equal(query.read('rows').rows.length, 128)
    assert.deepEqual(query.progress().sources, [{ name: 'source', position: 1152 }])
  } finally { db.reset() }
})

Deno.test('source ingestion admits exactly 256KiB of row JSON and rejects one additional byte', async () => {
  const db = await fixture()
  const program: SnapshotProgram = { version: 'v', reads: ['source'], queries: {}, spec: { name: 'bytes', file: 'bytes.js', to: [] } }
  const identity = { id: 'bytes', name: 'bytes', version: 'v', revision: 1 }
  const query = new PagedQuery(host(db), [program])
  query.initialize({ ...identity, tables: { source: { columns: [{ name: 'value', type: 'text' }], rows: 1 } } })
  const value = 'x'.repeat(256 * 1024 - JSON.stringify([{ value: '' }]).length)
  const chunk = { ...identity, table: 'source', after: 0, next: 1, done: true, rows: [{ value }] }
  try {
    await assert.rejects(() => query.append({ ...chunk, rows: [{ value: value + 'x' }] }), /exceeds limits/)
    assert.deepEqual(query.progress().sources, [{ name: 'source', position: 0 }])
    await query.append(chunk)
    await query.append(chunk)
    assert.deepEqual(query.progress().sources, [{ name: 'source', position: 1 }])
  } finally { db.reset() }
})

Deno.test('PGlite transition-table WAL and LSN fence drive incremental DuckDB WASM replica updates without reseeding', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { icuDataDir } = await import('@electric-sql/pglite-icu-full')
  const { createSnapshotCoordinator } = await import('../../compute-snapshot/src/index.ts')
  const { snapshotQuery } = await import('../src/snapshot-query.ts')
  const pg = await PGlite.create({ icuDataDir: await icuDataDir() })
  const duck = await fixture()
  let createCount = 0
  const wrapped = {
    connect() {
      const conn = host(duck).connect()
      return {
        query(sql: string) {
          if (sql.startsWith('CREATE TABLE "duckpipe_replica"."games"')) createCount++
          return conn.query(sql)
        },
        prepare: (sql: string) => conn.prepare(sql),
        close: () => conn.close(),
      }
    },
  }
  const program: SnapshotProgram = {
    version: 'v1',
    reads: ['games', 'teams'],
    queries: {
      summary: 'SELECT t.id AS id, (SELECT coalesce(sum(goals), 0)::INTEGER FROM games) AS total FROM teams t ORDER BY t.id',
    },
    spec: { name: 'standings', file: 'standings.js', to: ['standings'] },
  }
  let state: import('../../compute-snapshot/src/index.ts').BatchState = {
    phase: 'idle', name: 'standings', requested: 0, completed: 0, wake: 0, claimed: 0, required: [], due: 0, coalesce: 0, attempts: 25,
  }
  const machine = {
    execute(raw: unknown) {
      const input = raw as {
        initialize?: boolean
        payload?: { name: string; coalesce: number; attempts: number; revision: number }
        state?: typeof state
        event?: { kind: string; payload: Record<string, unknown> }
      }
      if (input.initialize && input.payload) {
        state = {
          phase: 'idle', name: input.payload.name, requested: input.payload.revision,
          completed: input.payload.revision, wake: 0, claimed: 0, required: [],
          due: 0, coalesce: input.payload.coalesce, attempts: input.payload.attempts,
        }
        return { kind: 'accepted' as const, state }
      }
      const s = { ...input.state! }
      const { kind, payload } = input.event!
      if (kind === 'invalidate') { s.requested++ }
      else if (kind === 'schedule') { s.wake = s.requested; s.phase = 'active' }
      else if (kind === 'claim') { s.claimed = s.requested; s.wake = 0 }
      else if (kind === 'complete') {
        s.completed = s.claimed
        s.claimed = 0
        s.phase = 'idle'
      }
      state = s
      return { kind: 'accepted' as const, state: s }
    },
  }
  let queue = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn)
    queue = p.then(() => undefined, () => undefined)
    return p
  }
  try {
    await pg.exec(`
      CREATE ROLE service NOLOGIN;
      CREATE TABLE games (id text PRIMARY KEY, goals integer NOT NULL);
      CREATE TABLE teams (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE standings (id text PRIMARY KEY, total integer NOT NULL);
      GRANT ALL ON standings TO service;
      INSERT INTO games VALUES ('g1', 2), ('g2', 3);
      INSERT INTO teams VALUES ('t1', 'Alpha');
    `)
    const seenWals: (Record<string, unknown> | undefined)[] = []
    const coordinator = await createSnapshotCoordinator({
      db: pg,
      serialize,
      computations: [{ name: 'standings', version: 'v1', reads: ['games', 'teams'], to: ['standings'], coalesceMs: 0 }],
      machine,
      execute: async (snapshot) => {
        seenWals.push(snapshot.wal)
        const { inputs } = snapshotQuery(wrapped, [program], snapshot)
        return { standings: inputs.summary as Record<string, unknown>[] }
      },
    })
    await pg.exec("UPDATE games SET goals = 2 WHERE id = 'g1'")
    await coordinator.resume()
    assert.equal(createCount, 1)
    assert.equal(seenWals.length, 1)
    assert.equal((seenWals[0]?.games as { fromLsn: number; targetLsn: number }).fromLsn, 0)
    assert.deepEqual((await pg.query('SELECT id, total FROM standings')).rows, [{ id: 't1', total: 5 }])

    // Incremental INSERT, UPDATE (with PK change), and DELETE on games; teams unchanged.
    await pg.exec(`
      INSERT INTO games VALUES ('g3', 4);
      UPDATE games SET id = 'g2_renamed', goals = 10 WHERE id = 'g2';
      DELETE FROM games WHERE id = 'g1';
    `)
    await coordinator.resume()
    assert.equal(createCount, 1)
    assert.equal(seenWals.length, 2)
    assert.ok((seenWals[1]?.games as { entries: unknown[] }).entries.length > 0)
    assert.equal((seenWals[1]?.teams as { entries: unknown[] }).entries.length, 0)
    assert.deepEqual((await pg.query('SELECT id, total FROM standings')).rows, [{ id: 't1', total: 14 }])

    // Incremental TRUNCATE + INSERT on games.
    await pg.exec(`TRUNCATE games; INSERT INTO games VALUES ('g4', 9);`)
    await coordinator.resume()
    assert.equal(createCount, 1)
    assert.equal(seenWals.length, 3)
    assert.deepEqual((await pg.query('SELECT id, total FROM standings')).rows, [{ id: 't1', total: 9 }])
    await coordinator.stop()
  } finally {
    duck.reset()
    await pg.close()
  }
})
