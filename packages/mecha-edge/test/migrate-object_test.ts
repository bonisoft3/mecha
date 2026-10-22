import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { recordScripts } from '../../pglite-workerd/scripts.ts'
import { seed } from './seed.ts'

Deno.test({ name: 'a release migrates the directory the object kept: the scripts its ledger lacks, then a fresh object on the new schema', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-migrate-' })
  await seed(`${tmp}/pgdata`)
  const fixture = await Deno.readTextFile(new URL('fixture.sql', import.meta.url))
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await recordScripts(db, [{ name: '003_rls.sql', sql: await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)) }, { name: 'fixture.sql', sql: fixture }])
    await db.exec('CHECKPOINT')
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    const headers = { authorization: 'Bearer test-import', 'content-type': 'application/json' }
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const release = [
      { name: 'fixture.sql', sql: fixture },
      { name: '010_added.sql', sql: 'CREATE TABLE added (id int PRIMARY KEY)' },
      { name: '900_seed.sql', sql: 'INSERT INTO added VALUES (1)' },
    ]
    // The fixture regenerated with another table in it: refused by name.
    const changed = await fetch(at('/import/migrate'), { method: 'POST', headers, body: JSON.stringify([{ name: 'fixture.sql', sql: fixture + '\nCREATE TABLE extra (id int)' }]) })
    assert.equal(changed.status, 409)
    assert.match((await changed.json() as { error: string }).error, /fixture\.sql changed/)
    assert.equal((await fetch(at('/import/migrate'), { method: 'POST', body: JSON.stringify(release) })).status, 401)
    const first = await fetch(at('/import/migrate'), { method: 'POST', headers, body: JSON.stringify(release) })
    assert.deepEqual(await first.json(), { applied: ['010_added.sql'] })
    const tables = await (await fetch(at('/test/tables'))).json() as string[]
    assert.ok(tables.includes('added') && tables.includes('_pronto_migrations'), tables.join(','))
    const again = await fetch(at('/import/migrate'), { method: 'POST', headers, body: JSON.stringify(release) })
    assert.deepEqual(await again.json(), { applied: [] })
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test({ name: 'a directory built before the ledger refuses a migration by name', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-noledger-' })
  await seed(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const refused = await fetch(at('/import/migrate'), { method: 'POST', headers: { authorization: 'Bearer test-import', 'content-type': 'application/json' }, body: JSON.stringify([{ name: '010_added.sql', sql: 'CREATE TABLE added (id int)' }]) })
    assert.equal(refused.status, 409)
    assert.match((await refused.json() as { error: string }).error, /no migration ledger/)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
