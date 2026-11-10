import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'

Deno.test({ name: 'reader ownership survives release changes, failed cleanup and source filesystem reset', sanitizeResources: false, sanitizeOps: false }, async () => {
  const temporary = await Deno.makeTempDir()
  const capture = { generation: 'source-one', identity: { id: 'capture', name: 'totals', version: 'v1', revision: 1 } }
  await Deno.writeTextFile(`${temporary}/worker.ts`, `
import {DurableObject} from 'cloudflare:workers'
import {ComputeReaderOwners} from '${new URL('../src/compute-reader-owners.ts', import.meta.url).pathname}'
const capture=${JSON.stringify(capture)}
const newer={...capture,identity:{...capture.identity,id:'newer',revision:2}}
const conflict={...capture,identity:{...capture.identity,id:'different',revision:2}}
export class Ledger extends DurableObject {
 owners=new ComputeReaderOwners(this.ctx.storage.sql)
 async fetch(req){
  const path=new URL(req.url).pathname
  if(path==='/retain'){this.owners.retain('reader-a',capture);this.owners.retain('reader-a',capture);this.owners.retain('reader-b',capture)}
  if(path==='/failed'){await this.owners.release('reader-b',capture,async()=>{throw new Error('cleanup unavailable')})}
  if(path==='/release-b')await this.owners.release('reader-b',capture,async()=>{})
  if(path==='/release-a')await this.owners.release('reader-a',capture,async()=>{})
  if(path==='/promote-newer')this.owners.promote('reader-a',newer)
  if(path==='/promote-conflict')this.owners.promote('reader-a',conflict)
  if(path==='/base')return Response.json(this.owners.base('reader-a',capture))
  if(path==='/reset-foreign'){for(const {owner,capture} of this.owners.bases()){if(owner!=='reader-a')this.owners.retain(owner,capture);this.owners.clearBase(owner,capture)}}
  if(path==='/promote-a')this.owners.promote('reader-a',capture)
  if(path==='/promote-b')this.owners.promote('reader-b',capture)
  if(path==='/clear-a')this.owners.clearBase('reader-a',capture)
  if(path==='/clear-b')this.owners.clearBase('reader-b',capture)
  if(path==='/pinned')return Response.json(this.owners.pinned(capture))
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
    await call('/promote-a')
    await call('/promote-newer')
    await call('/promote-a')
    assert.deepEqual(await call('/base'), { ...capture, identity: { ...capture.identity, id: 'newer', revision: 2 } })
    const conflict = await fetch(worker.origin + '/promote-conflict')
    assert.equal(conflict.status, 500); await conflict.body?.cancel()
    await call('/clear-a')
    await call('/promote-a')
    await call('/promote-b')
    await call('/clear-a')
    assert.equal(await call('/pinned'), true)
    await worker.restart()
    assert.equal(await call('/pinned'), true)
    await call('/reset-foreign')
    assert.equal(await call('/pinned'), false)
    assert.deepEqual(await call('/'), [{ owner: 'reader-b', capture }])
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
