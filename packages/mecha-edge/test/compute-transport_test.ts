import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'

Deno.test({ name: 'coordinator streams snapshots and outputs larger than the workerd RPC message limit', sanitizeResources: false, sanitizeOps: false }, async () => {
  const directory = await Deno.makeTempDir({ prefix: 'compute-transport-' })
  const coordinator = new URL('../src/compute-coordinator.ts', import.meta.url).pathname
  await Deno.writeTextFile(`${directory}/worker.ts`, `
import { DurableObject } from 'cloudflare:workers'
import { computeCoordinator } from '${coordinator}'
const bytes = 33 * 1024 * 1024;
export class ComputeCoordinator extends computeCoordinator(async snapshot => ({sink:[{id:'one',body:snapshot.tables.source.rows[0].body}]})) {}
export class Cluster extends DurableObject {
 async computeClaim(){
  if(await this.ctx.storage.get('result'))return null;
  return {generation:'generation',identity:{id:'one',name:'large',version:'v1',revision:1}};
 }
 async computePrepare(){return true;}
 async computeSnapshot(capture){
  return Response.json({...capture.identity,tables:{source:{columns:[{name:'body',type:'text'}],rows:[{body:'x'.repeat(bytes)}]}}});
 }
 async computePublish(capture,response){
  if(Object.keys(capture).sort().join()!=='generation,identity')throw new Error('claim contains payload');
  const output=await response.json();
  const body=output.sink[0].body;
  if(body.length!==bytes||body[0]!=='x'||body.at(-1)!=='x')throw new Error('streamed output differs');
  await this.ctx.storage.put('result',{bytes:body.length,identity:capture.identity});
 }
 async computeReject(capture,error){await this.ctx.storage.put('result',{error,identity:capture.identity});}
 async computeWakeAt(){return await this.ctx.storage.get('result')?null:Date.now();}
 async result(){return await this.ctx.storage.get('result')??null;}
}
export default {async fetch(req,env){
 if(new URL(req.url).pathname==='/start'){
  await env.COMPUTE_COORDINATOR.get(env.COMPUTE_COORDINATOR.idFromName('compute')).wake();
  return Response.json({ok:true});
 }
 return Response.json(await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).result());
}}
`)
  await Deno.writeTextFile(`${directory}/wrangler.json`, JSON.stringify({
    name: 'compute-transport-test', main: 'worker.ts', compatibility_date: '2026-09-01',
    durable_objects: { bindings: [{ name: 'CLUSTER', class_name: 'Cluster' }, { name: 'COMPUTE_COORDINATOR', class_name: 'ComputeCoordinator' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Cluster', 'ComputeCoordinator'] }],
  }))
  const worker = await startWorker(new URL(`file://${directory}/wrangler.json`), `${directory}/state`)
  try {
    assert.equal((await fetch(`${worker.origin}/start`)).status, 200)
    let result: { bytes?: number; error?: string; identity?: unknown } | null = null
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await (await fetch(`${worker.origin}/result`)).json()
      if (result) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.deepEqual(result, { bytes: 33 * 1024 * 1024, identity: { id: 'one', name: 'large', version: 'v1', revision: 1 } })
  } finally { await worker.stop(); await Deno.remove(directory, { recursive: true }) }
})
