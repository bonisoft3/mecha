import assert from 'node:assert/strict'
import { PagedExecution, EXECUTION_BYTES, EXECUTION_OUTPUT_BYTES, type ExecutionDatabase } from '../src/paged-execution.ts'
import { fixture, host } from './duckdb-fixture.ts'

Deno.test('execution commits scratch, output and checkpoints atomically and ignores stale replay', async () => {
  const db = await fixture()
  let store = new PagedExecution(host(db), ['sink'])
  assert.deepEqual(store.state(), { revision: 0, checkpoint: null, done: false })
  const step = { checkpoint: { phase: 1 }, writes: { sink: [{ id: 'one', value: 1 }] }, statements: ['CREATE TABLE scratch AS SELECT 1 AS value'], done: false }
  assert.deepEqual(store.commit(0, step), { revision: 1, checkpoint: { phase: 1 }, done: false })
  assert.deepEqual(store.commit(0, { ...step, statements: ['INSERT INTO scratch VALUES(99)'] }), store.state())
  assert.deepEqual(store.query('SELECT * FROM scratch'), [{ value: 1 }])
  assert.throws(() => store.commit(1, { ...step, checkpoint: { phase: 2 }, statements: ['INSERT INTO scratch VALUES(2)', "CREATE TABLE failure AS SELECT error('step failed') AS value"] }), /step failed/)
  assert.deepEqual(store.query('SELECT * FROM scratch'), [{ value: 1 }])
  assert.deepEqual(store.state(), { revision: 1, checkpoint: { phase: 1 }, done: false })
  store = new PagedExecution(host(db), ['sink'])
  assert.throws(() => store.output('sink'), /not complete/)
  assert.throws(() => store.manifest(), /not complete/)
  assert.deepEqual(store.commit(1, { checkpoint: null, writes: { sink: [{ id: 'one', value: 3 }] }, done: true }), { revision: 2, checkpoint: null, done: true })
  assert.deepEqual(store.output('sink').rows, [{ id: 'one', value: 3 }])
  assert.deepEqual(store.manifest(), { sink: { rows: 1 } })
  assert.throws(() => store.commit(2, { checkpoint: null, writes: {}, done: true }), /complete/)
  assert.deepEqual(store.commit(1, step), store.state())
  assert.throws(() => new PagedExecution(host(db), ['other']), /declarations differ/)
  db.reset()
})

Deno.test('scratch statements cannot escape transactions or mutate captured and private tables', async () => {
  const db = await fixture()
  const connection = db.connect()
  connection.query('CREATE TABLE captured AS SELECT 7 AS value')
  connection.close()
  let executions = 0
  const wrapped: ExecutionDatabase = { connect() {
    const conn = host(db).connect()
    return { close: () => conn.close(), query: sql => conn.query(sql), prepare(sql) {
      const statement = conn.prepare(sql)
      return { close: () => statement.close(), query(...values) {
        if (/^CREATE TABLE main\./.test(sql)) executions++
        return statement.query(...values)
      } }
    } }
  } }
  const store = new PagedExecution(wrapped, ['sink'])
  const base = { checkpoint: null, writes: { sink: [{ id: 'one', value: 1 }] }, done: false }
  const sequenceSql = "SELECT last_value::VARCHAR AS value FROM duckdb_sequences() WHERE schema_name='duckdb_private' AND sequence_name='output_position'"
  const sequence = store.query(sequenceSql)
  const rejected = [
    'COMMIT',
    "CREATE TABLE escaped AS SELECT 1; COMMIT; SELECT error('escaped transaction')",
    'CREATE TABLE escaped AS SELECT 1; UPDATE duckdb_private.execution SET revision=99',
    'CREATE TABLE escaped AS WITH changed AS (DELETE FROM duckdb_private.execution RETURNING *) SELECT * FROM changed',
    'UPDATE duckdb_private.execution SET revision=99',
    'DROP TABLE duckstream_private.metadata',
    'DROP TABLE captured',
    'INSERT INTO captured VALUES(99)',
    'DELETE FROM captured WHERE value=7',
    'CREATE TABLE execution_incoming AS SELECT 1',
    'CREATE TABLE duckdb_private.output_rows AS SELECT 1',
    "CREATE TABLE escaped AS SELECT nextval('duckdb_private.output_position')",
    "CREATE TABLE escaped AS SELECT nextval/**/('duckdb_private.output_position')",
    `CREATE TABLE escaped AS SELECT "nextval"('duckdb_private.output_position')`,
    `CREATE TABLE escaped AS SELECT U&"next\\0076al"('duckdb_private.output_position')`,
    'CREATE OR REPLACE TABLE captured AS SELECT 99 AS value',
    'CREATE TABLE escaped AS SELECT 1; /* delimiter */ COMMIT',
  ]
  for (const sql of rejected) {
    assert.throws(() => store.commit(0, { ...base, statements: ['CREATE TABLE first_scratch AS SELECT 1 AS value', sql] }), Error, sql)
    assert.equal(executions, 0, sql)
    assert.deepEqual(store.state(), { revision: 0, checkpoint: null, done: false })
    assert.deepEqual(store.query('SELECT * FROM captured'), [{ value: 7 }])
    assert.deepEqual(store.query('SELECT * FROM duckdb_private.scratch_tables'), [])
    assert.deepEqual(store.query('SELECT * FROM duckdb_private.output_rows'), [])
    assert.deepEqual(store.query("SELECT fields FROM duckdb_private.output_sinks"), [{ fields: null }])
    assert.deepEqual(store.query(sequenceSql), sequence)
  }
  assert.deepEqual(store.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('escaped','first_scratch')"), [])
  db.reset()
})

Deno.test('owned scratch supports driver SQL while rejecting extra clauses and same-batch dependencies', async () => {
  const db = await fixture()
  const store = new PagedExecution(host(db), ['sink'])
  const base = { checkpoint: null, writes: {}, done: false }
  assert.throws(() => store.commit(0, { ...base, statements: ['CREATE TABLE first_scratch AS SELECT 1 AS value', 'CREATE TABLE second_scratch AS SELECT * FROM first_scratch'] }), /does not exist/)
  assert.deepEqual(store.query('SELECT * FROM duckdb_private.scratch_tables'), [])
  store.commit(0, { ...base, statements: ["CREATE TABLE scratch(id VARCHAR,value DOUBLE)", "CREATE TABLE semicolons AS WITH t AS (SELECT 'it''s; COMMIT; -- text' AS value) SELECT * FROM t"] })
  store.commit(1, { ...base, statements: ["INSERT INTO scratch VALUES('one',1e-3),('two',NULL),('a; COMMIT',-2)"] })
  for (const sql of [
    "INSERT INTO scratch VALUES('three',3) RETURNING *",
    "INSERT INTO scratch SELECT 'three',3",
    "DELETE FROM scratch WHERE id='one' RETURNING *",
    "DELETE FROM scratch",
    "DROP TABLE scratch CASCADE",
    "INSERT INTO scratch VALUES('three',3); COMMIT",
  ]) assert.throws(() => store.commit(2, { ...base, statements: [sql] }), /unsupported execution scratch statement/)
  store.commit(2, { ...base, statements: ["DELETE FROM scratch WHERE id IN ('one','two') AND value=1e-3", "INSERT INTO scratch VALUES('one',2)"] })
  assert.deepEqual(store.query('SELECT * FROM scratch ORDER BY id'), [{ id: 'a; COMMIT', value: -2 }, { id: 'one', value: 2 }, { id: 'two', value: null }])
  assert.deepEqual(store.query('SELECT * FROM semicolons'), [{ value: "it's; COMMIT; -- text" }])
  store.commit(3, { ...base, statements: ['DROP TABLE scratch'] })
  assert.throws(() => store.commit(4, { ...base, statements: ["INSERT INTO scratch VALUES('one',3)"] }), /does not own/)
  store.commit(4, { ...base, statements: ['CREATE TABLE scratch AS SELECT 4 AS value'], done: true })
  assert.deepEqual(store.query('SELECT * FROM scratch'), [{ value: 4 }])
  db.reset()
})

Deno.test('a failed checkpoint after commit can replay without repeating scratch or output writes', async () => {
  const db = await fixture()
  let fail = true
  const wrapped: ExecutionDatabase = { connect() {
    const conn = host(db).connect()
    return {
      close: () => conn.close(), prepare: sql => conn.prepare(sql),
      query(sql) {
        if (sql === 'CHECKPOINT' && fail) { fail = false; throw new Error('checkpoint interrupted') }
        return conn.query(sql)
      },
    }
  } }
  const store = new PagedExecution(wrapped, ['sink'])
  const step = { checkpoint: null, statements: ['CREATE TABLE once_only AS SELECT 1 AS value'], writes: { sink: [{ id: 'one', value: 2 }] }, done: true }
  assert.throws(() => store.commit(0, step), /checkpoint interrupted/)
  assert.deepEqual(store.commit(0, step), { revision: 1, checkpoint: null, done: true })
  assert.deepEqual(store.query('SELECT * FROM once_only'), [{ value: 1 }])
  assert.deepEqual(store.output('sink').rows, [{ id: 'one', value: 2 }])
  db.reset()
})

Deno.test('execution queries enforce readonly SQL and a UTF-8 budget before exposing row values', async () => {
  const db = await fixture()
  let arrayRead = false
  const wrapped: ExecutionDatabase = { connect() {
    const connection = host(db).connect()
    return {
      close: () => connection.close(), query: sql => connection.query(sql),
      prepare(sql) {
        const statement = connection.prepare(sql)
        return { close: () => statement.close(), query(...values) {
          const table = statement.query(...values)
          return { toArray() {
            if (sql.includes('execution_size')) arrayRead = true
            return table.toArray()
          } }
        } }
      }
    }
  } }
  const store = new PagedExecution(wrapped, ['sink'])
  assert.throws(() => store.query("SELECT repeat('é',1000) AS text FROM range(5000)"), /query exceeds byte limit/)
  assert.equal(arrayRead, false)
  assert.deepEqual(store.query("SELECT 'é' AS text, 1::INTEGER AS integer, true AS flag"), [{ text: 'é', integer: 1, flag: true }])
  assert.equal(arrayRead, true)
  assert.throws(() => store.query("SELECT nextval('duckdb_private.output_position') AS value"), /read.only|read only/i)
  assert.throws(() => store.query('SELECT 9007199254740993::BIGINT AS value'), /finite lossless JSON/)
  assert.throws(() => store.query('SELECT 1; DELETE FROM duckdb_private.execution'), /Parser Error/)
  assert.throws(() => store.query('SELECT 1) r) SELECT 1; COMMIT; UPDATE duckdb_private.execution SET revision=99; WITH execution_rows AS MATERIALIZED (SELECT to_json(r)::VARCHAR AS value FROM (SELECT 1'), /Cannot prepare multiple statements/)
  assert.deepEqual(store.state(), { revision: 0, checkpoint: null, done: false })
  db.reset()
})

Deno.test('output pages preserve upsert positions, byte bounds and empty declared sinks', async () => {
  const db = await fixture()
  const store = new PagedExecution(host(db), ['sink', 'other', 'empty'])
  store.commit(0, { checkpoint: 1, writes: { sink: [{ id: 'first', value: 'old' }], other: [{ id: 'elsewhere', value: 'elsewhere' }] }, done: false })
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: `row-${i}`, value: 'é'.repeat(i % 100 === 0 ? 130000 : 1100) }))
  store.commit(1, { checkpoint: null, writes: { sink: [{ id: 'first', value: 'new' }, ...rows] }, done: true })
  const collected = []
  let after = 0
  for (;;) {
    const page = store.output('sink', after)
    assert.deepEqual(store.output('sink', after), page)
    assert.ok(page.rows.length <= 128, JSON.stringify({ after, next: page.next, length: page.rows.length, first: page.rows[0]?.id, last: page.rows.at(-1)?.id }))
    assert.ok(new TextEncoder().encode(JSON.stringify(page.rows)).length <= EXECUTION_OUTPUT_BYTES)
    collected.push(...page.rows)
    if (page.done) break
    assert.ok(page.next > after)
    after = page.next
  }
  assert.equal(collected[0].id, 'first')
  assert.deepEqual(collected.map(row => row.id).sort(), ['first', ...rows.map(row => row.id)].sort())
  assert.equal(collected[0].value, 'new')
  const expected = new Map(rows.map(row => [row.id, row.value]))
  assert.ok(collected.slice(1).every(row => row.value === expected.get(String(row.id))))
  assert.deepEqual(store.query("SELECT constraint_type FROM duckdb_constraints() WHERE schema_name='duckdb_private' AND table_name='output_rows' AND constraint_type IN ('PRIMARY KEY','UNIQUE')"), [])
  assert.deepEqual(store.output('other').rows, [{ id: 'elsewhere', value: 'elsewhere' }])
  assert.deepEqual(store.output('empty'), { after: 0, next: 0, done: true, rows: [] })
  assert.deepEqual(store.manifest(), { empty: { rows: 0 }, other: { rows: 1 }, sink: { rows: 301 } })
  assert.throws(() => store.output('missing'), /cursor/)
  db.reset()
})

Deno.test('invalid steps leave both durable output and scratch untouched', async () => {
  const db = await fixture()
  const store = new PagedExecution(host(db), ['sink'])
  const base = { checkpoint: null, writes: {}, statements: ['CREATE TABLE should_not_exist(id INTEGER)'], done: false }
  assert.throws(() => store.commit(0, { ...base, writes: { other: [{ id: 'one' }] } }), /undeclared execution sink/)
  assert.throws(() => store.commit(0, { ...base, writes: { sink: [{ id: 'one', value: NaN }] } }), /finite lossless JSON/)
  assert.throws(() => store.commit(0, { ...base, writes: { sink: [{ id: 'one' }, { id: 'one' }] } }), /output row/)
  assert.throws(() => store.commit(0, { ...base, writes: { sink: [{ id: 'one', value: 'x'.repeat(EXECUTION_OUTPUT_BYTES) }] } }), /output row exceeds/)
  assert.throws(() => store.commit(0, { ...base, checkpoint: 'x'.repeat(EXECUTION_BYTES) }), /step exceeds/)
  assert.deepEqual(store.query("SELECT table_name FROM information_schema.tables WHERE table_name='should_not_exist'"), [])
  store.commit(0, { checkpoint: null, writes: { sink: [{ id: 'one', value: 1 }] }, done: false })
  assert.throws(() => store.commit(1, { ...base, writes: { sink: [{ id: 'two', different: 2 }] } }), /columns differ/)
  assert.deepEqual(store.state(), { revision: 1, checkpoint: null, done: false })
  store.commit(1, { checkpoint: null, writes: {}, done: true })
  assert.deepEqual(store.output('sink').rows, [{ id: 'one', value: 1 }])
  db.reset()
})

Deno.test('WASM query pages preserve order, fence revisions and reject duplicate boundary keys', async () => {
  const db = await fixture()
  const store = new PagedExecution(host(db), ['sink'])
  const sql = 'SELECT i::BIGINT AS ordinal, i::INTEGER AS value FROM range(5000) t(i)'
  const first = store.queryPage(sql, 'ordinal', 0)
  assert.equal(first.rows.length, 4096)
  assert.equal(first.next, 4095)
  assert.equal(first.done, false)
  assert.deepEqual(first.rows[0], { value: 0 })
  const second = store.queryPage(sql, 'ordinal', 0, first.next)
  assert.equal(second.rows.length, 904)
  assert.equal(second.done, true)
  assert.deepEqual(second.rows[903], { value: 4999 })
  assert.throws(() => store.queryPage(`${sql} UNION ALL SELECT 4095,0`, 'ordinal', 0), /strictly increase/)
  assert.throws(() => store.queryPage(`${sql} UNION ALL SELECT 4095,0`, 'ordinal', 0, 4095), /strictly increase/)
  for (const key of ['NULL', '-1', '0.5', '9007199254740992', "'Infinity'::DOUBLE"]) {
    assert.throws(() => store.queryPage(`SELECT ${key} AS ordinal, 1 AS value`, 'ordinal', 0), /safe integer/)
  }
  assert.throws(() => store.queryPage("SELECT nextval('duckdb_private.output_position') AS ordinal", 'ordinal', 0), /not permitted/)
  assert.throws(() => store.queryPage('SELECT 0 AS ordinal; SELECT 1', 'ordinal', 0), /one SELECT/)
  assert.throws(() => store.queryPage("SELECT 0 AS ordinal, 'NaN'::DOUBLE AS value", 'ordinal', 0), /finite lossless|not valid JSON/)
  assert.throws(() => store.queryPage('SELECT 0 AS ordinal, 9007199254740992::BIGINT AS value', 'ordinal', 0), /finite lossless/)
  assert.throws(() => store.queryPage("SELECT 0 AS ordinal,repeat('x',1048576) AS value", 'ordinal', 0), /page byte limit/)
  assert.deepEqual(store.queryPage('SELECT 0 AS ordinal WHERE false', 'ordinal', 0), { after: -1, next: -1, done: true, rows: [] })
  store.commit(0, { checkpoint: null, done: false, writes: {} })
  assert.throws(() => store.queryPage(sql, 'ordinal', 0, first.next), /revision differs/)
  db.reset()
})

Deno.test('WASM query pages stop on byte budget and inspect the overlap sentinel', async () => {
  const db = await fixture()
  const store = new PagedExecution(host(db), ['sink'])
  const sql = "SELECT i::INTEGER AS ordinal,repeat('é',200000) AS value FROM range(4) t(i)"
  const first = store.queryPage(sql, 'ordinal', 0)
  assert.equal(first.rows.length, 2)
  assert.equal(first.next, 1)
  const second = store.queryPage(sql, 'ordinal', 0, first.next)
  assert.equal(second.rows.length, 2)
  assert.equal(second.done, true)
  assert.throws(() => store.queryPage(`${sql} UNION ALL SELECT 1,'extra'`, 'ordinal', 0, first.next), /strictly increase/)
  db.reset()
})
