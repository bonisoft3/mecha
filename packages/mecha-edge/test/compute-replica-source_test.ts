import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { load } from '../../pglite-workerd/load.ts'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { seed } from './seed.ts'

Deno.test({ name: 'production source retains and advances reader bases across publication and reset', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'compute-source-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec('CREATE ROLE service; CREATE TABLE replica_source(id text PRIMARY KEY,value integer); INSERT INTO replica_source VALUES(\'one\',1); CREATE TABLE replica_result(id text PRIMARY KEY,value integer); GRANT ALL ON replica_result TO service; CHECKPOINT')
  } finally { await db.close() }
  const dist = new URL('../../pglite-workerd/dist/', import.meta.url).pathname
  await Deno.writeTextFile(`${tmp}/wrangler.json`, JSON.stringify({ name: 'compute-source-test', main: new URL('./compute-replica-source-fixture.ts', import.meta.url).pathname, compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }, { name: 'COMPUTE_READER', class_name: 'Reader', script_name: 'compute-source-reader-test' }, { name: 'COMPUTE_COORDINATOR', class_name: 'Coordinator' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster', 'Coordinator'] }], vars: { JWT_SECRET: 'test', IMPORT_TOKEN: 'test' },
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }, { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false }], alias: { typescript: new URL('../src/typescript-absent.js', import.meta.url).pathname, '@mecha/postgrest-js': new URL('../../postgrest-js/src/index.ts', import.meta.url).pathname, '@electric-sql/pglite': `${dist}index.js`, '@electric-sql/pglite/basefs': `${dist}fs/base.js` } }))
  await Deno.writeTextFile(`${tmp}/reader.json`, JSON.stringify({ name: 'compute-source-reader-test', main: new URL('./compute-replica-source-reader.ts', import.meta.url).pathname, compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'COMPUTE_READER', class_name: 'Reader' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Reader'] }],
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }, { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false }], alias: { '@electric-sql/pglite': `${dist}index.js`, '@electric-sql/pglite/basefs': `${dist}fs/base.js` } }))
  const worker = await startWorker(new URL(`file://${tmp}/wrangler.json`), `${tmp}/state`, [new URL(`file://${tmp}/reader.json`)])
  const post = async (path: string, body?: unknown) => {
    const response = await fetch(worker.origin + path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    assert.equal(response.status, 200, `${path}: ${text}`)
    return JSON.parse(text)
  }
  const prepare = async (capture: unknown) => {
    for (let i = 0; i < 10000; i++) if (await post('/prepare', capture)) return
    throw new Error('reader preparation did not complete')
  }
  const refused = async (capture: unknown, reason: RegExp) => {
    const response = await fetch(worker.origin + '/prepare', { method: 'POST', body: JSON.stringify(capture) })
    assert.ok(response.status >= 400)
    assert.match(await response.text(), reason)
  }
  let failed = false
  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(`${worker.origin}/import/${route}`, init), { log: () => {} })
    const first = await post('/claim')
    assert.ok(first)
    await post('/test/transactions')
    assert.equal(await post('/prepare', first), false)
    const admission = await post('/test/transactions')
    assert.ok(admission > 0)
    for (let i = 0; i < 3; i++) await post('/prepare', first)
    assert.equal(await post('/test/transactions'), admission)
    await worker.restart()
    assert.equal((await post('/claim')).identity.id, first.identity.id)
    await post('/test/transactions')
    await prepare(first)
    // Crawler transactions must not put each admitted physical page back in the serving database queue.
    assert.equal(await post('/test/transactions'), 0)
    assert.equal((await post('/snapshot', first)).tables.replica_source.rows[0].value, '1')
    await worker.restart()
    await post('/seal', first); await post('/publish', first)
    await refused(first, /compute reader was released/)
    await refused({ ...first, identity: { id: 'absent', name: 'absent', version: 'absent', revision: 1 } }, /compute capture is no longer pending/)
    assert.equal((await post('/test/ledger')).bases[0].capture.identity.id, first.identity.id)
    assert.ok((await post('/test/ledger')).snapshots.includes(JSON.stringify(first.identity)))
    await post('/test/write')
    const second = await post('/claim')
    assert.ok(second.identity.revision > first.identity.revision)
    assert.ok((await post('/test/ledger')).snapshots.includes(JSON.stringify(first.identity)))
    const beforeSecond = await post('/test/transactions')
    await prepare(second)
    assert.equal(await post('/test/transactions'), beforeSecond + 1)
    const advanced = await post('/test/ledger')
    assert.equal(advanced.bases[0].capture.identity.id, second.identity.id)
    assert.ok(!advanced.snapshots.includes(JSON.stringify(first.identity)))
    assert.ok(advanced.snapshots.includes(JSON.stringify(second.identity)))
    await post('/publish', first)
    const afterRetry = await post('/test/ledger')
    assert.equal(afterRetry.bases[0].capture.identity.id, second.identity.id)
    assert.ok(afterRetry.snapshots.includes(JSON.stringify(second.identity)))
    assert.equal((await post('/snapshot', second)).tables.replica_source.rows[0].value, '2')
    await post('/seal', second); await post('/publish', second)
    const ledger = await post('/test/ledger')
    assert.equal(ledger.bases[0].capture.identity.id, second.identity.id)
    await post('/test/write')
    const third = await post('/claim')
    let imported = false
    for (let i = 0; i < 10000; i++) {
      await post('/prepare', third)
      if ((await post('/reader-status', third)).transfer?.complete) { imported = true; break }
    }
    assert.ok(imported)
    assert.equal((await post('/test/ledger')).bases[0].capture.identity.id, second.identity.id)
    await post('/test/release-snapshot', third)
    await refused(third, /physical snapshot is no longer available/)
    assert.equal((await post('/test/ledger')).bases[0].capture.identity.id, second.identity.id)
    await post('/test/foreign', second)
    await post('/import/reset')
    await refused(third, /data directory is loading/)
    const reset = await post('/test/ledger')
    assert.deepEqual(reset.bases, [])
    assert.deepEqual(reset.owners, [{ owner: 'foreign', capture: second }])
  } catch (error) { failed = true; throw error } finally {
    await worker.stop()
    if (failed) {
      for (const suffix of [".log", ".log.err"]) {
        const log = await Deno.readTextFile(`${tmp}/state${suffix}`)
        console.error(`workerd ${suffix}:\n${log.slice(-16000)}`)
      }
    }
    const stderr = await Deno.readTextFile(`${tmp}/state.log.err`)
    await Deno.remove(tmp, { recursive: true })
    if (!failed) assert.doesNotMatch(stderr, /Can't read from request stream after response has been sent/)
  }
})
