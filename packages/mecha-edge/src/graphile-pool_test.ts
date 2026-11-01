import assert from 'node:assert/strict'
import { createDatabase } from '../../mecha-browser/src/database.ts'
import { GraphilePool } from './graphile-pool.ts'

// Graphile's migrations run inside begin…commit on a client of its pool. On
// the object's one connection, another caller's statement landing between the
// two would join the transaction: it waits for the commit instead.
Deno.test('a transaction Graphile opens holds the connection until it ends', async () => {
  const db = await createDatabase({})
  try {
    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }
    await db.exec('CREATE TABLE t (n int)')
    const client = await new GraphilePool(db, serialize).connect()
    await client.query('begin')
    await client.query({ text: 'INSERT INTO t VALUES ($1)', values: [1] })
    const order: string[] = []
    const outside = serialize(async () => {
      order.push('outside')
      return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM t')).rows[0].n
    })
    await new Promise((r) => setTimeout(r, 20))
    order.push('commit')
    await client.query('commit')
    assert.deepEqual([order, await outside], [['commit', 'outside'], 1])

    await client.query('begin')
    await client.query({ text: 'INSERT INTO t VALUES ($1)', values: [2] })
    await client.query('rollback')
    assert.deepEqual((await client.query('SELECT count(*)::int AS n FROM t')).rows, [{ n: 1 }])
  } finally {
    await db.close()
  }
})
