import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { pgliteCollectionOptions } from './pglite-collection.js'

describe('pgliteCollectionOptions', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create({
      extensions: { live },
    })
    await db.exec(`
      CREATE TABLE "hello" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "message" TEXT NOT NULL,
        "processed_at" TEXT
      )
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  it('returns a valid collection config with getKey and sync', () => {
    const opts = pgliteCollectionOptions({
      pglite: db,
      table: 'hello',
      key: 'id',
    })

    expect(opts.getKey).toBeTypeOf('function')
    expect(opts.sync).toBeTypeOf('function')
  })

  it('getKey extracts the key field from an item', () => {
    const opts = pgliteCollectionOptions({
      pglite: db,
      table: 'hello',
      key: 'id',
    })

    expect(opts.getKey!({ id: 'abc', message: 'hi' } as any)).toBe('abc')
  })

  it('sync feeds initial data and reacts to changes', async () => {
    // Pre-insert a row
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('1', 'initial')`)

    const opts = pgliteCollectionOptions({
      pglite: db,
      table: 'hello',
      key: 'id',
    })

    const writes: Array<{ type: string; value?: any; key?: string }> = []
    let beginCount = 0
    let commitCount = 0
    let ready = false

    const cleanup = opts.sync!({
      collection: {} as any,
      begin: () => { beginCount++ },
      write: (msg: any) => { writes.push(msg) },
      commit: () => { commitCount++ },
      markReady: () => { ready = true },
      truncate: () => {},
    })

    // Wait for initial load
    await new Promise(r => setTimeout(r, 100))

    expect(ready).toBe(true)
    expect(beginCount).toBeGreaterThanOrEqual(1)
    expect(commitCount).toBeGreaterThanOrEqual(1)

    // Initial data should include the pre-inserted row
    const inserts = writes.filter(w => w.type === 'insert')
    expect(inserts.length).toBeGreaterThanOrEqual(1)
    expect(inserts.some((w: any) => w.value?.id === '1')).toBe(true)

    // Insert another row — should trigger a change
    const writesBefore = writes.length
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('2', 'reactive')`)
    await new Promise(r => setTimeout(r, 200))

    expect(writes.length).toBeGreaterThan(writesBefore)
    const newInserts = writes.filter((w: any) => w.value?.id === '2')
    expect(newInserts.length).toBeGreaterThanOrEqual(1)

    // Cleanup
    if (typeof cleanup === 'function') cleanup()
  })

  it('sync with where clause filters rows', async () => {
    const opts = pgliteCollectionOptions({
      pglite: db,
      table: 'hello',
      key: 'id',
      where: `"message" = 'filtered'`,
    })

    const writes: any[] = []
    opts.sync!({
      collection: {} as any,
      begin: () => {},
      write: (msg: any) => { writes.push(msg) },
      commit: () => {},
      markReady: () => {},
      truncate: () => {},
    })

    await new Promise(r => setTimeout(r, 100))

    // Pre-existing rows with different messages should not appear
    const ids = writes.map((w: any) => w.value?.id).filter(Boolean)
    expect(ids).not.toContain('1')
    expect(ids).not.toContain('2')
  })
})
