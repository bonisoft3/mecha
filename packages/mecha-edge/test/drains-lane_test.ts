import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createDrains } from '../../mecha-browser/drains.ts'

Deno.test('drain listener lifecycle uses the shared database lane', async () => {
  const db = await PGlite.create()
  let inLane = false
  const serialize = async <T>(fn: () => Promise<T>): Promise<T> => {
    assert.equal(inLane, false)
    inLane = true
    try { return await fn() } finally { inLane = false }
  }
  const listen = db.listen.bind(db)
  db.listen = (...args: Parameters<typeof db.listen>) => {
    assert.equal(inLane, true, 'LISTEN must use the same lane as database transactions')
    return listen(...args).then(unlisten => async () => {
      assert.equal(inLane, true, 'UNLISTEN must use the same lane as database transactions')
      await unlisten()
    })
  }
  try {
    await db.exec('CREATE TABLE drain_source(id integer)')
    const drains = await createDrains({ db, serialize, drains: [{ name: 'example', on: ['drain_source'], call: 'drain_example', body: {} }], log: () => {} })
    await drains.stop()
  } finally { await db.close() }
})
