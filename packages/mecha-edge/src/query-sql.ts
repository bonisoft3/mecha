import { validateQueryAst } from '../../compute-snapshot/src/bounded.ts'
export { validateQueryAst } from '../../compute-snapshot/src/bounded.ts'
interface Connection {
  prepare(sql: string): { query(...args: string[]): { toArray(): Record<string, unknown>[] }; close(): void }
}

/** Parse before binding: dynamic SQL can hide nontransactional sequence writes. */
export function validateQuerySql(conn: Connection, sql: string): void {
  const statement = conn.prepare('SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast')
  let parsed: { error: boolean; statements?: unknown[]; error_message?: string }
  try { parsed = JSON.parse(String(statement.query(sql).toArray()[0].ast)) }
  finally { statement.close() }
  validateQueryAst(parsed)
}
