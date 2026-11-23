import { fileURLToPath } from 'node:url'
import * as duckdb from 'npm:@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-node-blocking.cjs'
import { executionDatabase, type SyncDatabase } from '../src/execution-host.ts'

const wasm = fileURLToPath(import.meta.resolve('npm:@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-eh.wasm'))
export async function fixture() {
  const db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: 'unused' }, eh: { mainModule: wasm, mainWorker: 'unused' } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME)
  await db.instantiate()
  const connection = db.connect()
  connection.query("SET threads=1; SET memory_limit='64MB'")
  connection.close()
  return db
}
export const host = (db: Awaited<ReturnType<typeof fixture>>) => db as unknown as SyncDatabase
export const asyncHost = (db: Awaited<ReturnType<typeof fixture>>) => executionDatabase(host(db))
