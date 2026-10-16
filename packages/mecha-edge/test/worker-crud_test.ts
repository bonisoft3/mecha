import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createEdgeCluster } from '../src/cluster.ts'
import { edgeWorker } from '../src/worker.ts'
import type { EdgeEnv } from '../src/object.ts'

Deno.test('worker /crud/ cache: guests share public-only reads, isolate private reads even after write markers expire, and invalidate on writes', async () => {
  const secret = 'test-secret'
  const db = await PGlite.create()
  await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
  await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
  await db.exec(`
    CREATE VIEW board_view WITH (security_invoker = true) AS SELECT id, title FROM board;
    GRANT SELECT ON board_view TO app_user;
  `)
  const cluster = await createEdgeCluster({
    db,
    tables: ['note', 'board'],
    secret,
    log: () => {},
    fail: (e) => { throw e },
  })

  const cacheStore = new Map<string, Response>()
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        async match(req: Request) { return cacheStore.get(req.url)?.clone() ?? null },
        async put(req: Request, res: Response) { cacheStore.set(req.url, res.clone()) },
        async delete(req: Request) { return cacheStore.delete(req.url) },
      },
    },
  })

  let fetches = 0
  const env: EdgeEnv = {
    JWT_SECRET: secret,
    IMPORT_TOKEN: 'import-secret',
    CF_VERSION_METADATA: { id: 'v1' },
    CLUSTER: {
      idFromName: () => ({ toString: () => 'cluster' } as any),
      get: () => ({
        fetch(req: Request) {
          fetches++
          return cluster.handle(req)
        },
      }) as any,
    } as any,
  }
  const background: Promise<unknown>[] = []
  const ctx = {
    waitUntil(promise: Promise<unknown>) { background.push(promise) },
  } as ExecutionContext
  const flush = async () => { await Promise.all(background.splice(0)) }

  try {
    const mintGuest = async () => {
      const res = await edgeWorker.fetch(new Request('https://app.example/auth/guest', { method: 'POST' }), env, ctx)
      return (await res.json()) as { token: string; user: { id: string } }
    }
    const alice = await mintGuest()
    const bob = await mintGuest()
    fetches = 0

    // Public base table and view over it are shared across guests.
    for (const path of ['/crud/board?select=title', '/crud/board_view?select=title']) {
      const a = await edgeWorker.fetch(new Request(`https://app.example${path}`, { headers: { authorization: `Bearer ${alice.token}` } }), env, ctx)
      await flush()
      assert.equal(a.headers.get('x-edge-cache'), 'miss')
      assert.equal(a.headers.get('x-mecha-scope'), null)
      assert.deepEqual(await a.json(), [{ title: 'Brasileirão 2026' }])

      const b = await edgeWorker.fetch(new Request(`https://app.example${path}`, { headers: { authorization: `Bearer ${bob.token}` } }), env, ctx)
      assert.equal(b.headers.get('x-edge-cache'), 'hit')
      assert.deepEqual(await b.json(), [{ title: 'Brasileirão 2026' }])
    }
    assert.equal(fetches, 2)

    // Alice writes a private note; writes invalidate public and private keys.
    const write = await edgeWorker.fetch(new Request('https://app.example/crud/note', {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ body: 'segredo da Alice' }),
    }), env, ctx)
    assert.equal(write.status, 201)
    assert.equal(fetches, 3)

    const bobBoardAfterWrite = await edgeWorker.fetch(new Request('https://app.example/crud/board?select=title', { headers: { authorization: `Bearer ${bob.token}` } }), env, ctx)
    await flush()
    assert.equal(bobBoardAfterWrite.headers.get('x-edge-cache'), 'miss')
    assert.equal(fetches, 4)

    // Evict the cache (simulating TTL expiry of writesKey or colo change):
    // Alice's read of a user-scoped table must never populate a public key that leaks to Bob.
    cacheStore.clear()
    const aliceNotes = await edgeWorker.fetch(new Request('https://app.example/crud/note?select=body', { headers: { authorization: `Bearer ${alice.token}` } }), env, ctx)
    await flush()
    assert.equal(aliceNotes.headers.get('x-edge-cache'), 'miss')
    assert.deepEqual(await aliceNotes.json(), [{ body: 'segredo da Alice' }])

    const bobNotes = await edgeWorker.fetch(new Request('https://app.example/crud/note?select=body', { headers: { authorization: `Bearer ${bob.token}` } }), env, ctx)
    await flush()
    assert.equal(bobNotes.headers.get('x-edge-cache'), 'miss')
    assert.deepEqual(await bobNotes.json(), [])

    const aliceNotesCached = await edgeWorker.fetch(new Request('https://app.example/crud/note?select=body', { headers: { authorization: `Bearer ${alice.token}` } }), env, ctx)
    assert.equal(aliceNotesCached.headers.get('x-edge-cache'), 'hit')
    assert.deepEqual(await aliceNotesCached.json(), [{ body: 'segredo da Alice' }])
  } finally {
    await db.close()
    if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches)
    else Reflect.deleteProperty(globalThis, 'caches')
  }
})
