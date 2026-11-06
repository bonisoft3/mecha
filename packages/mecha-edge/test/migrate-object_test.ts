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
    const bornBefore = (await (await fetch(at('/test/timers'))).json() as { bornAt: string }).bornAt
    // A SQL failure is a definitive refusal. Explicit BEGIN also leaves the
    // shared connection aborted until rollback; the next read must still work.
    for (const failure of [
      { sql: "BEGIN; CREATE TABLE rejected (id int); INSERT INTO board VALUES (1, 'duplicate'); COMMIT;", code: '23505', message: /duplicate key/ },
      { sql: 'BEGIN; invalid migration syntax; COMMIT;', code: '42601', message: /syntax error/ },
    ]) {
      const refused = await fetch(at('/import/migrate'), { method: 'POST', headers, body: JSON.stringify([{ name: '010_added.sql', sql: failure.sql }]) })
      assert.equal(refused.status, 422)
      const detail = await refused.json() as { error: string; sqlstate: string }
      assert.equal(detail.sqlstate, failure.code)
      assert.match(detail.error, failure.message)
      const readable = await fetch(at('/test/tables'))
      assert.equal(readable.status, 200)
      assert.ok(!(await readable.json() as string[]).includes('rejected'))
      assert.equal((await (await fetch(at('/test/timers'))).json() as { bornAt: string }).bornAt, bornBefore)
    }
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

Deno.test({ name: 'migration waits outside the host concurrency guard for serialized readers and yields to reset', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-migrate-queue-' })
  const packages = new URL('../../', import.meta.url).pathname
  await seed(`${tmp}/pgdata`)
  const fixture = await Deno.readTextFile(new URL('fixture.sql', import.meta.url))
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await recordScripts(db, [{ name: 'fixture.sql', sql: fixture }])
    await db.exec('CHECKPOINT')
  } finally { await db.close() }
  await Deno.writeTextFile(`${tmp}/worker.ts`, `
import { edgeObject } from '${packages}mecha-edge/src/object.ts'
import { edgeWorker } from '${packages}mecha-edge/src/worker.ts'
import pgliteWasm from '${packages}pglite-workerd/dist/pglite.wasm'
import initdbWasm from '${packages}pglite-workerd/dist/initdb.wasm'
import pgliteData from '${packages}pglite-workerd/dist/pglite.data'
import icu from '${packages}pglite-workerd/dist/icu-root.tgz'
const Base=edgeObject({assets:{pgliteWasm,initdbWasm,pgliteData,icu},tables:['note','board'],clock:'disabled'})
export class Cluster extends Base {
  blocks=0; holding=false; migrating=false; resetting=false; release;
  constructor(ctx,env){
    super(ctx,env);
    const block=ctx.blockConcurrencyWhile.bind(ctx);
    ctx.blockConcurrencyWhile=fn=>{this.blocks++;return block(fn)};
  }
  async fetch(req){
    const path=new URL(req.url).pathname;
    if(path==='/test/state')return Response.json({blocks:this.blocks,holding:this.holding,migrating:this.migrating,resetting:this.resetting});
    if(path==='/test/hold')return this.readPublic(async snapshot=>{
      const held=new Promise(resolve=>{this.release=resolve});this.holding=true;
      try{await held;return Response.json(await snapshot.read('/board?select=title'))}
      finally{this.holding=false}
    });
    if(path==='/test/release'){this.release();return Response.json({released:true})}
    if(path==='/import/migrate'){this.migrating=true;try{return await super.fetch(req)}finally{this.migrating=false}}
    if(path==='/import/reset')this.resetting=true;
    return super.fetch(req);
  }
}
export default {fetch(req,env,ctx){
  if(new URL(req.url).pathname.startsWith('/test/'))return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req);
  return edgeWorker.fetch(req,env,ctx);
}};
`)
  const config = JSON.parse(await Deno.readTextFile(new URL('wrangler.jsonc', import.meta.url)))
  delete config.assets
  config.alias = Object.fromEntries(Object.entries(config.alias).map(([name, value]) => [name, new URL(value as string, import.meta.url).pathname]))
  await Deno.writeTextFile(`${tmp}/wrangler.json`, JSON.stringify(config))
  const worker = await startWorker(new URL(`file://${tmp}/wrangler.json`), `${tmp}/state`)
  try {
    const headers = { authorization: 'Bearer test-import', 'content-type': 'application/json' }
    const at = (path: string, init?: RequestInit) => fetch(worker.origin + path, { signal: AbortSignal.timeout(10_000), ...init })
    const migrate = (scripts: { name: string; sql: string }[]) => at('/import/migrate', { method: 'POST', headers, body: JSON.stringify(scripts) })
    type State = { blocks: number; holding: boolean; migrating: boolean; resetting: boolean }
    const until = async (predicate: (state: State) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const state = await (await at('/test/state')).json() as State
        if (predicate(state)) return state
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('migration fixture did not reach the requested state')
    }
    assert.equal((await migrate([])).status, 503)
    assert.equal((await at('/import/migrate', { headers })).status, 405)
    await load(`${tmp}/pgdata`, (route, init) => at(`/import/${route}`, { ...init, headers }), { log: () => {} })
    const blocks = (await until(state => !state.migrating)).blocks
    // A cold migration must not put database boot under the host's 30s limit.
    assert.deepEqual(await (await migrate([{ name: 'fixture.sql', sql: fixture }])).json(), { applied: [] })
    assert.equal((await until(state => !state.migrating)).blocks, blocks)
    const held = at('/test/hold')
    await until(state => state.holding)
    const pending = migrate([{ name: 'fixture.sql', sql: fixture }])
    assert.equal((await until(state => state.migrating)).blocks, blocks)
    await at('/test/release')
    assert.equal((await held).status, 200)
    assert.deepEqual(await (await pending).json(), { applied: [] })

    const heldForReset = at('/test/hold')
    await until(state => state.holding)
    const superseded = migrate([{ name: '010_not_applied.sql', sql: 'CREATE TABLE not_applied(id int)' }])
    await until(state => state.migrating)
    const reset = at('/import/reset', { method: 'POST', headers })
    await until(state => state.resetting)
    assert.equal((await migrate([])).status, 503)
    await at('/test/release')
    assert.equal((await heldForReset).status, 200)
    assert.equal((await superseded).status, 503)
    assert.equal((await reset).status, 200)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
