import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'
import { createSnapshotCoordinator, type BatchState } from '../../compute-snapshot/src/index.ts'
import { load } from '../../pglite-workerd/load.ts'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import type { ComputeCapture } from '../src/compute.ts'

Deno.test({ name: 'persistent compute reader advances committed captures without recopying its archive', sanitizeResources: false, sanitizeOps: false }, async () => {
  const directory = await Deno.makeTempDir({ prefix: 'compute-replica-' })
  const seeded = `${directory}/pgdata`
  await Deno.mkdir(seeded)
  const db = await PGlite.create({ dataDir: seeded, icuDataDir: await icuDataDir() })
  const state: BatchState = { phase: 'active', name: 'probe', requested: 1, completed: 0, wake: 0, claimed: 1, required: [], due: 0, coalesce: 0, attempts: 25 }
  try {
    await db.exec(`CREATE TABLE left_input(id integer PRIMARY KEY,value integer); CREATE TABLE right_input(id integer PRIMARY KEY,value integer);
      INSERT INTO left_input VALUES(1,0); INSERT INTO right_input VALUES(1,0); CREATE TABLE result(id integer PRIMARY KEY,value integer);
      CREATE TABLE archive AS SELECT n,repeat(md5(n::text),32) AS body FROM generate_series(1,20000) n;`)
    const coordinator = await createSnapshotCoordinator({ db, serialize: fn => fn(), computations: [{ name: 'probe', version: 'v1', reads: ['left_input', 'right_input'], to: ['result'] }], machine: { execute: () => ({ kind: 'accepted', state }) } })
    await coordinator.stop()
    await db.exec('CHECKPOINT')
  } finally { await db.close() }
  const root = new URL('../../pglite-workerd/', import.meta.url).pathname
  await Deno.writeTextFile(`${directory}/wrangler.json`, JSON.stringify({ name: 'compute-replica-test', main: new URL('./compute-replica-fixture.ts', import.meta.url).pathname, compatibility_date: '2026-09-01',
    durable_objects: { bindings: [{ name: 'SOURCE', class_name: 'Source' }, { name: 'READER', class_name: 'Reader' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Source', 'Reader'] }],
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: false }, { type: 'Data', globs: ['**/*.data', '**/*.tgz'], fallthrough: false }],
    alias: { '@electric-sql/pglite': `${root}dist/index.js`, '@electric-sql/pglite/basefs': `${root}dist/fs/base.js` },
  }))
  const worker = await startWorker(new URL(`file://${directory}/wrangler.json`), `${directory}/state`)
  const post = async (path: string, body: unknown, expected = 200) => {
    const response = await fetch(worker.origin + path, { method: 'POST', body: JSON.stringify(body) })
    const text = await response.text()
    assert.equal(response.status, expected, text)
    return expected === 200 ? JSON.parse(text) : text
  }
  const transfer = async (capture: ComputeCapture, restart = false) => {
    let bytes = 0, blockPages = 0, restarted = false
    for (let n = 0; n < 10000; n++) {
      const result = await post('/step', { capture })
      bytes += result.bytes
      if (result.blockPage) blockPages++
      if (restart && !restarted && result.bytes > 0) { await worker.restart(); restarted = true }
      if (result.done) {
        if (restart) assert.ok(restarted, 'restart must follow an applied delta block')
        return { bytes, blockPages }
      }
    }
    throw new Error('capture did not complete')
  }
  const assertValue = async (capture: ComputeCapture, value: number) => {
    const snapshot = await post('/snapshot', { capture })
    for (const name of ['left_input', 'right_input']) assert.deepEqual(snapshot.tables[name].rows, [{ id: '1', value: String(value) }])
  }
  try {
    await load(seeded, (route, init) => fetch(`${worker.origin}/import/${route}`, init), { log: () => {} })
    const first = await post('/capture', { revision: 1 })
    const initial = await transfer(first)
    const initialBytes = initial.bytes
    await assertValue(first, 1)
    const second = await post('/capture', { revision: 2 })
    const abandoned = await post('/capture', { revision: 3 })
    await assertValue(first, 1)
    await post('/release', { capture: first })
    const delta = await transfer(second, true)
    const deltaBytes = delta.bytes
    assert.ok(delta.blockPages < initial.blockPages / 4, `delta requested ${delta.blockPages} block pages versus ${initial.blockPages} initially`)
    await assertValue(second, 2)
    await post('/release', { capture: first })
    await assertValue(second, 2)
    await worker.restart()
    await assertValue(second, 2)
    assert.ok(deltaBytes < initialBytes / 4, `delta ${deltaBytes} must not recopy archive ${initialBytes}`)
    await post('/step', { capture: first }, 500)
    await post('/release', { capture: second })
    let changed = false
    for (let n = 0; n < 1000; n++) {
      const part = await post('/step', { capture: abandoned })
      if (part.bytes > 0) { changed = true; break }
      assert.equal(part.done, false)
    }
    assert.ok(changed, 'supersession must interrupt a real partial delta')
    await post('/release', { capture: abandoned })
    await worker.restart()
    await post('/release', { capture: abandoned })
    const replacement = await post('/capture', { revision: 4 })
    const replacementBytes = (await transfer(replacement)).bytes
    await assertValue(replacement, 4)
    assert.ok(replacementBytes < initialBytes / 4)
    console.log(JSON.stringify({ initialBytes, deltaBytes, replacementBytes, initialBlockPages: initial.blockPages, deltaBlockPages: delta.blockPages }))
  } finally { await worker.stop(); await Deno.remove(directory, { recursive: true }) }
})
