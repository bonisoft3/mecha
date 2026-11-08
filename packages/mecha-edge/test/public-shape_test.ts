import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createEdgeCluster } from '../src/cluster.ts'
import { PUBLIC_WHERE } from '../../../services/auth/jwt.ts'
import { PUBLIC_WHERE as CLIENT_PUBLIC_WHERE } from '../../client/src/public-where.ts'

// A screen mounted only once every shape it reads answered, and each waited on
// a mint first, though a public table's `where` is every subject's same one.
Deno.test('a session opens a synced table\'s public rows, and nothing wider, with no shape token', async () => {
  const db = await PGlite.create()
  try {
    await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
    await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
    await db.exec(`
      INSERT INTO app_user VALUES ('00000000-0000-4000-8000-000000000001', 'private');
      INSERT INTO note (id, owner, body) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'secret');
    `)
    const cluster = await createEdgeCluster({ db, tables: ['board', 'note'], secret: 'test', log: line => { throw new Error(line) }, fail: error => { throw error } })
    const guest = await (await cluster.handle(new Request('https://test/auth/guest', { method: 'POST' }))).json() as { token: string }
    const shape = (table: string, where: string, token = guest.token) => cluster.handle(new Request(
      `https://test/electric/v1/shape?table=${table}&where=${encodeURIComponent(where)}&offset=-1`,
      { headers: { authorization: 'Bearer ' + token } },
    ))
    const rows = async (res: Response) => ((await res.json()) as Array<{ value?: Record<string, unknown> }>).filter(m => m.value)

    assert.equal(PUBLIC_WHERE, CLIENT_PUBLIC_WHERE)
    const board = await shape('board', PUBLIC_WHERE)
    assert.equal(board.status, 200)
    assert.equal((await rows(board)).length, 1)
    // Another subject's row is no public row.
    const note = await shape('note', PUBLIC_WHERE)
    assert.equal(note.status, 200)
    assert.deepEqual(await rows(note), [])
    assert.equal((await shape('note', 'true')).status, 403)
    assert.equal((await shape('absent', PUBLIC_WHERE)).status, 403)
    assert.equal((await shape('board', PUBLIC_WHERE, 'nope')).status, 401)
  } finally { await db.close() }
})
