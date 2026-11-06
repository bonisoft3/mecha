import { DurableObject } from 'cloudflare:workers'
import { PagedExecution } from '../../mecha-edge/src/paged-execution.ts'
import { createDuckDB } from '../.build/duckdb/runtime.js'

export class CrashFixture extends DurableObject {
  instance = crypto.randomUUID()

  async fetch(request) {
    const action = new URL(request.url).pathname.split('/').pop()
    if (action === 'abort') this.ctx.abort('Deliberate DuckDB durability test')
    this.db ??= await createDuckDB(this.env.ASSETS, {
      storage: this.ctx.storage.sql, memoryLimit: '32MB', maxDatabaseBytes: 32_000_000, maxTemporaryBytes: 32_000_000,
    })
    if (action.startsWith('rotation-')) {
      const connection = this.db.connect()
      try {
        let checkpoints = 0
        if (action === 'rotation-write') {
          connection.query("SET checkpoint_threshold='64KB'; CREATE TABLE rotation(id INTEGER,payload VARCHAR)")
          let previous = this.ctx.storage.sql.exec("SELECT size FROM duckdb_file WHERE path='/database.duckdb'").one().size
          for (let batch = 0; batch < 64; batch++) {
            connection.query(`BEGIN; INSERT INTO rotation SELECT i::INTEGER,repeat(md5(i::VARCHAR),32) FROM range(${batch * 16},${(batch + 1) * 16}) t(i); COMMIT`)
            const size = this.ctx.storage.sql.exec("SELECT size FROM duckdb_file WHERE path='/database.duckdb'").one().size
            if (size > previous) checkpoints++
            previous = size
          }
          if (checkpoints < 2) throw new Error('Rotation fixture did not checkpoint repeatedly')
        }
        if (action === 'rotation-append') connection.query("BEGIN; INSERT INTO rotation VALUES (1024,repeat('tail',256)); COMMIT")
        return Response.json({ instance: this.instance, checkpoints, heap: this.db.memoryBytes,
          rows: connection.query('SELECT count(*)::INTEGER n,sum(id)::INTEGER total FROM rotation').toArray().map(row => row.toJSON()),
          files: this.ctx.storage.sql.exec('SELECT path,size FROM duckdb_file').toArray() })
      } finally { connection.close() }
    }
    if (action.startsWith('execution-')) {
      const execution = new PagedExecution(this.db, ['sink'])
      if (action === 'execution-first') execution.commit(0, {
        checkpoint: { phase: 1 }, writes: { sink: [{ id: 'one', value: 1 }] },
        statements: ['CREATE TABLE scratch AS SELECT 1 AS value'], done: false,
      })
      const before = execution.state()
      let duplicate
      if (action === 'execution-second') {
        const step = { checkpoint: null, writes: { sink: [{ id: 'one', value: 2 }, { id: 'two', value: 3 }] },
          statements: ['INSERT INTO scratch VALUES (2)'], done: true }
        execution.commit(1, step)
        duplicate = execution.commit(1, step)
      }
      const state = execution.state()
      return Response.json({ instance: this.instance, before, state, duplicate,
        ...(state.done ? { output: execution.output('sink'), manifest: execution.manifest(),
          scratch: execution.query('SELECT sum(value)::INTEGER AS value FROM scratch') } : {}) })
    }
    const connection = this.db.connect()
    try {
      if (action === 'write') {
        connection.query('CREATE TABLE IF NOT EXISTS durable(value INTEGER); BEGIN; INSERT INTO durable VALUES (42); COMMIT')
      }
      const rows = connection.query('SELECT value FROM durable').toArray().map(row => row.toJSON())
      const files = this.ctx.storage.sql.exec('SELECT path,size FROM duckdb_file').toArray()
      return Response.json({ instance: this.instance, rows, files })
    } finally { connection.close() }
  }
}
