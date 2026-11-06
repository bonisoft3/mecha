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
