interface Connection {
  prepare(sql: string): { query(...args: string[]): { toArray(): Record<string, unknown>[] }; close(): void }
}

/** Parse before binding: dynamic SQL can hide nontransactional sequence writes. */
export function validateQuerySql(conn: Connection, sql: string): void {
  const statement = conn.prepare('SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast')
  let parsed: { error: boolean; statements?: unknown[]; error_message?: string }
  try { parsed = JSON.parse(String(statement.query(sql).toArray()[0].ast)) }
  finally { statement.close() }
  if (parsed.error || parsed.statements?.length !== 1) throw new Error(`query requires one SELECT statement: ${parsed.error_message ?? 'multiple statements'}`)
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'function_name' && typeof child === 'string' &&
        ['nextval', 'query', 'query_table', 'json_execute_serialized_sql'].includes(child.toLowerCase())) {
        throw new Error(`query function is not permitted: ${child}`)
      }
      visit(child)
    }
  }
  visit(parsed.statements)
}
