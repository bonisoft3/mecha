import type { ExecutionConnection, ExecutionDatabase } from '../../compute-snapshot/src/execution.ts'

type Rows = { toArray(): Record<string, unknown>[] }
export interface SyncConnection {
  query(sql: string): Rows
  prepare(sql: string): { query(...values: string[]): Rows; close(): void }
  close(): void
}
export interface SyncDatabase { connect(): SyncConnection }

export function executionConnection(conn: SyncConnection): ExecutionConnection {
  return {
    query: (sql) => Promise.resolve(conn.query(sql).toArray()),
    prepare: (sql) => {
      const statement = conn.prepare(sql)
      return Promise.resolve({ query: (...values) => Promise.resolve(statement.query(...values).toArray()), close: () => statement.close() })
    },
    close: () => conn.close(),
  }
}

/** workerd's DuckDB answers synchronously, so the core's awaits never yield to another request to the Durable Object. */
export function executionDatabase(db: SyncDatabase): ExecutionDatabase {
  return {
    connect: () => Promise.resolve(executionConnection(db.connect())),
  }
}
