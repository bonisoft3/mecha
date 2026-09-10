import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BloblangRuntime } from '@mecha/bloblang-js'
import { PipelineRegistry, createCDCListener } from '@mecha/conduit-js'
import { pgliteCollectionOptions } from '@mecha/tanstackdb-pglite'
import { createRestHandler } from '@mecha/postgrest-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SCHEMA = `
CREATE TABLE "hello" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "message" TEXT NOT NULL,
  "processed_at" TEXT,
  "source" TEXT,
  PRIMARY KEY ("id")
);

CREATE OR REPLACE FUNCTION mecha_notify_cdc() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('cdc', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'row', row_to_json(NEW)
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hello_cdc
AFTER INSERT ON "hello"
FOR EACH ROW EXECUTE FUNCTION mecha_notify_cdc();
`

const MAPPING = `root = if this.processed_at == null {
  { "processed_at": "2026-01-01T00:00:00Z", "source": "mecha-browser" }
} else {
  deleted()
}`

const wasmPath = resolve(__dirname, '../../bloblang-js/dist/blobl.wasm')
const wasmExecPath = resolve(__dirname, '../../bloblang-js/dist/wasm_exec.js')
const hasWasm = existsSync(wasmPath) && existsSync(wasmExecPath)

describe('mecha-browser: PGlite + CRUD', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { live } })
    await db.exec(SCHEMA)
  }, 30000)

  afterAll(async () => {
    await db.close()
  })

  it('creates the table with trigger', async () => {
    const tables = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)
    expect((tables.rows as any[]).map((r: any) => r.table_name)).toContain('hello')

    const triggers = await db.query(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE event_object_table = 'hello'
    `)
    expect((triggers.rows as any[]).map((r: any) => r.trigger_name)).toContain('hello_cdc')
  })

  it('REST handler returns inserted rows', async () => {
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('crud-1', 'crud test')`)

    const restHandler = createRestHandler(db)
    const req = new Request('http://localhost/hello?id=eq.crud-1')
    const res = await restHandler(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].message).toBe('crud test')
  })

  it('pgliteCollectionOptions provides reactive sync', async () => {
    const opts = pgliteCollectionOptions({ pglite: db, table: 'hello', key: 'id' })

    const writes: any[] = []
    let ready = false

    const cleanup = opts.sync!({
      collection: {} as any,
      begin: () => {},
      write: (msg: any) => { writes.push(msg) },
      commit: () => {},
      markReady: () => { ready = true },
      truncate: () => {},
    })

    await new Promise(r => setTimeout(r, 200))
    expect(ready).toBe(true)

    const existingRow = writes.find((w: any) => w.value?.id === 'crud-1')
    expect(existingRow).toBeDefined()
    expect(existingRow.value.message).toBe('crud test')

    // Cleanup the live subscription before suite teardown
    if (typeof cleanup === 'function') cleanup()
    // Allow async unsubscribe to settle
    await new Promise(r => setTimeout(r, 100))
  })
})

describe.skipIf(!hasWasm)('mecha-browser: CDC E2E (requires WASM)', () => {
  let db: PGlite
  let runtime: BloblangRuntime
  let cdcCleanup: () => Promise<void>

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { live } })
    await db.exec(SCHEMA)

    runtime = await BloblangRuntime.create({
      wasmBinary: readFileSync(wasmPath),
      wasmExecJs: readFileSync(wasmExecPath, 'utf-8'),
    })

    const registry = new PipelineRegistry()
    registry.register({ name: 'hello_enrich', table: 'hello', mapping: MAPPING })

    cdcCleanup = await createCDCListener({ pglite: db, registry, runtime })
  }, 30000)

  afterAll(async () => {
    await Promise.race([
      cdcCleanup(),
      new Promise<void>(r => setTimeout(r, 2000)),
    ])
    runtime.destroy()
    await db.close()
  }, 15000)

  it('enriches a row via trigger -> pg_notify -> bloblang -> writeback', async () => {
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('e2e-1', 'hello world')`)

    await new Promise(r => setTimeout(r, 500))

    const row = await db.query(`SELECT * FROM "hello" WHERE "id" = 'e2e-1'`)
    const data = row.rows[0] as any
    expect(data.message).toBe('hello world')
    expect(data.processed_at).toBe('2026-01-01T00:00:00Z')
    expect(data.source).toBe('mecha-browser')
  })

  it('PGliteCollection adapter picks up enriched data reactively', async () => {
    const opts = pgliteCollectionOptions({ pglite: db, table: 'hello', key: 'id' })

    const writes: any[] = []
    let ready = false

    const cleanup = opts.sync!({
      collection: {} as any,
      begin: () => {},
      write: (msg: any) => { writes.push(msg) },
      commit: () => {},
      markReady: () => { ready = true },
      truncate: () => {},
    })

    await new Promise(r => setTimeout(r, 200))
    expect(ready).toBe(true)

    const enrichedRow = writes.find((w: any) => w.value?.id === 'e2e-1')
    expect(enrichedRow).toBeDefined()
    expect(enrichedRow.value.source).toBe('mecha-browser')

    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('e2e-2', 'reactive test')`)
    await new Promise(r => setTimeout(r, 500))

    const newRow = writes.find((w: any) => w.value?.id === 'e2e-2')
    expect(newRow).toBeDefined()

    if (typeof cleanup === 'function') cleanup()
    await new Promise(r => setTimeout(r, 100))
  })
})
