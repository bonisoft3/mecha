import { EXECUTION_QUERY_BYTES, EXECUTION_QUERY_ROWS, EXECUTION_BYTES, EXECUTION_OUTPUT_BYTES, EXECUTION_OUTPUT_ROWS, scratchStatement, type ExecutionQueryPage } from './bounded.ts'
import { validateQuerySql } from './capture.ts'
import { losslessJson as json, parseLossless } from './json.ts'

type Row = Record<string, unknown>
/** What a host's DuckDB offers the core: workerd and duckdb-wasm wrap a synchronous binding, node-api is asynchronous. */
export interface ExecutionStatement { query(...values: string[]): Promise<Row[]>; close(): void | Promise<void> }
export interface ExecutionConnection {
  query(sql: string): Promise<Row[]>
  prepare(sql: string): Promise<ExecutionStatement>
  close(): void | Promise<void>
}
export interface ExecutionDatabase { connect(): Promise<ExecutionConnection> }
export interface ExecutionState { revision: number; checkpoint: unknown | null; done: boolean }
export interface ExecutionStep {
  checkpoint: unknown | null
  writes: Record<string, Row[]>
  statements?: string[]
  done: boolean
}
export interface ExecutionOutput { after: number; next: number; done: boolean; rows: Row[] }
const schema = 'duckdb_private'
const utf8 = new TextEncoder()

async function parameter(conn: ExecutionConnection, sql: string, ...values: string[]) {
  const statement = await conn.prepare(sql)
  try { return await statement.query(...values) }
  finally { await statement.close() }
}

/** A computation's step loop, the same on every host: one capture's numerical checkpoints and unpublished output remain in DuckDB. */
export class PagedExecution {
  private readonly sinks: readonly string[]

  private constructor(private readonly db: ExecutionDatabase, sinks: readonly string[]) {
    this.sinks = [...sinks].sort()
  }

  static async open(db: ExecutionDatabase, sinks: readonly string[]): Promise<PagedExecution> {
    if (!sinks.length || new Set(sinks).size !== sinks.length || sinks.some(sink => !/^[a-z_][a-z0-9_]{0,62}$/.test(sink))) {
      throw new Error('invalid execution sinks')
    }
    const execution = new PagedExecution(db, sinks)
    // An existing execution opens read-only, so a finished one pages its output from a read-only database.
    const exists = await execution.atomic(async conn => (await conn.query(`SELECT 1 FROM duckdb_tables()
      WHERE database_name=current_database() AND schema_name='${schema}' AND table_name='execution'`)).length > 0, true)
    if (!exists) await execution.atomic(async conn => {
      await conn.query(`CREATE SCHEMA ${schema};
        CREATE TABLE ${schema}.execution(id INTEGER PRIMARY KEY CHECK(id=1),revision BIGINT NOT NULL,checkpoint VARCHAR,done BOOLEAN NOT NULL);
        CREATE TABLE ${schema}.output_sinks(sink VARCHAR PRIMARY KEY,fields VARCHAR);
        CREATE TABLE ${schema}.scratch_tables(name VARCHAR PRIMARY KEY);
        CREATE SEQUENCE ${schema}.output_position START 1;
        CREATE TABLE ${schema}.output_rows(sink VARCHAR NOT NULL,id VARCHAR NOT NULL,
          position BIGINT NOT NULL DEFAULT nextval('${schema}.output_position'),value VARCHAR USING COMPRESSION UNCOMPRESSED NOT NULL);`)
      for (const sink of execution.sinks) await parameter(conn, `INSERT INTO ${schema}.output_sinks VALUES(?,NULL)`, sink)
      await conn.query(`INSERT INTO ${schema}.execution VALUES(1,0,NULL,false)`)
    })
    else await execution.atomic(async conn => {
      const names = (await conn.query(`SELECT sink FROM ${schema}.output_sinks ORDER BY sink`)).map(row => String(row.sink))
      if (JSON.stringify(names) !== JSON.stringify(execution.sinks)) throw new Error('execution sink declarations differ')
    }, true)
    return execution
  }

  private async atomic<T>(fn: (conn: ExecutionConnection) => Promise<T>, readonly = false): Promise<T> {
    const conn = await this.db.connect()
    let began = false
    try {
      await conn.query(readonly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN TRANSACTION')
      began = true
      const result = await fn(conn)
      await conn.query('COMMIT')
      began = false
      return result
    } catch (error) {
      if (began) {
        try { await conn.query('ROLLBACK') }
        catch (rollback) { throw new AggregateError([error, rollback], 'execution and rollback failed') }
      }
      throw error
    } finally { await conn.close() }
  }

  private async current(conn: ExecutionConnection): Promise<ExecutionState> {
    const rows = await conn.query(`SELECT revision::VARCHAR AS revision,checkpoint,done FROM ${schema}.execution WHERE id=1`)
    if (rows.length !== 1) throw new Error('execution state is missing')
    const revision = Number(rows[0].revision)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid execution revision')
    return { revision, checkpoint: rows[0].checkpoint === null ? null : parseLossless(String(rows[0].checkpoint)), done: rows[0].done === true }
  }

  async state(): Promise<ExecutionState> { return await this.atomic(conn => this.current(conn), true) }

  async query(sql: string): Promise<Row[]> {
    if (typeof sql !== 'string' || !sql.trim() || utf8.encode(sql).length > EXECUTION_BYTES) throw new Error('invalid execution query')
    return await this.atomic(async conn => (await parameter(conn, `WITH execution_rows AS MATERIALIZED (
        SELECT to_json(struct_pack(*COLUMNS(*)))::VARCHAR AS value FROM (${sql}) r
      ), execution_size AS (
        SELECT COALESCE(sum(octet_length(encode(value))+1),0)+1 AS bytes FROM execution_rows
      ) SELECT CASE WHEN execution_size.bytes>${EXECUTION_BYTES} THEN error('execution query exceeds byte limit')
        ELSE execution_rows.value END AS value FROM execution_rows CROSS JOIN execution_size`))
      .map(row => parseLossless(String(row.value)) as Row), true)
  }

  async queryPage(sql: string, orderBy: string, revision: number, after = -1): Promise<ExecutionQueryPage> {
    if (typeof sql !== 'string' || !sql.trim() || utf8.encode(sql).length > EXECUTION_BYTES ||
      typeof orderBy !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/i.test(orderBy) ||
      !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(after) || after < -1) {
      throw new Error('invalid execution query page')
    }
    return await this.atomic(async conn => {
      const current = await this.current(conn)
      if (current.revision !== revision || current.done) throw new Error('execution query revision differs')
      await validateQuerySql(conn, sql)
      const key = `"${orderBy}"`
      if (after === -1) {
        const invalid = await parameter(conn, `SELECT 1 FROM (${sql}) r WHERE ${key} IS NULL
          OR NOT isfinite(${key}) OR ${key}<0 OR ${key}>9007199254740991 OR ${key}<>trunc(${key}) LIMIT 1`)
        if (invalid.length) throw new Error('execution query ordering key must be a nonnegative safe integer')
      }
      // Include the last delivered key: a duplicate split by a page boundary must not disappear.
      const relation = `SELECT * FROM (${sql}) r WHERE ${key}>=${after} ORDER BY ${key} LIMIT ${EXECUTION_QUERY_ROWS + 2}`
      const sizes = await parameter(conn, `SELECT ${key}::VARCHAR AS cursor,octet_length(encode(to_json(struct_pack(*COLUMNS(*)))::VARCHAR)) AS bytes FROM (${relation}) r ORDER BY ${key}`)
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
      const rows = count ? (await parameter(conn, `SELECT to_json(struct_pack(*COLUMNS(*)))::VARCHAR AS value FROM (${sql}) r
        WHERE ${key}>${after} AND ${key}<=${next} ORDER BY ${key}`))
        .map(row => parseLossless(String(row.value)) as Row) : []
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

  async commit(expectedRevision: number, step: ExecutionStep): Promise<ExecutionState> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid execution revision')
    const state = await this.atomic(async conn => {
      const current = await this.current(conn)
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
        const saved = (await parameter(conn, `SELECT fields FROM ${schema}.output_sinks WHERE sink=?`, sink))[0].fields
        if (saved !== null && saved !== JSON.stringify(fields)) throw new Error('execution output columns differ')
        writes.set(sink, values)
      }
      const scratch = (step.statements ?? []).map(scratchStatement)
      const owned = new Set((await conn.query(`SELECT name FROM ${schema}.scratch_tables`)).map(row => String(row.name)))
      const prepared: ExecutionStatement[] = []
      try {
        // Prepare rejects multiple statements before execution. Batches cannot depend on a table created in that same batch.
        for (const statement of scratch) {
          if (statement.operation !== 'CREATE TABLE' && !owned.has(statement.name)) throw new Error('execution statement does not own scratch table')
          if (statement.select !== undefined) await validateQuerySql(conn, statement.select)
          prepared.push(await conn.prepare(statement.sql))
        }
        for (const statement of prepared) await statement.query()
      } finally { for (const statement of prepared) await statement.close() }
      for (const statement of scratch) {
        if (statement.operation === 'CREATE TABLE') await parameter(conn, `INSERT INTO ${schema}.scratch_tables VALUES(?)`, statement.name)
        else if (statement.operation === 'DROP TABLE') await parameter(conn, `DELETE FROM ${schema}.scratch_tables WHERE name=?`, statement.name)
      }
      for (const [sink, values] of writes) {
        await parameter(conn, `UPDATE ${schema}.output_sinks SET fields=? WHERE sink=?`, JSON.stringify(Object.keys(JSON.parse(values[0])).sort()), sink)
      }
      if (writes.size) {
        await conn.query('CREATE TEMP TABLE execution_incoming(sink VARCHAR,id VARCHAR,value VARCHAR)')
        const statement = await conn.prepare(`INSERT INTO execution_incoming SELECT ?,json_extract_string(value,'$.id'),value::VARCHAR FROM json_each(?)`)
        try {
          for (const [sink, values] of writes) {
            let batch: string[] = [], bytes = 2
            for (const value of values) {
              const size = utf8.encode(value).length
              if (batch.length && (batch.length === 32 || bytes + size + (batch.length ? 1 : 0) > EXECUTION_OUTPUT_BYTES)) {
                await statement.query(sink, `[${batch.join(',')}]`)
                batch = []; bytes = 2
              }
              bytes += size + (batch.length ? 1 : 0)
              batch.push(value)
            }
            if (batch.length) await statement.query(sink, `[${batch.join(',')}]`)
          }
        } finally { await statement.close() }
        await conn.query(`MERGE INTO ${schema}.output_rows AS target USING execution_incoming AS incoming
          ON target.sink=incoming.sink AND target.id=incoming.id
          WHEN MATCHED THEN UPDATE SET value=incoming.value
          WHEN NOT MATCHED THEN INSERT(sink,id,value) VALUES(incoming.sink,incoming.id,incoming.value)`)
      }
      // Publication follows ids, so output does not depend on which step wrote a row.
      if (step.done) {
        await conn.query(`UPDATE ${schema}.output_rows AS o SET position=r.ordinal
          FROM (SELECT sink,id,row_number() OVER (PARTITION BY sink ORDER BY id) AS ordinal FROM ${schema}.output_rows) r
          WHERE o.sink=r.sink AND o.id=r.id`)
      }
      await parameter(conn, `UPDATE ${schema}.execution SET revision=CAST(? AS BIGINT),checkpoint=?,done=CAST(? AS BOOLEAN) WHERE id=1`,
        String(current.revision + 1), json(step.checkpoint), String(step.done))
      return this.current(conn)
    })
    // Committed append buffers must become evictable before the next step.
    const conn = await this.db.connect()
    try { await conn.query('CHECKPOINT') }
    finally { await conn.close() }
    return state
  }

  private async complete(conn: ExecutionConnection) {
    if ((await conn.query(`SELECT done FROM ${schema}.execution WHERE id=1`))[0]?.done !== true) {
      throw new Error('execution output is not complete')
    }
  }

  /** A finished execution's scratch tables hold nothing its output needs. */
  async dropScratch(): Promise<void> {
    return await this.atomic(async conn => {
      await this.complete(conn)
      for (const row of await conn.query(`SELECT name FROM ${schema}.scratch_tables`)) {
        await conn.query(`DROP TABLE main."${String(row.name)}"`)
      }
      await conn.query(`DELETE FROM ${schema}.scratch_tables`)
    })
  }

  async manifest(): Promise<Record<string, { rows: number }>> {
    return await this.atomic(async conn => {
      await this.complete(conn)
      const counts = await conn.query(`SELECT sink,count(*)::VARCHAR AS rows FROM ${schema}.output_rows GROUP BY sink`)
      return Object.fromEntries(this.sinks.map(sink => {
        const rows = Number(counts.find(row => row.sink === sink)?.rows ?? 0)
        if (!Number.isSafeInteger(rows)) throw new Error('execution output count exceeds exact range')
        return [sink, { rows }]
      }))
    }, true)
  }

  async output(sink: string, after = 0): Promise<ExecutionOutput> {
    if (!this.sinks.includes(sink) || !Number.isSafeInteger(after) || after < 0) throw new Error('invalid execution output cursor')
    return await this.atomic(async conn => {
      await this.complete(conn)
      const sizes = await parameter(conn, `SELECT position::VARCHAR AS position,octet_length(encode(value)) AS bytes
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
      const rows = next === after ? [] : (await parameter(conn, `SELECT value FROM ${schema}.output_rows
        WHERE sink=? AND position>CAST(? AS BIGINT) AND position<=CAST(? AS BIGINT) ORDER BY position`, sink, String(after), String(next)))
        .map(row => parseLossless(String(row.value)) as Row)
      const more = await parameter(conn, `SELECT 1 FROM ${schema}.output_rows WHERE sink=? AND position>CAST(? AS BIGINT) LIMIT 1`, sink, String(next))
      return { after, next, done: !more.length, rows }
    }, true)
  }
}
