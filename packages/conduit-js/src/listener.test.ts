import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { PipelineRegistry, createCDCListener } from './listener.js'

describe('PipelineRegistry', () => {
  it('stores and retrieves pipelines by table name', () => {
    const registry = new PipelineRegistry()
    registry.register({ name: 'hello_enrich', table: 'hello', mapping: 'root.x = "y"' })

    expect(registry.get('hello')).toEqual({
      name: 'hello_enrich',
      table: 'hello',
      mapping: 'root.x = "y"',
    })
    expect(registry.get('unknown')).toBeUndefined()
  })
})

describe('createCDCListener', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE "hello" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "message" TEXT NOT NULL,
        "processed_at" TEXT,
        "source" TEXT
      );

      CREATE TABLE "custom_key_table" (
        "uuid" TEXT NOT NULL PRIMARY KEY,
        "label" TEXT NOT NULL,
        "enriched" TEXT
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

      CREATE TRIGGER custom_key_table_cdc
      AFTER INSERT ON "custom_key_table"
      FOR EACH ROW EXECUTE FUNCTION mecha_notify_cdc();
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  it('invokes the bloblang runtime on CDC events and writes back', async () => {
    const executeCalls: Array<{ mapping: string; input: any }> = []

    const mockRuntime = {
      execute: async (mapping: string, input: Record<string, unknown>) => {
        executeCalls.push({ mapping, input })
        return { processed_at: '2026-01-01', source: 'test' }
      },
    }

    const registry = new PipelineRegistry()
    registry.register({
      name: 'hello_enrich',
      table: 'hello',
      mapping: 'root.processed_at = now()',
    })

    const cleanup = await createCDCListener({
      pglite: db,
      registry,
      runtime: mockRuntime as any,
    })

    // Insert a row — trigger fires -> pg_notify -> listener -> bloblang -> writeback
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('cdc-1', 'test')`)

    // Wait for async CDC processing
    await new Promise(r => setTimeout(r, 300))

    // Verify bloblang was called
    expect(executeCalls.length).toBe(1)
    expect(executeCalls[0].mapping).toBe('root.processed_at = now()')
    expect(executeCalls[0].input.id).toBe('cdc-1')

    // Verify writeback happened
    const row = await db.query(`SELECT * FROM "hello" WHERE "id" = 'cdc-1'`)
    expect((row.rows[0] as any).processed_at).toBe('2026-01-01')
    expect((row.rows[0] as any).source).toBe('test')

    await cleanup()
  })

  it('uses pipeline.key as primary key for writeback', async () => {
    const executeCalls: Array<{ mapping: string; input: any }> = []

    const mockRuntime = {
      execute: async (mapping: string, input: Record<string, unknown>) => {
        executeCalls.push({ mapping, input })
        return { enriched: 'custom-key-result' }
      },
    }

    const registry = new PipelineRegistry()
    registry.register({
      name: 'custom_key_enrich',
      table: 'custom_key_table',
      mapping: 'root.enriched = "custom-key-result"',
      key: 'uuid',
    })

    const cleanup = await createCDCListener({
      pglite: db,
      registry,
      runtime: mockRuntime as any,
    })

    await db.query(`INSERT INTO "custom_key_table" ("uuid", "label") VALUES ('ck-1', 'test-label')`)

    await new Promise(r => setTimeout(r, 300))

    expect(executeCalls.length).toBeGreaterThanOrEqual(1)
    expect(executeCalls[0].input.uuid).toBe('ck-1')

    const row = await db.query(`SELECT * FROM "custom_key_table" WHERE "uuid" = 'ck-1'`)
    expect((row.rows[0] as any).enriched).toBe('custom-key-result')

    await cleanup()
  })
})
