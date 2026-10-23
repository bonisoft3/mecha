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
      await assert.rejects(snapshot(s => s.read('/score?select=points,absent(title)')), /Unknown/)
      const originalTransaction = db.transaction.bind(db)
      let execCalls = 0
      let queryCalls = 0
      db.transaction = (async fn => originalTransaction(async tx => {
        const origExec = tx.exec.bind(tx)
        const origQuery = tx.query.bind(tx)
        tx.exec = ((...args: Parameters<typeof tx.exec>) => { execCalls++; return origExec(...args) }) as typeof tx.exec
        tx.query = ((...args: Parameters<typeof tx.query>) => { queryCalls++; return origQuery(...args) }) as typeof tx.query
        return await fn(tx)
      })) as typeof db.transaction
      try {
        assert.deepEqual(await snapshot(s => s.read('/score?select=points,board(title)')), [{ points: 7, board: { title: 'Restored' } }])
        // Once a table and its relations are known on the generation, a snapshot
        // read needs only one preamble exec and one data query, even after a
        // rejected relation query on the same table.
        assert.equal(execCalls, 1)
        assert.equal(queryCalls, 1)
      } finally {
        db.transaction = originalTransaction
      }
      await db.exec('CREATE TABLE ungranted (id int PRIMARY KEY)')
      await assert.rejects(snapshot(s => s.read('/ungranted')), /snapshot read 404/)
      await db.exec(`
        CREATE TABLE archive_board (id int PRIMARY KEY, title text);
        GRANT SELECT ON archive_board TO app_user;
        INSERT INTO archive_board VALUES (1, 'Archived');
        ALTER TABLE score DROP CONSTRAINT score_board_id_fkey, ADD CONSTRAINT score_board_id_fkey FOREIGN KEY (board_id) REFERENCES archive_board(id);
      `)
      await assert.rejects(snapshot(s => s.read('/score?select=points,board(title)')), /Unknown to-one relation: score\.board/)
      assert.deepEqual(await snapshot(s => s.read('/score?select=points,archive_board(title)')), [{ points: 7, archive_board: { title: 'Archived' } }])
      await db.exec(`
        ALTER TABLE score DROP CONSTRAINT score_board_id_fkey, ADD CONSTRAINT score_board_id_fkey FOREIGN KEY (board_id) REFERENCES board(id);
        DROP TABLE archive_board;
      `)
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
    const guest = await (await cluster.handle(new Request('https://test/auth/guest', { method: 'POST' }))).json() as { token: string }
    const response = await cluster.handle(new Request('https://test/crud' + path, { headers: { authorization: 'Bearer ' + guest.token } }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  } finally { await db.close() }
})

// Without priority lanes and `publicCache` fast-paths, background Electric
// shape handshakes and speculative prefetches queue ahead of interactive SSR
// snapshots on PGlite's single connection.
Deno.test('interactive public snapshots jump ahead of background shape snapshots while offset=now bypasses the database chain', async () => {
  const db = await PGlite.create()
  const resume = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
  try {
    await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
    await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
    const cluster = await createEdgeCluster({ db, tables: ['board', 'note'], secret: 'test', log: line => { throw new Error(line) }, fail: error => { throw error } })
    const guest = await (await cluster.handle(new Request('https://test/auth/guest', { method: 'POST' }))).json() as { token: string }
    const firstToken = await (await cluster.handle(new Request('https://test/auth/shape', {
      method: 'POST', headers: { authorization: 'Bearer ' + guest.token }, body: JSON.stringify({ table: 'board' }),
    }))).json() as { token: string; where: string }
    const noteToken = await (await cluster.handle(new Request('https://test/auth/shape', {
      method: 'POST', headers: { authorization: 'Bearer ' + guest.token }, body: JSON.stringify({ table: 'note' }),
    }))).json() as { token: string; where: string }

    const held = cluster.publicSnapshot('generation', async () => {
      started.resolve()
      await resume.promise
      return 'held'
    })
    await started.promise

    const fastToken = await cluster.handle(new Request('https://test/auth/shape', {
      method: 'POST', headers: { authorization: 'Bearer ' + guest.token }, body: JSON.stringify({ table: 'board' }),
    }))
    assert.equal(fastToken.status, 200)
    const fastNow = await cluster.handle(new Request(
      `https://test/electric/v1/shape?table=note&where=${encodeURIComponent(noteToken.where)}&offset=now&log=changes_only`,
      { headers: { authorization: 'Bearer ' + noteToken.token } },
    ))
    assert.equal(fastNow.status, 200)

    const order: string[] = []
    const shapeSnap = cluster.handle(new Request(
      `https://test/electric/v1/shape?table=board&where=${encodeURIComponent(firstToken.where)}&offset=-1`,
      { headers: { authorization: 'Bearer ' + firstToken.token } },
    )).then((res) => { order.push(`shape:${res.status}`) })
    const lowSnapshots = Array.from({ length: 16 }, (_, idx) =>
      cluster.publicSnapshot('generation', async (s) => {
        const rows = await s.read('/board?select=title')
        if (idx === 0) order.push(`prefetch:${rows.length}`)
      }, 'low')
    )
    await assert.rejects(
      () => cluster.publicSnapshot('generation', () => Promise.resolve(), 'low'),
      (e: unknown) => e instanceof PublicSnapshotCapacity && e.message === 'public snapshot queue full',
    )
    const highSnapshots = Array.from({ length: 5 }, (_, idx) =>
      cluster.publicSnapshot('generation', async (s) => {
        const rows = await s.read('/board?select=title')
        order.push(`live-${idx + 1}:${rows.length}`)
      }, 'high')
    )

    resume.resolve()
    await Promise.all([held, shapeSnap, ...lowSnapshots, ...highSnapshots])
    assert.deepEqual(order.slice(0, 4), ['live-1:1', 'live-2:1', 'live-3:1', 'prefetch:1'])
    assert.equal(order.includes('shape:200'), true)
    assert.equal(order.includes('live-5:1'), true)
  } finally {
    resume.resolve()
    await db.close()
  }
})
