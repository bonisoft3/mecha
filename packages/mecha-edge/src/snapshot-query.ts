import { bindBoundary, typedSql } from '../../../services/compute/portable-contract.ts'
import { snapshotStatements, type Snapshot } from '../../../services/compute/snapshot-data.ts'
import { identity, programFor, type SnapshotProgram } from './snapshot-program.ts'

interface Connection {
  query(sql: string): { toArray(): Record<string, unknown>[] }
  prepare(sql: string): { query(...values: string[]): unknown; close(): void }
  close(): void
}
export interface QueryDatabase { connect(): Connection }

/** The database is scratch space; only the coordinator owns publication authority. */
export function snapshotQuery(db: QueryDatabase, programs: readonly SnapshotProgram[], snapshot: Snapshot) {
  const program = programFor(programs, snapshot)
  const statements = snapshotStatements(snapshot.tables, program.reads, program.spec.types)
  const conn = db.connect()
  let began = false
  try {
    conn.query('BEGIN TRANSACTION')
    began = true
    for (const [index, table] of statements.entries()) {
      conn.query(table.create)
      const statement = conn.prepare(table.insert)
      try {
        // Bound JSON parsing work and avoid Emscripten's fixed argument stack.
        const rows = snapshot.tables[program.reads[index]].rows
        for (let offset = 0; offset < rows.length; offset += 32) {
          statement.query(JSON.stringify(rows.slice(offset, offset + 32)))
        }
      }
      finally { statement.close() }
    }
    const inputs: Record<string, unknown[]> = {}
    for (const [name, sql] of Object.entries(program.queries)) {
      const fields = program.spec.queryTypes?.[name]
      const boundary = fields ? bindBoundary({ fields, types: program.spec.types! }) : undefined
      if (boundary) boundary.columns(conn.query(`DESCRIBE (${sql})`).toArray().map(row => String(row.column_name)))
      const query = boundary ? typedSql(boundary.bound.canonicalType, sql, fields!) : sql
      inputs[name] = conn.query(`SELECT to_json(r)::VARCHAR AS value FROM (${query}) r`).toArray().map(row => {
        const value = JSON.parse(row.value as string, (_key, v) => {
          if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error('untyped query integer exceeds exact JSON range')
          return v
        })
        return boundary ? boundary.rows([value], 'duckdb')[0] : value
      })
    }
    return { ...identity(snapshot), inputs }
  } finally {
    try { if (began) conn.query('ROLLBACK') }
    finally { conn.close() }
  }
}
