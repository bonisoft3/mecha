import type { PortableType } from '../../client/src/types.ts'
import { typedSql } from '../../lake/src/lake-types.ts'
import { bindBoundary, type TypeBoundary } from './boundary.ts'
import { validateQueryAst } from './bounded.ts'
import type { ExecutionConnection } from './execution.ts'
import { parseLossless, strictJson } from './json.ts'

/**
 * A captured relation: each query's rows, in query order, stored as the exact
 * text a computation reads and a digest hashes. Every host captures through
 * these functions, so the same rows give the same text and the same digest.
 */

type Row = Record<string, unknown>
export const CAPTURE_ROW_BYTES = 1024 * 1024
const PAGE_ROWS = 4096
const PAGE_BYTES = 512 * 1024
const APPEND_BYTES = 2 * 1024 * 1024
const utf8 = new TextEncoder()
const bytes = (text: string) => utf8.encode(text).length
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

async function parameter(conn: ExecutionConnection, sql: string, ...values: string[]) {
  const statement = await conn.prepare(sql)
  try { return await statement.query(...values) }
  finally { await statement.close() }
}

const INTEGERS = ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT']
// JSON is VARCHAR to DuckDB's physical layout.
const PHYSICAL: Record<PortableType, readonly string[]> = {
  string: ['VARCHAR', 'JSON', 'ENUM'],
  bool: ['BOOLEAN'],
  int32: INTEGERS,
  int64: [...INTEGERS, 'VARCHAR', 'JSON'],
  double: ['FLOAT', 'DOUBLE'],
  bytes: ['BLOB'],
  uuid: ['UUID', 'VARCHAR', 'JSON'],
  timestamp: ['TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS'],
  date: ['DATE'],
  time: ['TIME', 'TIME_NS'],
  timezone: ['VARCHAR', 'JSON'],
  duration: ['INTERVAL'],
  decimal: [...INTEGERS, 'DECIMAL', 'VARCHAR', 'JSON'],
  json: ['VARCHAR', 'JSON'],
  geojson: ['VARCHAR', 'JSON'],
}

/** Parse before binding: dynamic SQL can hide nontransactional sequence writes. */
export async function validateQuerySql(conn: ExecutionConnection, sql: string) {
  validateQueryAst(JSON.parse(String((await parameter(conn, 'SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast', sql))[0].ast)))
}

/** A query's SQL with its portable types projected, and the row check that completes them. */
export async function typedQuery(conn: ExecutionConnection, sql: string, boundary?: TypeBoundary) {
  await validateQuerySql(conn, sql)
  const described = await conn.query(`DESCRIBE (${sql})`)
  const names = described.map(row => String(row.column_name))
  // A JSON column reaches a computation as its text, as a VARCHAR would, not as the value it encodes.
  const texts = described.filter(row => row.column_type === 'JSON').map(row => quote(String(row.column_name)))
  const carried = (typed: string) => texts.length
    ? `SELECT * REPLACE (${texts.map(name => `CAST(${name} AS VARCHAR) AS ${name}`).join(',')}) FROM (${typed}) "_capture_text"`
    : typed
  if (!boundary) return { names, sql: carried(sql), rows: (rows: Row[]) => rows }
  const held = bindBoundary(boundary)
  held.columns(names)
  // Check before projection hides physical types or a conversion rounds a decimal.
  for (const field of boundary.fields) {
    const physical = String(described[names.indexOf(field.name)].column_type)
    const base = physical.startsWith('DECIMAL(') ? 'DECIMAL' : physical.startsWith('ENUM(') ? 'ENUM' : physical
    if (base !== '"NULL"' && !PHYSICAL[field.type as PortableType].includes(base)) {
      throw new Error(`portable field ${field.name}: ${physical} requires an explicit SQL cast for ${field.type}`)
    }
  }
  return { names, sql: carried(typedSql(held.bound.canonicalType, sql, boundary.fields)), rows: (rows: Row[]) => held.rows(rows, 'duckdb') }
}

/** Appends canonical row texts to `target(sequence, value)` after `offset`, bound as one JSON array of strings. */
export async function appendCapture(conn: ExecutionConnection, target: string, offset: number, texts: readonly string[]) {
  const statement = await conn.prepare(`INSERT INTO ${target}
    SELECT CAST(? AS BIGINT)+CAST(key AS BIGINT)+1,json_extract_string(value,'$') FROM json_each(?)`)
  try {
    let batch: string[] = [], size = 2
    const flush = async () => {
      if (!batch.length) return
      await statement.query(String(offset), JSON.stringify(batch))
      offset += batch.length
      batch = []; size = 2
    }
    for (const text of texts) {
      const encoded = bytes(JSON.stringify(text)) + 1
      if (batch.length && size + encoded > APPEND_BYTES) await flush()
      batch.push(text)
      size += encoded
    }
    await flush()
  } finally { await statement.close() }
}

/** The canonical text of a row: lossless JSON through the boundary, serialized as a computation reads it. */
export function captureText(row: Row): string {
  const text = strictJson(row)
  if (bytes(text) > CAPTURE_ROW_BYTES) throw new Error('capture row exceeds byte limit')
  return text
}

/** Captures one query into the host's empty `target(sequence, value)`; DuckDB renders each row once and only a bounded page crosses JS. */
export async function captureQuery(conn: ExecutionConnection, target: string, sql: string, boundary?: TypeBoundary) {
  const typed = await typedQuery(conn, sql, boundary)
  const raw = 'duckstream_private.capture_input'
  await conn.query(`CREATE TABLE ${raw} AS SELECT row_number() OVER () AS ordinal,
    to_json(struct_pack(*COLUMNS(*)))::VARCHAR AS value FROM (${typed.sql}) r`)
  if ((await conn.query(`SELECT 1 FROM ${raw} WHERE octet_length(encode(value))>${CAPTURE_ROW_BYTES} LIMIT 1`)).length) {
    throw new Error('capture row exceeds byte limit')
  }
  for (let offset = 0;;) {
    const values = (await conn.query(`SELECT value FROM ${raw} WHERE ordinal>${offset} AND ordinal<=${offset}+(
        SELECT greatest(count(*),1) FROM (SELECT ordinal,sum(octet_length(encode(value))) OVER (ORDER BY ordinal) AS size
          FROM ${raw} WHERE ordinal>${offset} AND ordinal<=${offset + PAGE_ROWS}) WHERE size<=${PAGE_BYTES})
      ORDER BY ordinal`)).map(row => parseLossless(String(row.value)) as Row)
    if (!values.length) break
    await appendCapture(conn, target, offset, typed.rows(values).map(captureText))
    offset += values.length
  }
  await conn.query(`DROP TABLE ${raw}`)
}

/** Feeds a captured relation's row hashes, sorted by DuckDB once, to `update`, a line each. */
export async function captureDigest(conn: ExecutionConnection, target: string, update: (line: string) => void) {
  const hashes = 'capture_hashes'
  await conn.query(`CREATE TEMP TABLE ${hashes} AS SELECT row_number() OVER (ORDER BY hash) AS ordinal,hash
    FROM (SELECT sha256(value) AS hash FROM ${target})`)
  try {
    for (let after = 0;; after += PAGE_ROWS) {
      const rows = await conn.query(`SELECT hash FROM ${hashes} WHERE ordinal>${after} AND ordinal<=${after + PAGE_ROWS} ORDER BY ordinal`)
      for (const row of rows) update(`${row.hash}\n`)
      if (rows.length < PAGE_ROWS) break
    }
  } finally { await conn.query(`DROP TABLE ${hashes}`) }
}

/** A query's captured rows at once, for a host whose computation reads every input in one call; the caller's transaction holds the table. */
export async function capturedRows(conn: ExecutionConnection, sql: string, boundary?: TypeBoundary): Promise<Row[]> {
  await conn.query('CREATE SCHEMA IF NOT EXISTS duckstream_private')
  const target = 'duckstream_private.captured_rows'
  await conn.query(`CREATE TABLE ${target}(sequence BIGINT,value VARCHAR)`)
  await captureQuery(conn, target, sql, boundary)
  const rows = (await conn.query(`SELECT value FROM ${target} ORDER BY sequence`)).map(row => parseLossless(String(row.value)) as Row)
  await conn.query(`DROP TABLE ${target}`)
  return rows
}
