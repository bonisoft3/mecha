import { validateQuerySql } from './query-sql.ts'
export interface ExecutionConnection {
  query(sql: string): { toArray(): Record<string, unknown>[] }
  prepare(sql: string): { query(...values: string[]): { toArray(): Record<string, unknown>[] }; close(): void }
  close(): void
}
export interface ExecutionDatabase { connect(): ExecutionConnection }
export interface ExecutionState { revision: number; checkpoint: unknown | null; done: boolean }
export interface ExecutionStep {
  checkpoint: unknown | null
  writes: Record<string, Record<string, unknown>[]>
  statements?: string[]
  done: boolean
}
export interface ExecutionOutput { after: number; next: number; done: boolean; rows: Record<string, unknown>[] }
export interface ExecutionQueryPage { after: number; next: number; done: boolean; rows: Record<string, unknown>[] }
export const EXECUTION_QUERY_BYTES = 1024 * 1024
export const EXECUTION_QUERY_ROWS = 4096
export const EXECUTION_BYTES = 8 * 1024 * 1024
export const EXECUTION_OUTPUT_BYTES = 256 * 1024
export const EXECUTION_OUTPUT_ROWS = 128
const schema = 'duckdb_private'
const utf8 = new TextEncoder()
const scratchName = '[a-z_][a-z0-9_]{0,62}'
const scratchLiteral = "(?:NULL|TRUE|FALSE|[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?|'(?:[^']|'')*')"
const scratchColumn = `${scratchName}\\s+[a-z_][a-z0-9_]*(?:\\s*\\(\\s*[0-9]+(?:\\s*,\\s*[0-9]+)?\\s*\\))?(?:\\[\\])*`
const scratchValues = `${scratchLiteral}(?:\\s*,\\s*${scratchLiteral})*`
const scratchPredicate = `${scratchName}\\s*(?:=\\s*${scratchLiteral}|IN\\s*\\(\\s*${scratchValues}\\s*\\))`

function scratchStatement(sql: string) {
  const match = /^\s*(CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE)\s+([a-z_][a-z0-9_]{0,62})(?=\s|\(|;|$)/i.exec(sql)
  if (!match) throw new Error('execution statements must target an unqualified scratch table')
  const operation = match[1].toUpperCase().replace(/\s+/g, ' ')
  const name = match[2].toLowerCase()
  const tail = sql.slice(match[0].length)
  if (/^(?:duckdb_|duckstream_|execution_)/.test(name) || /\bnextval\b|\bU\s*&/i.test(sql)) throw new Error('execution statement uses reserved storage')
  const supported = operation === 'CREATE TABLE' ? /^\s+AS\s+(?:SELECT|WITH)\b/i.test(tail) || new RegExp(`^\\s*\\(\\s*${scratchColumn}(?:\\s*,\\s*${scratchColumn})*\\s*\\)\\s*;?\\s*$`, 'i').test(tail)
    : operation === 'INSERT INTO' ? new RegExp(`^\\s+VALUES\\s*\\(\\s*${scratchValues}\\s*\\)(?:\\s*,\\s*\\(\\s*${scratchValues}\\s*\\))*\\s*;?\\s*$`, 'i').test(tail)
    : operation === 'DELETE FROM' ? new RegExp(`^\\s+WHERE\\s+${scratchPredicate}(?:\\s+AND\\s+${scratchPredicate})*\\s*;?\\s*$`, 'i').test(tail)
    : /^\s*;?\s*$/.test(tail)
  if (!supported) throw new Error('unsupported execution scratch statement')
  return { operation, name, sql: `${operation} main."${name}"${tail}`, select: operation === 'CREATE TABLE' ? /^\s+AS\s+([\s\S]+)$/i.exec(tail)?.[1] : undefined }
}

function json(value: unknown): string {
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return
    if (Array.isArray(item)) { item.forEach(visit); return }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) { Object.values(item).forEach(visit); return }
    throw new Error('execution requires finite lossless JSON')
  }
  visit(value)
  return JSON.stringify(value)
}

function parse(value: unknown): unknown {
  return JSON.parse(String(value), (_key, item) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) {
      throw new Error('execution query requires finite lossless JSON')
    }
    return item
  })
}

/** One capture's numerical checkpoints and unpublished output remain in DuckDB. */
export class PagedExecution {
  private readonly sinks: readonly string[]

  constructor(private readonly db: ExecutionDatabase, sinks: readonly string[]) {
    if (!sinks.length || new Set(sinks).size !== sinks.length || sinks.some(sink => !/^[a-z_][a-z0-9_]{0,62}$/.test(sink))) {
      throw new Error('invalid execution sinks')
    }
    this.sinks = [...sinks].sort()
    this.atomic(conn => {
      conn.query(`CREATE SCHEMA IF NOT EXISTS ${schema};
        CREATE TABLE IF NOT EXISTS ${schema}.execution(id INTEGER PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL,checkpoint VARCHAR,done BOOLEAN NOT NULL);
        CREATE TABLE IF NOT EXISTS ${schema}.output_sinks(sink VARCHAR PRIMARY KEY,fields VARCHAR);
        CREATE TABLE IF NOT EXISTS ${schema}.scratch_tables(name VARCHAR PRIMARY KEY);
        CREATE SEQUENCE IF NOT EXISTS ${schema}.output_position START 1;
        CREATE TABLE IF NOT EXISTS ${schema}.output_rows(sink VARCHAR NOT NULL,id VARCHAR NOT NULL,
          position BIGINT NOT NULL DEFAULT nextval('${schema}.output_position'),value VARCHAR USING COMPRESSION UNCOMPRESSED NOT NULL);`)
      const saved = conn.query(`SELECT revision FROM ${schema}.execution WHERE id=1`).toArray()
      if (saved.length) {
        const names = conn.query(`SELECT sink FROM ${schema}.output_sinks ORDER BY sink`).toArray().map(row => String(row.sink))
        if (JSON.stringify(names) !== JSON.stringify(this.sinks)) throw new Error('execution sink declarations differ')
      } else {
        for (const sink of this.sinks) this.parameter(conn, `INSERT INTO ${schema}.output_sinks VALUES(?,NULL)`, sink)
        conn.query(`INSERT INTO ${schema}.execution VALUES(1,0,NULL,false)`)
      }
    })
  }

  private atomic<T>(fn: (conn: ExecutionConnection) => T, readonly = false): T {
    const conn = this.db.connect()
    let began = false
    try {
      conn.query(readonly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN TRANSACTION')
      began = true
      const result = fn(conn)
      conn.query('COMMIT')
      began = false
      return result
    } catch (error) {
      if (began) {
        try { conn.query('ROLLBACK') }
        catch (rollback) { throw new AggregateError([error, rollback], 'execution and rollback failed') }
      }
      throw error
    } finally { conn.close() }
  }

  private parameter(conn: ExecutionConnection, sql: string, ...values: string[]) {
    const statement = conn.prepare(sql)
    try { return statement.query(...values).toArray() }
    finally { statement.close() }
  }

  private current(conn: ExecutionConnection): ExecutionState {
    const rows = conn.query(`SELECT revision::VARCHAR AS revision,checkpoint,done FROM ${schema}.execution WHERE id=1`).toArray()
    if (rows.length !== 1) throw new Error('execution state is missing')
    const revision = Number(rows[0].revision)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid execution revision')
    return { revision, checkpoint: rows[0].checkpoint === null ? null : parse(rows[0].checkpoint), done: rows[0].done === true }
  }

  state(): ExecutionState { return this.atomic(conn => this.current(conn), true) }

  query(sql: string): Record<string, unknown>[] {
    if (typeof sql !== 'string' || !sql.trim() || utf8.encode(sql).length > EXECUTION_BYTES) throw new Error('invalid execution query')
    return this.atomic(conn => this.parameter(conn, `WITH execution_rows AS MATERIALIZED (
        SELECT to_json(r)::VARCHAR AS value FROM (${sql}) r
      ), execution_size AS (
        SELECT COALESCE(sum(octet_length(encode(value))+1),0)+1 AS bytes FROM execution_rows
      ) SELECT CASE WHEN execution_size.bytes>${EXECUTION_BYTES} THEN error('execution query exceeds byte limit')
        ELSE execution_rows.value END AS value FROM execution_rows CROSS JOIN execution_size`)
      .map(row => parse(row.value) as Record<string, unknown>), true)
  }

  queryPage(sql: string, orderBy: string, revision: number, after = -1): ExecutionQueryPage {
    if (typeof sql !== 'string' || !sql.trim() || utf8.encode(sql).length > EXECUTION_BYTES ||
      typeof orderBy !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/i.test(orderBy) ||
      !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(after) || after < -1) {
      throw new Error('invalid execution query page')
    }
    return this.atomic(conn => {
      const current = this.current(conn)
      if (current.revision !== revision || current.done) throw new Error('execution query revision differs')
      validateQuerySql(conn, sql)
      const key = `"${orderBy}"`
      if (after === -1) {
        const invalid = this.parameter(conn, `SELECT 1 FROM (${sql}) r WHERE ${key} IS NULL
          OR NOT isfinite(${key}) OR ${key}<0 OR ${key}>9007199254740991 OR ${key}<>trunc(${key}) LIMIT 1`)
        if (invalid.length) throw new Error('execution query ordering key must be a nonnegative safe integer')
      }
      // Include the last delivered key: a duplicate split by a page boundary must not disappear.
      const relation = `SELECT * FROM (${sql}) r WHERE ${key}>=${after} ORDER BY ${key} LIMIT ${EXECUTION_QUERY_ROWS + 2}`
      const sizes = this.parameter(conn, `SELECT ${key}::VARCHAR AS cursor,octet_length(encode(to_json(r)::VARCHAR)) AS bytes FROM (${relation}) r ORDER BY ${key}`)
      let offset = 0
      if (after !== -1) {
        if (Number(sizes[0]?.cursor) !== after) throw new Error('execution query cursor disappeared')
        offset = 1
      }
      let next = after, bytes = 2, count = 0
      for (let i = offset; i < sizes.length; i++) {
        const cursor = Number(sizes[i].cursor)
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor <= next) throw new Error('execution query ordering keys must strictly increase')
        if (count === EXECUTION_QUERY_ROWS || bytes + Number(sizes[i].bytes) + (count ? 1 : 0) > EXECUTION_QUERY_BYTES) {
          if (!count) throw new Error('execution query row exceeds page byte limit')
          break
        }
        bytes += Number(sizes[i].bytes) + (count ? 1 : 0)
        next = cursor
        count++
      }
      const rows = count ? this.parameter(conn, `SELECT to_json(r)::VARCHAR AS value FROM (${sql}) r
        WHERE ${key}>${after} AND ${key}<=${next} ORDER BY ${key}`)
        .map(row => parse(row.value) as Record<string, unknown>) : []
      if (rows.length !== count) throw new Error('execution query page changed')
      let previous = after
      for (const row of rows) {
        const cursor = row[orderBy]
        if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= previous) throw new Error('execution query ordering keys must strictly increase')
        previous = cursor
        delete row[orderBy]
      }
      return { after, next, done: offset + count === sizes.length, rows }
    }, true)
  }

  commit(expectedRevision: number, step: ExecutionStep): ExecutionState {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid execution revision')
    const state = this.atomic(conn => {
      const current = this.current(conn)
      if (current.revision !== expectedRevision) return current
      if (current.done) throw new Error('execution is complete')
      if (!step || typeof step.done !== 'boolean' || !step.writes || Array.isArray(step.writes) ||
        Object.getPrototypeOf(step.writes) !== Object.prototype ||
        step.statements !== undefined && (!Array.isArray(step.statements) || step.statements.some(sql => typeof sql !== 'string' || !sql.trim()))) {
        throw new Error('invalid execution step')
      }
      const encoded = json(step)
      if (utf8.encode(encoded).length > EXECUTION_BYTES) throw new Error('execution step exceeds byte limit')
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('execution revision exhausted')
      const writes = new Map<string, string[]>()
      for (const [sink, rows] of Object.entries(step.writes)) {
        if (!this.sinks.includes(sink) || !Array.isArray(rows)) throw new Error('undeclared execution sink or invalid rows')
        if (!rows.length) continue
        const fields = Object.keys(rows[0]).sort()
        if (!fields.includes('id')) throw new Error('execution output requires text ids')
        const ids = new Set<string>()
        const values = rows.map(row => {
          if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || ids.has(row.id) ||
            JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(fields)) throw new Error('invalid execution output row')
          ids.add(row.id)
          const value = json(row)
          if (utf8.encode(value).length + 2 > EXECUTION_OUTPUT_BYTES) throw new Error('execution output row exceeds byte limit')
          return value
        })
        const saved = this.parameter(conn, `SELECT fields FROM ${schema}.output_sinks WHERE sink=?`, sink)[0].fields
        if (saved !== null && saved !== JSON.stringify(fields)) throw new Error('execution output columns differ')
        writes.set(sink, values)
      }
      const scratch = (step.statements ?? []).map(scratchStatement)
      const owned = new Set(conn.query(`SELECT name FROM ${schema}.scratch_tables`).toArray().map(row => String(row.name)))
      const prepared: ReturnType<ExecutionConnection['prepare']>[] = []
      try {
        // Prepare rejects multiple statements before execution. Batches cannot depend on a table created in that same batch.
        for (const statement of scratch) {
          if (statement.operation !== 'CREATE TABLE' && !owned.has(statement.name)) throw new Error('execution statement does not own scratch table')
          if (statement.select !== undefined) validateQuerySql(conn, statement.select)
          prepared.push(conn.prepare(statement.sql))
        }
        for (const statement of prepared) statement.query()
      } finally { for (const statement of prepared) statement.close() }
      for (const statement of scratch) {
        if (statement.operation === 'CREATE TABLE') this.parameter(conn, `INSERT INTO ${schema}.scratch_tables VALUES(?)`, statement.name)
        else if (statement.operation === 'DROP TABLE') this.parameter(conn, `DELETE FROM ${schema}.scratch_tables WHERE name=?`, statement.name)
      }
      for (const [sink, values] of writes) {
        this.parameter(conn, `UPDATE ${schema}.output_sinks SET fields=? WHERE sink=?`, JSON.stringify(Object.keys(JSON.parse(values[0])).sort()), sink)
      }
      if (writes.size) {
        conn.query('CREATE TEMP TABLE execution_incoming(sink VARCHAR,id VARCHAR,value VARCHAR)')
        const statement = conn.prepare(`INSERT INTO execution_incoming SELECT ?,json_extract_string(value,'$.id'),value::VARCHAR FROM json_each(?)`)
        try {
          for (const [sink, values] of writes) {
            let batch: string[] = [], bytes = 2
            for (const value of values) {
              const size = utf8.encode(value).length
              if (batch.length && (batch.length === 32 || bytes + size + (batch.length ? 1 : 0) > EXECUTION_OUTPUT_BYTES)) {
                statement.query(sink, `[${batch.join(',')}]`)
                batch = []; bytes = 2
              }
              bytes += size + (batch.length ? 1 : 0)
              batch.push(value)
            }
            if (batch.length) statement.query(sink, `[${batch.join(',')}]`)
          }
        } finally { statement.close() }
        conn.query(`MERGE INTO ${schema}.output_rows AS target USING execution_incoming AS incoming
          ON target.sink=incoming.sink AND target.id=incoming.id
          WHEN MATCHED THEN UPDATE SET value=incoming.value
          WHEN NOT MATCHED THEN INSERT(sink,id,value) VALUES(incoming.sink,incoming.id,incoming.value)`)
      }
      this.parameter(conn, `UPDATE ${schema}.execution SET revision=CAST(? AS BIGINT),checkpoint=?,done=CAST(? AS BOOLEAN) WHERE id=1`,
        String(current.revision + 1), json(step.checkpoint), String(step.done))
      return this.current(conn)
    })
    // Committed append buffers must become evictable before the next step.
    const conn = this.db.connect()
    try { conn.query('CHECKPOINT') }
    finally { conn.close() }
    return state
  }

  private complete(conn: ExecutionConnection) {
    if (conn.query(`SELECT done FROM ${schema}.execution WHERE id=1`).toArray()[0]?.done !== true) {
      throw new Error('execution output is not complete')
    }
  }

  manifest(): Record<string, { rows: number }> {
    return this.atomic(conn => {
      this.complete(conn)
      const counts = conn.query(`SELECT sink,count(*)::VARCHAR AS rows FROM ${schema}.output_rows GROUP BY sink`).toArray()
      return Object.fromEntries(this.sinks.map(sink => {
        const rows = Number(counts.find(row => row.sink === sink)?.rows ?? 0)
        if (!Number.isSafeInteger(rows)) throw new Error('execution output count exceeds exact range')
        return [sink, { rows }]
      }))
    }, true)
  }

  output(sink: string, after = 0): ExecutionOutput {
    if (!this.sinks.includes(sink) || !Number.isSafeInteger(after) || after < 0) throw new Error('invalid execution output cursor')
    return this.atomic(conn => {
      this.complete(conn)
      const sizes = this.parameter(conn, `SELECT position::VARCHAR AS position,octet_length(encode(value)) AS bytes
        FROM ${schema}.output_rows WHERE sink=? AND position>CAST(? AS BIGINT) ORDER BY output_rows.position LIMIT ${EXECUTION_OUTPUT_ROWS}`, sink, String(after))
      let next = after, bytes = 2
      for (const row of sizes) {
        if (bytes + Number(row.bytes) + (next > after ? 1 : 0) > EXECUTION_OUTPUT_BYTES) {
          if (next === after) throw new Error('execution output row exceeds byte limit')
          break
        }
        bytes += Number(row.bytes) + (next > after ? 1 : 0)
        next = Number(row.position)
        if (!Number.isSafeInteger(next)) throw new Error('execution output cursor exceeds exact range')
      }
      const rows = next === after ? [] : this.parameter(conn, `SELECT value FROM ${schema}.output_rows
        WHERE sink=? AND position>CAST(? AS BIGINT) AND position<=CAST(? AS BIGINT) ORDER BY position`, sink, String(after), String(next))
        .map(row => parse(row.value) as Record<string, unknown>)
      const more = this.parameter(conn, `SELECT 1 FROM ${schema}.output_rows WHERE sink=? AND position>CAST(? AS BIGINT) LIMIT 1`, sink, String(next))
      return { after, next, done: !more.length, rows }
    }, true)
  }
}
