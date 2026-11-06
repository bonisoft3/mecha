import type { SnapshotChunk, SnapshotManifest } from '../../compute-snapshot/src/index.ts'
import { snapshotStatements } from '../../../services/compute/snapshot-data.ts'
import { bindBoundary, typedSql } from '../../../services/compute/portable-contract.ts'
import { validateQuerySql } from './query-sql.ts'
import { validateQueryStages } from '../../../services/compute/query-stages.ts'
import { strictJson, type SnapshotProgram } from './snapshot-program.ts'

interface Connection {
  query(sql: string): { toArray(): Record<string, unknown>[] }
  prepare(sql: string): { query(...values: string[]): { toArray(): Record<string, unknown>[] }; close(): void }
  close(): void
}
interface Database { connect(): Connection }
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
const privateSchema = 'duckstream_private'
const maxBytes = 256 * 1024
const maxRows = 128

/** One immutable capture per compute object; progress commits with its data. */
export class PagedQuery {
  constructor(private db: Database, private programs: readonly SnapshotProgram[]) {}

  private atomic<T>(fn: (conn: Connection) => T): T {
    const conn = this.db.connect()
    let began = false
    try {
      conn.query('BEGIN')
      began = true
      const value = fn(conn)
      conn.query('COMMIT')
      began = false
      return value
    } catch (error) {
      if (began) {
        try { conn.query('ROLLBACK') }
        catch (rollback) { throw new AggregateError([error, rollback], `${String(error)}; rollback failed: ${String(rollback)}`) }
      }
      throw error
    } finally { conn.close() }
  }

  private parameter(conn: Connection, sql: string, ...values: string[]) {
    const statement = conn.prepare(sql)
    try { return statement.query(...values).toArray() }
    finally { statement.close() }
  }

  private saved(conn: Connection): SnapshotManifest {
    const rows = conn.query(`SELECT value FROM ${privateSchema}.metadata WHERE key='manifest'`).toArray()
    if (rows.length !== 1) throw new Error('capture is not initialized')
    return JSON.parse(String(rows[0].value))
  }

  private program(manifest: SnapshotManifest) {
    const program = this.programs.find(p => p.spec.name === manifest.name && p.version === manifest.version)
    if (!program) throw new Error('capture artifact version differs')
    return program
  }

  initialize(manifest: SnapshotManifest) {
    const program = this.program(manifest)
    const empty = Object.fromEntries(Object.entries(manifest.tables).map(([name, table]) => {
      if (!Number.isSafeInteger(table.rows) || table.rows < 0) throw new Error('invalid capture row count')
      return [name, { columns: table.columns, rows: [] }]
    }))
    const statements = snapshotStatements(empty, program.reads, program.spec.types)
    return this.atomic(conn => {
      conn.query(`CREATE SCHEMA IF NOT EXISTS ${privateSchema}`)
      conn.query(`CREATE TABLE IF NOT EXISTS ${privateSchema}.metadata(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL)`)
      const saved = conn.query(`SELECT value FROM ${privateSchema}.metadata WHERE key='manifest'`).toArray()
      if (saved.length) {
        if (strictJson(JSON.parse(String(saved[0].value))) !== strictJson(manifest)) throw new Error('compute object belongs to another capture')
        return
      }
      conn.query(`CREATE TABLE ${privateSchema}.progress(name VARCHAR PRIMARY KEY,position BIGINT NOT NULL)`)
      conn.query(`CREATE TABLE ${privateSchema}.chunks(name VARCHAR,position BIGINT,payload VARCHAR NOT NULL,PRIMARY KEY(name,position))`)
      for (const [index, statement] of statements.entries()) {
        conn.query(statement.create)
        this.parameter(conn, `INSERT INTO ${privateSchema}.progress VALUES(?,0)`, program.reads[index])
      }
      this.parameter(conn, `INSERT INTO ${privateSchema}.metadata VALUES('manifest',?)`, strictJson(manifest))
    })
  }

  progress() {
    return this.atomic(conn => ({
      manifest: this.saved(conn),
      sources: conn.query(`SELECT name,position::VARCHAR AS position FROM ${privateSchema}.progress`).toArray()
        .map(row => ({ name: String(row.name), position: Number(row.position) })),
      queries: conn.query(`SELECT substring(key,7) AS name FROM ${privateSchema}.metadata WHERE starts_with(key,'query:')`).toArray()
        .map(row => String(row.name)),
    }))
  }

  async append(chunk: SnapshotChunk) {
    const payload = strictJson(chunk)
    if (new TextEncoder().encode(payload).length > maxBytes + 16384 || chunk.rows.length > maxRows) throw new Error('capture chunk exceeds limits')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))].map(n => n.toString(16).padStart(2, '0')).join('')
    return this.atomic(conn => {
      const manifest = this.saved(conn)
      for (const field of ['id', 'name', 'version', 'revision'] as const) {
        if (manifest[field] !== chunk[field]) throw new Error('capture chunk identity differs')
      }
      const source = manifest.tables[chunk.table]
      if (!source || !Number.isSafeInteger(chunk.after) || chunk.after < 0 ||
        chunk.next !== chunk.after + chunk.rows.length || chunk.next > source.rows || chunk.done !== (chunk.next === source.rows)) {
        throw new Error('invalid capture chunk position')
      }
      const duplicate = this.parameter(conn, `SELECT payload FROM ${privateSchema}.chunks WHERE name=? AND position=CAST(? AS BIGINT)`, chunk.table, String(chunk.after))
      if (duplicate.length) {
        if (duplicate[0].payload !== digest) throw new Error('capture chunk replay differs')
        return
      }
      if (conn.query(`SELECT key FROM ${privateSchema}.metadata WHERE key='sealed'`).toArray().length) throw new Error('capture is sealed')
      const progress = this.parameter(conn, `SELECT position::VARCHAR AS position FROM ${privateSchema}.progress WHERE name=?`, chunk.table)
      if (Number(progress[0]?.position) !== chunk.after) throw new Error('capture chunks must be consecutive')
      if (!chunk.rows.length && !chunk.done) throw new Error('capture chunk made no progress')
      const program = this.program(manifest)
      const [statement] = snapshotStatements({ [chunk.table]: { columns: source.columns, rows: chunk.rows } }, [chunk.table], program.spec.types)
      for (let start = 0; start < chunk.rows.length; start += 32) {
        this.parameter(conn, statement.insert, JSON.stringify(chunk.rows.slice(start, start + 32)))
      }
      this.parameter(conn, `UPDATE ${privateSchema}.progress SET position=CAST(? AS BIGINT) WHERE name=?`, String(chunk.next), chunk.table)
      this.parameter(conn, `INSERT INTO ${privateSchema}.chunks VALUES(?,CAST(? AS BIGINT),?)`, chunk.table, String(chunk.after), digest)
    })
  }

  materialize(name: string) {
    // COMMIT retains append buffers that cannot make room for the query's joins.
    const checkpoint = this.db.connect()
    try { checkpoint.query('CHECKPOINT') }
    finally { checkpoint.close() }
    const result = this.atomic(conn => {
      const manifest = this.saved(conn)
      const program = this.program(manifest)
      if (!Object.hasOwn(program.queries, name)) throw new Error('undeclared query')
      const positions = new Map(conn.query(`SELECT name,position::VARCHAR AS position FROM ${privateSchema}.progress`).toArray().map(row => [String(row.name), Number(row.position)]))
      if (Object.entries(manifest.tables).some(([table, value]) => positions.get(table) !== value.rows)) throw new Error('capture transfer is incomplete')
      conn.query(`INSERT INTO ${privateSchema}.metadata VALUES('sealed','true') ON CONFLICT DO NOTHING`)
      const done = this.parameter(conn, `SELECT value FROM ${privateSchema}.metadata WHERE key=?`, `query:${name}`)
      if (done.length) return { done: true }
      const plan = validateQueryStages(program.queryStages, program.queries)?.[name]
      if (plan) {
        const saved = this.parameter(conn, `SELECT value FROM ${privateSchema}.metadata WHERE key=?`, `stage:${name}`)
        const next = saved.length ? Number(saved[0].value) : 0
        if (!Number.isSafeInteger(next) || next < 0 || next > plan.stages.length) throw new Error('invalid query stage cursor')
        if (next < plan.stages.length) {
          const stage = plan.stages[next]
          validateQuerySql(conn, stage.sql)
          this.parameter(conn, `CREATE TABLE main.${q(stage.name)} AS ${stage.sql}`)
          this.parameter(conn, `INSERT INTO ${privateSchema}.metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, `stage:${name}`, String(next + 1))
          return { done: false }
        }
      }
      const sql = plan?.sql ?? program.queries[name]
      validateQuerySql(conn, sql)
      const fields = program.spec.queryTypes?.[name]
      const boundary = fields ? bindBoundary({ fields, types: program.spec.types! }) : undefined
      if (boundary) boundary.columns(this.parameter(conn, `DESCRIBE (${sql})`).map(row => String(row.column_name)))
      const typed = boundary ? typedSql(boundary.bound.canonicalType, sql, fields!) : sql
      conn.query(`CREATE TABLE ${privateSchema}.${q(`result_${name}`)}(sequence BIGINT,value VARCHAR USING COMPRESSION UNCOMPRESSED)`)
      this.parameter(conn, `INSERT INTO ${privateSchema}.${q(`result_${name}`)} SELECT row_number() OVER () AS sequence,to_json(r)::VARCHAR AS value FROM (${typed}) r`)
      for (const stage of plan?.stages ?? []) conn.query(`DROP TABLE main.${q(stage.name)}`)
      this.parameter(conn, `DELETE FROM ${privateSchema}.metadata WHERE key=?`, `stage:${name}`)
      this.parameter(conn, `INSERT INTO ${privateSchema}.metadata VALUES(?,'true')`, `query:${name}`)
      return { done: true }
    })
    const saved = this.db.connect()
    try { saved.query('CHECKPOINT') }
    finally { saved.close() }
    return result
  }

  read(name: string, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid result cursor')
    return this.atomic(conn => {
      const manifest = this.saved(conn)
      const program = this.program(manifest)
      if (!Object.hasOwn(program.queries, name)) throw new Error('undeclared query')
      const relation = `${privateSchema}.${q(`result_${name}`)}`
      const sizes = conn.query(`SELECT sequence::VARCHAR AS cursor,octet_length(encode(value)) AS bytes FROM ${relation}
        WHERE sequence>${after} ORDER BY sequence LIMIT ${maxRows}`).toArray()
      let bytes = 2
      let next = after
      for (const row of sizes) {
        if (Number(row.bytes) + 2 > maxBytes) throw new Error('query result row exceeds byte limit')
        if (bytes + Number(row.bytes) + (next > after ? 1 : 0) > maxBytes) break
        bytes += Number(row.bytes) + (next > after ? 1 : 0)
        next = Number(row.cursor)
      }
      const fields = program.spec.queryTypes?.[name]
      const boundary = fields ? bindBoundary({ fields, types: program.spec.types! }) : undefined
      const rows = next === after ? [] : conn.query(`SELECT value FROM ${relation} WHERE sequence>${after} AND sequence<=${next} ORDER BY sequence`).toArray().map(row => {
        const value = JSON.parse(String(row.value), (_key, v) => {
          if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error('untyped query integer exceeds exact JSON range')
          return v
        })
        return boundary ? boundary.rows([value], 'duckdb')[0] : value
      })
      return { after, next, rows, done: !conn.query(`SELECT 1 FROM ${relation} WHERE sequence>${next} LIMIT 1`).toArray().length }
    })
  }
}
