import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'

Deno.test({ name: 'reader ownership survives release changes, failed cleanup and source filesystem reset', sanitizeResources: false, sanitizeOps: false }, async () => {
  const temporary = await Deno.makeTempDir()
  const capture = { generation: 'source-one', identity: { id: 'capture', name: 'totals', version: 'v1', revision: 1 } }
  await Deno.writeTextFile(`${temporary}/worker.ts`, `
import {DurableObject} from 'cloudflare:workers'
import {ComputeReaderOwners} from '${new URL('../src/compute-reader-owners.ts', import.meta.url).pathname}'
const capture=${JSON.stringify(capture)}
export class Ledger extends DurableObject {
 owners=new ComputeReaderOwners(this.ctx.storage.sql)
 async fetch(req){
  const path=new URL(req.url).pathname
  if(path==='/retain'){this.owners.retain('reader-a',capture);this.owners.retain('reader-a',capture);this.owners.retain('reader-b',capture)}
  if(path==='/failed'){await this.owners.release('reader-b',capture,async()=>{throw new Error('cleanup unavailable')})}
  if(path==='/release-b')await this.owners.release('reader-b',capture,async()=>{})
  if(path==='/release-a')await this.owners.release('reader-a',capture,async()=>{})
  if(path==='/reset'){this.ctx.storage.sql.exec('CREATE TABLE fs_node(id INTEGER)');this.ctx.storage.sql.exec('DROP TABLE fs_node')}
  return Response.json(this.owners.list())
 }
}
export default{fetch(req,env){return env.LEDGER.get(env.LEDGER.idFromName('ledger')).fetch(req)}}
`)
  await Deno.writeTextFile(`${temporary}/wrangler.json`, JSON.stringify({ name: 'reader-owner-test', main: 'worker.ts', compatibility_date: '2026-09-01', durable_objects: { bindings: [{ name: 'LEDGER', class_name: 'Ledger' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Ledger'] }] }))
  const worker = await startWorker(new URL(`file://${temporary}/wrangler.json`), `${temporary}/state`)
  const call = async (route: string) => {
    const response = await fetch(worker.origin + route)
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json()
  }
  try {
    assert.deepEqual(await call('/retain'), [{ owner: 'reader-a', capture }, { owner: 'reader-b', capture }])
    const failed = await fetch(worker.origin + '/failed')
    assert.equal(failed.status, 500); await failed.body?.cancel()
    assert.deepEqual(await call('/'), [{ owner: 'reader-a', capture }, { owner: 'reader-b', capture }])
    assert.deepEqual(await call('/release-b'), [{ owner: 'reader-a', capture }])
    await call('/release-b')
    await worker.restart()
    assert.deepEqual(await call('/reset'), [{ owner: 'reader-a', capture }])
    assert.deepEqual(await call('/release-a'), [])
  } finally { await worker.stop(); await Deno.remove(temporary, { recursive: true }) }
})
