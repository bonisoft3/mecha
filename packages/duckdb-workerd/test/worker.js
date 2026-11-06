export { DiskFixture } from './storage-worker.js'
export { CrashFixture } from './crash-worker.js'
import { createDuckDB } from '../.build/duckdb/runtime.js'
import { createWorkerdRuntime } from '../.build/duckdb/duckdb.mjs'

function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function rows(connection, sql) {
  return connection.query(sql).toArray().map((row) => row.toJSON())
}

async function verify(assets) {
  const runtimeA = createWorkerdRuntime()
  const runtimeB = createWorkerdRuntime()
  runtimeA._files.set('same', 'first')
  runtimeB._files.set('same', 'second')
  equal(runtimeA._files.get('same'), 'first')
  equal(runtimeB._files.get('same'), 'second')
  if (runtimeA._fileInfoCache === runtimeB._fileInfoCache || runtimeA._udfFunctions === runtimeB._udfFunctions) throw new Error('Shared browser runtime state')
  const marker = {}
  globalThis.DUCKDB_RUNTIME = marker
  const [first, second] = await Promise.all([createDuckDB(assets), createDuckDB(assets)])
  if (globalThis.DUCKDB_RUNTIME !== marker) throw new Error('Initialization leaked its runtime')
  const a = first.connect()
  const b = second.connect()
  try {
    const largeParameter = 'ação'.repeat(300_000)
    const parameterStatement = a.prepare('SELECT length(?)::INTEGER characters')
    try { equal(parameterStatement.query(largeParameter).toArray().map((r) => r.toJSON()), [{ characters: 1_200_000 }]) }
    finally { parameterStatement.close() }
    a.query('CREATE TABLE shared(id INTEGER, amount INTEGER); INSERT INTO shared VALUES (1,10),(2,20)')
    b.query('CREATE TABLE shared(id INTEGER, amount INTEGER); INSERT INTO shared VALUES (1,100),(3,300)')
    const statementA = a.prepare('SELECT sum(amount)::INTEGER total FROM shared WHERE id>=?')
    const statementB = b.prepare('SELECT sum(amount)::INTEGER total FROM shared WHERE id>=?')
    try {
      equal(statementA.query(1).toArray().map((r) => r.toJSON()), [{ total: 30 }])
      equal(statementB.query(1).toArray().map((r) => r.toJSON()), [{ total: 400 }])
      a.query('UPDATE shared SET amount=11 WHERE id=1')
      equal(statementA.query(1).toArray().map((r) => r.toJSON()), [{ total: 31 }])
      equal(statementB.query(3).toArray().map((r) => r.toJSON()), [{ total: 300 }])
    } finally { statementA.close(); statementB.close() }
    equal(rows(a, `SELECT json_extract('{"a":42}', '$.a')::INTEGER answer,
      timezone('America/Sao_Paulo', TIMESTAMP '2026-01-01 12:00:00')::VARCHAR utc`),
    [{ answer: 42, utc: '2026-01-01 15:00:00+00' }])
    equal(rows(b, 'SELECT count(*)::INTEGER count FROM shared'), [{ count: 2 }])
    equal(rows(a, `SELECT current_setting('enable_external_access') enabled`), [{ enabled: false }])
    equal(rows(a, `SELECT current_setting('preserve_insertion_order') enabled`), [{ enabled: true }])
    a.query('CREATE TABLE chronological AS SELECT ((i*37)%4097)::INTEGER id, (i%7)::INTEGER moment FROM range(4097) t(i)')
    const chronological = a.query('SELECT to_json(r)::VARCHAR AS value FROM (SELECT id,moment FROM chronological ORDER BY moment,id) r')
      .toArray().map((row) => JSON.parse(row.value))
    const expectedOrder = Array.from({ length: 4097 }, (_, i) => ({ id: (i * 37) % 4097, moment: i % 7 }))
      .sort((left, right) => left.moment - right.moment || left.id - right.id)
    equal(chronological, expectedOrder)
    let rejected = false
    try { a.query(`SELECT * FROM read_json('https://example.invalid/input.json')`) } catch (error) {
      if (!/disabled|external access/i.test(String(error))) throw error
      rejected = true
    }
    if (!rejected) throw new Error('External access was allowed')
    equal(rows(a, 'SELECT count(*)::INTEGER count FROM shared'), [{ count: 2 }])
    if (globalThis.DUCKDB_RUNTIME !== marker) throw new Error('Synchronous execution leaked its runtime')
    return { passed: true, version: first.getVersion(), memory: [first.memoryBytes, second.memoryBytes] }
  } finally { a.close(); b.close() }
}

let result
export default {
  async fetch(_request, env) {
    const pathname = new URL(_request.url).pathname
    if (pathname.startsWith('/crash/')) return env.CRASH.get(env.CRASH.idFromName(pathname.split('/')[2])).fetch(_request)
    if (pathname === '/disk') return env.DISK.get(env.DISK.idFromName(crypto.randomUUID())).fetch(_request)
    result ??= verify(env.ASSETS)
    return Response.json(await result)
  },
}
