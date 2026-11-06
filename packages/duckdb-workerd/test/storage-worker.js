import { DurableObject } from 'cloudflare:workers'
import { createDuckDB } from '../.build/duckdb/runtime.js'
import { PagedQuery } from '../../mecha-edge/src/paged-query.ts'

function equal(actual, expected) {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`)
}

export class DiskFixture extends DurableObject {
  async fetch() {
    let spillWrites = 0
    const storage = { exec: (sql, ...bindings) => {
      if (sql.startsWith('INSERT OR REPLACE INTO duckdb_block') && bindings[0].startsWith('/tmp/')) spillWrites++
      return this.ctx.storage.sql.exec(sql, ...bindings)
    } }
    const options = { storage, maxDatabaseBytes: 256_000_000, maxTemporaryBytes: 512_000_000 }
    const db = await createDuckDB(this.env.ASSETS, options)
    const rows = (connection, sql) => connection.query(sql).toArray().map((row) => row.toJSON())
    let connection = db.connect()
    const heaps = []
    try {
      let excluded = false
      try { await createDuckDB(this.env.ASSETS, options) }
      catch (error) { if (!String(error).includes('already has an open runtime')) throw error; excluded = true }
      equal(excluded, true)
      connection.query('CREATE TABLE streamed(id INTEGER, payload VARCHAR)')
      for (let start = 0; start < 65536; start += 512) {
        connection.query(`INSERT INTO streamed SELECT i::INTEGER, repeat(md5(i::VARCHAR),16) FROM range(${start},${start + 512}) t(i)`)
      }
      const [streamed] = rows(connection, 'SELECT count(*)::INTEGER n,sum(length(payload))::DOUBLE bytes FROM streamed')
      equal(streamed.n, 65536)
      equal(streamed.bytes, 33554432)
      heaps.push(db.memoryBytes)
      connection.query(`CREATE TABLE large AS SELECT i::INTEGER id, (i%200000)::INTEGER k,
        md5(i::VARCHAR)||md5((i+9)::VARCHAR)||md5((i+73)::VARCHAR)||md5((i+109)::VARCHAR) payload
        FROM range(2500000) t(i)`)
      connection.query('CHECKPOINT')
      heaps.push(db.memoryBytes)
      const file = this.ctx.storage.sql.exec("SELECT size FROM duckdb_file WHERE path = '/database.duckdb'").one()
      if (file.size <= 128 * 1024 * 1024) throw new Error('Fixture database must exceed isolate memory')
      connection.query('SET debug_force_external=true')
      const evidence = []
      for (const sql of [
        'SELECT count(*)::INTEGER n,sum(id)::DOUBLE total FROM (SELECT id FROM large ORDER BY k,id DESC) t',
        'SELECT count(*)::INTEGER n,sum(a.id)::DOUBLE total FROM large a JOIN large b ON a.id=b.id',
        'SELECT count(*)::INTEGER n,sum(id)::DOUBLE total FROM (SELECT id,count(*) c FROM large GROUP BY id) t',
      ]) {
        const before = spillWrites
        const [result] = rows(connection, sql)
        equal(result.n, 2_500_000)
        equal(result.total, 3_124_998_750_000)
        if (spillWrites <= before) throw new Error(`Query did not spill: ${sql}`)
        heaps.push(db.memoryBytes)
        evidence.push({ sql, spillWrites: spillWrites - before, heap: db.memoryBytes })
      }
      const programs = [{ spec: { name: 'sum', file: 'unused', to: [] }, version: 'v1', reads: ['source'], queries: { total: 'SELECT sum(value)::INTEGER AS total FROM source', boundary: "SELECT repeat('x',262134) AS v", oversized: "SELECT repeat('x',262135) AS v" } }]
      const manifest = { id: 'one', name: 'sum', version: 'v1', revision: 1, tables: { source: { columns: [{ name: 'value', type: 'integer' }], rows: 2 } } }
      const chunk = { id: 'one', name: 'sum', version: 'v1', revision: 1, table: 'source', after: 0, next: 2, done: true, rows: [{ value: '2' }, { value: '3' }] }
      const paged = new PagedQuery(db, programs)
      paged.initialize(manifest)
      await paged.append(chunk)
      await paged.append(chunk)
      let replayRejected = false
      try { await paged.append({ ...chunk, rows: [{ value: '4' }, { value: '3' }] }) }
      catch (error) { if (!String(error).includes('replay differs')) throw error; replayRejected = true }
      equal(replayRejected, true)
      paged.materialize('total')
      equal(paged.read('total').rows[0].total, 5)
      paged.materialize('boundary')
      equal(paged.read('boundary').rows[0].v.length, 262134)
      equal(paged.read('boundary').done, true)
      paged.materialize('oversized')
      let oversizedRejected = false
      try { paged.read('oversized') }
      catch (error) { if (!String(error).includes('row exceeds byte limit')) throw error; oversizedRejected = true }
      equal(oversizedRejected, true)
      let closeRejected = false
      try { db.close() } catch (error) { if (!String(error).includes('Close DuckDB connections')) throw error; closeRejected = true }
      equal(closeRejected, true)
      const stale = connection
      connection.close()
      db.close()
      let rejected = false
      try { db.connect() } catch (error) { if (!String(error).includes('database is closed')) throw error; rejected = true }
      equal(rejected, true)
      db.reopen()
      let staleRejected = false
      try { stale.query('SELECT 1') } catch (error) { if (!String(error).includes('connection is closed')) throw error; staleRejected = true }
      equal(staleRejected, true)
      const reopenedPaged = new PagedQuery(db, programs)
      equal(reopenedPaged.read('total').rows[0].total, 5)
      equal(reopenedPaged.read('total').done, true)
      let identityRejected = false
      try { reopenedPaged.initialize({ ...manifest, id: 'two' }) }
      catch (error) { if (!String(error).includes('another capture')) throw error; identityRejected = true }
      equal(identityRejected, true)
      connection = db.connect()
      const [restoredStream] = rows(connection, 'SELECT count(*)::INTEGER n,sum(length(payload))::DOUBLE bytes FROM streamed')
      equal(restoredStream.n, streamed.n)
      equal(restoredStream.bytes, streamed.bytes)
      equal(rows(connection, "SELECT current_setting('memory_limit') AS configured_limit")[0].configured_limit, '30.5 MiB')
      equal(rows(connection, "SELECT current_setting('disabled_optimizers') AS disabled")[0].disabled, 'window_self_join')
      const [persisted] = rows(connection, 'SELECT count(*)::INTEGER n,sum(length(payload))::DOUBLE bytes FROM large')
      equal(persisted.n, 2_500_000)
      equal(persisted.bytes, 320_000_000)
      heaps.push(db.memoryBytes)
      if (Math.max(...heaps) >= 128 * 1024 * 1024) throw new Error('WASM heap exceeded 128MiB')
      return Response.json({ passed: true, databaseBytes: file.size, payloadBytes: persisted.bytes, pagedCapture: true, heaps, evidence })
    } finally { connection.close(); db.close() }
  }
}
