import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { publicSnapshot, PublicSnapshotCapacity, type PublicSnapshot } from '../src/public-snapshot.ts'
import { readRest } from '../../postgrest-js/src/index.ts'
import { createEdgeCluster } from '../src/cluster.ts'

Deno.test('public SSR defers shape DDL until API access, before writes are admitted', async () => {
  const db = await PGlite.create()
  try {
    await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
    await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
    const cluster = await createEdgeCluster({ db, tables: ['note', 'board'], secret: 'test', log: line => { throw new Error(line) }, fail: error => { throw error } })
    assert.deepEqual(await cluster.publicSnapshot('generation', s => s.read('/board?select=title')), [{ title: 'Brasileirão 2026' }])
    const installed = async () => (await db.query<{ installed: boolean }>("SELECT to_regprocedure('shape_notify()') IS NOT NULL AS installed")).rows[0].installed
    assert.equal(await installed(), false)
    const guests = await Promise.all([1, 2].map(() => cluster.handle(new Request('https://test/auth/guest', { method: 'POST' }))))
    for (const response of guests) assert.equal(response.status, 200)
    assert.equal(await installed(), true)
    assert.equal((await db.query<{ count: number }>("SELECT count(*)::int AS count FROM pg_trigger WHERE tgname = 'shape_notify'")).rows[0].count, 2)
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM app_user')).rows[0].count, 2)
  } finally { await db.close() }
})

Deno.test('public snapshots over real PGlite', async t => {
  const db = await PGlite.create()
  await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
  await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
  await db.exec(`INSERT INTO app_user VALUES ('00000000-0000-4000-8000-000000000001', 'private');
    INSERT INTO note (owner, body) VALUES ('00000000-0000-4000-8000-000000000001', 'secret');
    CREATE TABLE score (id int PRIMARY KEY, board_id int REFERENCES board(id), points int);
    GRANT SELECT ON score TO app_user;
    INSERT INTO score VALUES (1, 1, 3);`)
  const snapshot = <T>(fn: (read: PublicSnapshot) => Promise<T>, generation = 'directory-1') => publicSnapshot(db, generation, fn)
  const board = () => snapshot(s => s.read('/board?select=title'))
  const revision = () => snapshot(async s => s.revision)
  try {
    await t.step('anonymous public read creates no guest and cannot inherit private claims', async () => {
      await db.exec(`SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001"}', false);
        SELECT set_config('app.scopes', 'public:,user:00000000-0000-4000-8000-000000000001', false);`)
      assert.deepEqual(await board(), [{ title: 'Brasileirão 2026' }])
      assert.deepEqual(await snapshot(s => s.read('/note?select=body')), [])
      assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM app_user')).rows[0].count, 1)
      assert.equal((await db.query<{ who: string }>('SELECT current_user AS who')).rows[0].who, 'postgres')
    })
    await t.step('unchanged reads reuse revision; direct writes, deletes, inserts and DDL change it', async () => {
      const initial = await revision()
      assert.equal(await revision(), initial)
      await db.exec("UPDATE board SET title = 'Atualizado'")
      const updated = await revision()
      assert.notEqual(updated, initial)
      assert.deepEqual(await board(), [{ title: 'Atualizado' }])
      await db.exec('DELETE FROM score; DELETE FROM board')
      assert.notEqual(await revision(), updated)
      assert.deepEqual(await board(), [])
      await db.exec("INSERT INTO board VALUES (1, 'Restored'); INSERT INTO score VALUES (1, 1, 7)")
      const restored = await revision()
      await db.exec('ALTER TABLE score ADD COLUMN extra text')
      assert.notEqual(await revision(), restored)
    })
    await t.step('joins and aggregates use the same transaction and policies', async () => {
      await snapshot(async s => {
        assert.deepEqual(await s.read('/score?select=points,board(title)'), [{ points: 7, board: { title: 'Restored' } }])
        assert.deepEqual(await s.read('/score?select=total:points.sum()'), [{ total: 7 }])
      })
    })
    await t.step('a writer arriving during the snapshot waits; subsequent reader sees its commit', async () => {
      const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
      const reading = snapshot(async s => {
        const before = await s.read('/board?select=title')
        started.resolve()
        await resume.promise
        assert.deepEqual(await s.read('/board?select=title'), before)
        return s.revision
      })
      await started.promise
      const writing = db.exec("UPDATE board SET title = 'After snapshot'")
      resume.resolve()
      const before = await reading
      await writing
      assert.notEqual(await revision(), before)
      assert.deepEqual(await board(), [{ title: 'After snapshot' }])
    })
    await t.step('a rolled-back write never leaks data into a later snapshot', async () => {
      await assert.rejects(db.transaction(async tx => {
        await tx.exec("UPDATE board SET title = 'Must not escape'")
        throw new Error('abort write')
      }), /abort write/)
      assert.deepEqual(await board(), [{ title: 'After snapshot' }])
    })
    await t.step('snapshot reader is revoked after completion or failure', async () => {
      let escaped!: PublicSnapshot
      await snapshot(async s => { escaped = s })
      assert.throws(() => escaped.read('/board'), /snapshot is closed/)
      await assert.rejects(snapshot(async s => { escaped = s; throw new Error('render failed') }), /render failed/)
      assert.throws(() => escaped.read('/board'), /snapshot is closed/)
      assert.deepEqual(await board(), [{ title: 'After snapshot' }])
    })
    await t.step('HTTP writes and database side effects through a read are refused', async () => {
      assert.throws(() => readRest(db, new Request('https://snapshot.invalid/board', { method: 'DELETE' })), /only accept GET/)
      await db.exec(`CREATE FUNCTION public.mutate() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
        BEGIN UPDATE board SET title = 'forbidden'; RETURN 'forbidden'; END $$;
        CREATE VIEW bad_read AS SELECT mutate() AS value;
        GRANT SELECT ON bad_read TO app_user;
        GRANT UPDATE ON board TO app_user;`)
      await assert.rejects(snapshot(s => s.read('/bad_read')), /read-only transaction/)
      await assert.rejects(snapshot(async s => {
        await s.read('/bad_read').catch(() => [])
        return 'a renderer caught the error'
      }), /read-only transaction/)
      assert.deepEqual(await board(), [{ title: 'After snapshot' }])
    })
    await t.step('database replacement identity invalidates identical transaction numbers', async () => {
      assert.notEqual(await revision(), await snapshot(async s => s.revision, 'directory-2'))
    })
  } finally {
    await db.close()
  }
})

Deno.test('public rendering bounds admission before the database chain and releases capacity after failure', async () => {
  const db = await PGlite.create()
  const resume = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  const pending: Promise<unknown>[] = []
  try {
    await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
    await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
    const cluster = await createEdgeCluster({ db, tables: [], secret: 'test', log: line => { throw new Error(line) }, fail: error => { throw error } })
    const first = cluster.publicSnapshot('generation', async () => {
      started.resolve()
      await resume.promise
      throw new Error('render failed')
    })
    pending.push(assert.rejects(first, /render failed/))
    await started.promise
    for (let i = 1; i < 16; i++) pending.push(cluster.publicSnapshot('generation', s => s.read('/board?select=title')))
    await assert.rejects(cluster.publicSnapshot('generation', async () => { throw new Error('must not run') }), PublicSnapshotCapacity)
    resume.resolve()
    await Promise.all(pending)
    assert.deepEqual(await cluster.publicSnapshot('generation', s => s.read('/board?select=title')), [{ title: 'Brasileirão 2026' }])
  } finally {
    resume.resolve()
    await Promise.allSettled(pending)
    await db.close()
  }
})

Deno.test('public view embeds use declared references and preserve target RLS in snapshots and the API', async () => {
  const db = await PGlite.create()
  try {
    await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
    await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
    await db.exec(`
      INSERT INTO app_user VALUES ('00000000-0000-4000-8000-000000000001', 'private');
      INSERT INTO note (id, owner, body) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'secret');
      CREATE VIEW feed WITH (security_invoker = true) AS SELECT id, id AS alternate, '00000000-0000-4000-8000-000000000002'::uuid AS note_id FROM board;
      GRANT SELECT ON feed TO app_user;
    `)
    const schema = { feed: { durability: 'server', fields: [{ name: 'id', ref: 'board' }, { name: 'alternate', ref: 'board' }, { name: 'note_id', ref: 'note' }] } }
    const cluster = await createEdgeCluster({ db, tables: [], schema, secret: 'test', log: line => { throw new Error(line) }, fail: error => { throw error } })
    const path = '/feed?select=id,board:id(title),note:note_id(body)'
    const expected = [{ id: 1, board: { title: 'Brasileirão 2026' }, note: null }]
    assert.deepEqual(await cluster.publicSnapshot('generation', s => s.read(path)), expected)
    await assert.rejects(cluster.publicSnapshot('generation', s => s.read('/feed?select=board(title)')), /Ambiguous/)
    await assert.rejects(cluster.publicSnapshot('generation', s => s.read('/feed?select=absent(title)')), /Unknown/)
    const guest = await (await cluster.handle(new Request('https://test/auth/guest', { method: 'POST' }))).json()
    const response = await cluster.handle(new Request('https://test/crud' + path, { headers: { authorization: 'Bearer ' + guest.token } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  } finally { await db.close() }
})
