import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'

Deno.test({ name: 'completed and failed compute RPCs release deadline timers before the workerd limit', sanitizeResources: false, sanitizeOps: false }, async () => {
  const directory = await Deno.makeTempDir({ prefix: 'compute-deadline-' })
  const transport = new URL('../src/paged-transport.ts', import.meta.url).pathname
  const compute = new URL('../src/compute.ts', import.meta.url).pathname
  await Deno.writeTextFile(`${directory}/worker.ts`, `
import { pagedRequest } from '${transport}';
import { serviceExecutor } from '${compute}';
const identity={id:'one',name:'test',version:'v1',revision:1};
const capture={generation:'generation',identity};
export default {async fetch(){
 let succeeded=0,failed=0;
 for(let i=0;i<12000;i++){
  const mode=i%4;
  const service={async fetch(_url,init){
   if(init.signal.aborted)throw new Error('deadline already aborted');
   if(mode===1)throw new Error('transport failure');
   if(mode===2)return new Response('failure',{status:500});
   if(mode===3)return new Response('invalid json');
   return Response.json({...identity,sinks:{sink:[{id:'one'}]}});
  }};
  try{
   if(i%8<4)await pagedRequest(service,{capture,action:'status'});
   else await serviceExecutor(service)({...identity,tables:{}});
   if(mode!==0)throw new Error('failure was accepted');
   succeeded++;
  }catch(error){
   if(mode===0||(mode===1&&String(error)!=='Error: transport failure')||
      (mode===2&&!String(error).includes('500: failure'))||(mode===3&&!(error instanceof SyntaxError)))throw error;
   failed++;
  }
 }
 return Response.json({succeeded,failed});
}};
`)
  await Deno.writeTextFile(`${directory}/wrangler.json`, JSON.stringify({ name: 'compute-deadline-test', main: 'worker.ts', compatibility_date: '2026-09-01' }))
  const worker = await startWorker(new URL(`file://${directory}/wrangler.json`), `${directory}/state`)
  try {
    const response = await fetch(worker.origin)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { succeeded: 3000, failed: 9000 })
  } finally { await worker.stop(); await Deno.remove(directory, { recursive: true }) }
})
