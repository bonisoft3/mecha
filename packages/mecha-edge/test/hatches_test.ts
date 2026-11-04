import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

Deno.test({ name: 'edge hatches transact over private tables, preserve rollback and survive eviction', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-hatches-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec('CREATE TABLE hatch_private (id integer PRIMARY KEY, body text NOT NULL); CHECKPOINT')
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('hatches-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    const loading = await fetch(at('/hatch'))
    assert.equal(loading.status, 503, await loading.text())
    for (const path of ['/hatch-other', '/test/object-boundary']) {
      const res = await fetch(at(path))
      assert.equal(res.headers.get('x-test-hatch'), null)
      assert.ok(res.status < 500, `${path} must not enter the loading hatch`)
      if (path === '/test/object-boundary') assert.equal(res.status, 404)
      await res.text()
    }
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), {
      ...init, headers: { authorization: 'Bearer test-import' },
    }), { log: () => {} })
    // A hatch's memory holds between requests, or a rate limit never fires.
    const served = async () => ((await (await fetch(at('/hatch/served'))).json()) as { served: number }).served
    assert.deepEqual([await served(), await served()], [1, 2])
    const rows = async () => {
      const response = await fetch(at('/hatch'))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-test-hatch'), 'yes')
      return await response.json()
    }
    assert.deepEqual(await rows(), { rows: [], configured: 'fixture-config' })
    const write = (path: string, id: number, body: string) => fetch(at(path), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, body }),
    })
    const body = "a parameter'); DROP TABLE hatch_private; --"
    const committed = await write('/hatch', 1, body)
    assert.equal(committed.status, 201, await committed.text())
    const expected = { rows: [{ id: 1, body }, { id: 2, body: 'paired' }], configured: 'fixture-config' }
    assert.deepEqual(await rows(), expected)
    const rolledBack = await write('/hatch/rollback', 3, 'never committed')
    assert.equal(rolledBack.status, 409)
    assert.deepEqual(await rolledBack.json(), { rolledBack: true })
    assert.deepEqual(await rows(), expected)
    const poke = (caller: string) => fetch(at(`/poke?caller=${caller}`), { method: 'POST', headers: { authorization: 'Bearer test-import' } })
    const swept = async () => ((await (await fetch(at('/hatch/swept'))).json()) as { swept: number }).swept
    const wal = async () => (await (await fetch(at('/hatch/wal'))).json()) as { redo: string; current: string }
    // A clock's poke sweeps a hatch, and no request need touch it first; a publish's
    // may precede the secrets a first deploy cannot check, so it does not.
    await write('/hatch', 10, 'unflushed')
    const before = await wal()
    assert.ok(Number(before.redo) < Number(before.current), 'a write leaves WAL past the last checkpoint')
    const published = await poke('publish')
    assert.equal(published.status, 200, await published.text())
    assert.equal(await swept(), 0)
    // Regression: nothing ever checkpointed, so pg_wal grew by every byte written.
    assert.ok(Number((await wal()).redo) >= Number(before.current))
    const cron = await poke('cron-trigger')
    assert.equal(cron.status, 200, await cron.text())
    assert.equal(await swept(), 1)
    await fetch(at('/hatch/sweep-fails'))
    const failing = await poke('cron-trigger')
    assert.equal(failing.status, 500)
    assert.deepEqual((await failing.json() as { hatchErrors: string[] }).hatchErrors, ['/hatch: left unsettled: Error: order one'])
    await worker.restart()
    const after = await rows() as typeof expected
    assert.deepEqual(after.rows.slice(0, 2), expected.rows)
    const guest = await fetch(at('/auth/guest'), { method: 'POST' })
    const { token } = await guest.json() as { token: string }
    const privateRead = await fetch(at('/crud/hatch_private'), { headers: { authorization: `Bearer ${token}` } })
    assert.ok(!privateRead.ok, 'a hatch table must remain unavailable through public CRUD')
    await privateRead.text()
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
