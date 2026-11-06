import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./workers.ts";
import { staticFactory } from "./static-build.ts";

const source = (body: string) => `
  export const reads=[]; export const queries={}; let calls=0;
  export async function plan(host,_seed,state) { if (++calls!==1) throw new Error("reused cage"); ${body} }
  export const finish=()=>({});
`;
const factory = (body: string) =>
  staticFactory(
    compile("paged-fixture.js", source(body)),
    "paged-fixture.js",
    [],
  );
const echo =
  "0061736d01000000010c0260047f7f7f7f017f60000002440216776173695f736e617073686f745f70726576696577310766645f72656164000016776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400020a33013100410041103602004104418020360200410041004101410810001a41044108280200360200410141004101410c10011a0b";

async function isolated(factories: Record<string, string>, assertions: string) {
  const path = (relative: string) =>
    JSON.stringify(new URL(relative, import.meta.url).href);
  const code = `
    import assert from "node:assert/strict";
    import {fileURLToPath} from "node:url";
    import * as duckdb from "npm:@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-node-blocking.cjs";
    import {table} from ${path("./portable-fixture.ts")};
    import {pagedQueryAction} from ${
    path("../../packages/mecha-edge/src/paged-query-action.ts")
  };
    const wasmPath=fileURLToPath(import.meta.resolve("npm:@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-eh.wasm"));
    const db=await duckdb.createDuckDB({mvp:{mainModule:wasmPath,mainWorker:"unused"},eh:{mainModule:wasmPath,mainWorker:"unused"}},new duckdb.VoidLogger(),duckdb.NODE_RUNTIME);
    await db.instantiate();
    const connection=db.connect(); connection.query("SET threads=1; SET memory_limit='64MB'"); connection.close();
    const {pagedComputeStep}=await import(${
    path("../../packages/mecha-edge/src/paged-compute.ts")
  });
    const factories={${
    Object.entries(factories).map(([name, value]) =>
      `${JSON.stringify(name)}:${value}`
    ).join(",")
  }};
    const echo=new WebAssembly.Module(Uint8Array.from(${
    JSON.stringify(echo)
  }.match(/../g).map(byte=>parseInt(byte,16))));
    const capture={generation:"generation-a",identity:{id:"capture-a",name:"fixture",version:"v1",revision:1}};
    const program={version:"v1",reads:["source"],queries:{rows:"SELECT id,value FROM source ORDER BY id"},
      spec:{name:"fixture",file:"paged-fixture.js",to:["sink"],types:table,sinkTypes:{sink:[
        {name:"id",type:"string",required:true},{name:"seed",type:"double"},{name:"value",type:"double"},{name:"payload",type:"bytes"}
      ]}},steps:factories.happy,wasm:{echo}};
    const manifest={...capture.identity,tables:{source:{columns:[{name:"id",type:"text"},{name:"value",type:"integer"}],rows:1}}};
    const action=(request)=>pagedQueryAction(db,[program],{capture,...request});
    const calls=[];
    const service={async fetch(url,init){
      const request=JSON.parse(init.body);
      assert.equal(new URL(url).pathname,"/paged");
      assert.deepEqual(JSON.parse(new URL(url).searchParams.get("key")),[request.capture.generation,request.capture.identity.id]);
      calls.push(request);
      try { return Response.json(await pagedQueryAction(db,[program],request)); }
      catch(error) { return new Response(String(error),{status:500}); }
    }};
    const initialized=await action({action:"initialize",manifest});
    assert.deepEqual(initialized.execution,{revision:0,checkpoint:null,done:false});
    await action({action:"append",chunk:{...capture.identity,table:"source",after:0,next:1,done:true,rows:[{id:"one",value:"7"}]}});
    ${assertions}
    db.reset();
  `;
  const file = await Deno.makeTempFile({ suffix: ".mjs" });
  try {
    await Deno.writeTextFile(file, code);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        new URL("./deno.json", import.meta.url).pathname,
        "--frozen",
        "-A",
        file,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      result.code,
      0,
      new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    );
  } finally {
    await Deno.remove(file);
  }
}

const happy = factory(`
  const rows=await host.query("SELECT (value->>'id') AS id,CAST(value->>'value' AS INTEGER) AS value FROM duckstream_private.result_rows ORDER BY sequence");
  const phase=state===null?1:state.phase+1;
  const output=await host.wasm("echo",{id:rows[0].id,value:rows[0].value+phase,seed:host.seed,payload:"AP+AQQ=="});
  return {checkpoint:{phase,seed:host.seed},writes:{sink:[output]},done:phase===2,
    statements:phase===1?["CREATE TABLE fixture_scratch AS SELECT 1 AS phase"]:["INSERT INTO fixture_scratch VALUES(2)"]};
`);

Deno.test("paged static computation carries query and WASM capabilities across atomic CAS checkpoints", async () => {
  await isolated(
    { happy },
    `
    await assert.rejects(()=>pagedComputeStep([program],service,capture),/not materialized/);
    await action({action:"materialize",query:"rows"});
    const seed=new DataView(await crypto.subtle.digest("SHA-256",new TextEncoder().encode("fixture"))).getUint32(0,false);
    const first=await pagedComputeStep([program],service,capture);
    assert.deepEqual(first,{revision:1,checkpoint:{phase:1,seed},done:false});
    const commit=calls.find(request=>request.action==="commit");
    const replay=await action({...commit,step:{...commit.step,statements:["INSERT INTO fixture_scratch VALUES(999)"]}});
    assert.deepEqual(replay,first);
    assert.deepEqual(await action({action:"query",sql:"SELECT * FROM fixture_scratch"}),[{phase:1}]);
    const second=await pagedComputeStep([program],service,capture);
    assert.deepEqual(second,{revision:2,checkpoint:{phase:2,seed},done:true});
    assert.deepEqual(await action({action:"output",sink:"sink"}),{after:0,next:1,done:true,rows:[{id:"one",seed,value:9,payload:"\\\\x00ff8041"}]});
    assert.deepEqual(await action({action:"outputs"}),{sink:{rows:1}});
    const committed=calls.filter(request=>request.action==="commit").length;
    assert.deepEqual(await pagedComputeStep([program],service,capture),second);
    assert.equal(calls.filter(request=>request.action==="commit").length,committed);
  `,
  );
});

Deno.test("paged captures reject wrong artifacts and identities before state advances", async () => {
  await isolated(
    { happy },
    `
    await action({action:"materialize",query:"rows"});
    for(const patch of [{name:"other"},{version:"old"}]) {
      const before=calls.length;
      await assert.rejects(()=>pagedComputeStep([program],service,{...capture,identity:{...capture.identity,...patch}}),/artifact differs/);
      assert.equal(calls.length,before);
      await assert.rejects(()=>action({action:"status",capture:{...capture,identity:{...capture.identity,...patch}}}),/artifact differs/);
    }
    for(const patch of [{id:"other"},{revision:2}]) {
      await assert.rejects(()=>pagedComputeStep([program],service,{...capture,identity:{...capture.identity,...patch}}),/another capture/);
    }
    await assert.rejects(()=>action({action:"initialize",manifest:{...manifest,id:"other"}}),/manifest identity differs/);
    assert.deepEqual((await action({action:"status"})).execution,{revision:0,checkpoint:null,done:false});
  `,
  );
});

Deno.test("paged capability and sink failures cannot commit scratch, rows or checkpoint", async () => {
  await isolated(
    {
      happy,
      undeclared: factory('await host.wasm("other",{});'),
      mutation: factory(
        'const rows=await host.query("SELECT 1 AS value"); rows[0].value=2;',
      ),
      readonly: factory('await host.query("DELETE FROM source");'),
      invalidSink: factory(
        `return {checkpoint:{phase:99},writes:{sink:[{id:"one",seed:host.seed,value:1,payload:"not base64"}]},statements:["CREATE TABLE should_not_exist AS SELECT 1 AS value"],done:false};`,
      ),
    },
    `
    await action({action:"materialize",query:"rows"});
    for(const [name,error] of [["undeclared",/undeclared WASM/],["mutation",/read only|readonly|assign/i],["readonly",/Parser Error|SELECT|syntax|read.only/i],["invalidSink",/invalid type|bytes|pattern/i]]) {
      program.steps=factories[name];
      await assert.rejects(()=>pagedComputeStep([program],service,capture),error);
      assert.deepEqual((await action({action:"status"})).execution,{revision:0,checkpoint:null,done:false});
    }
    assert.deepEqual(await action({action:"query",sql:"SELECT table_name FROM information_schema.tables WHERE table_name='should_not_exist'"}),[]);
    assert.deepEqual(await action({action:"query",sql:"SELECT * FROM source"}),[{id:"one",value:7}]);
    program.steps=factories.happy;
    assert.equal((await pagedComputeStep([program],service,capture)).revision,1);
  `,
  );
});

Deno.test("paged static factories cannot name ambient host capabilities", () => {
  for (
    const body of [
      'return fetch("https://example.com");',
      "return globalThis;",
      "return process.env;",
      "return Deno.env.toObject();",
      'return new Function("return globalThis")();',
      'return new TextEncoder().encode("undeclared endowment");',
    ]
  ) assertThrows(() => factory(body), TypeError, "unavailable");
});

Deno.test("paged WASM query host assembles an ordered array through fenced read capabilities", async () => {
  await isolated(
    {
      happy: factory(`
        const output=await host.wasmFromQuery("echo",{request:{games:[]},seed:host.seed},{
          path:["request","games"],sql:"SELECT i::INTEGER AS ordinal, (10-i)::INTEGER AS value FROM range(3) t(i)",orderBy:"ordinal"
        });
        if(output.request.games.length!==3 || output.request.games[0].value!==10 || output.request.games[2].value!==8) throw new Error("wrong ordered query input");
        if("ordinal" in output.request.games[0]) throw new Error("ordering key leaked");
        return {checkpoint:null,writes:{sink:[{id:"one",seed:output.seed,value:output.request.games[1].value,payload:"AP+AQQ=="}]},done:true};
      `),
    },
    `
    await action({action:"materialize",query:"rows"});
    const state=await pagedComputeStep([program],service,capture);
    assert.equal(state.done,true);
    const page=calls.find(request=>request.action==="query-page");
    assert.equal(page.revision,0);
    assert.equal(page.after,-1);
    assert.equal(page.orderBy,"ordinal");
    assert.deepEqual(page.capture,capture);
    assert.equal((await action({action:"output",sink:"sink"})).rows[0].value,9);
    `,
  );
});

Deno.test("paged WASM stdout can exceed the commit budget only when computation compacts it", async () => {
  await isolated(
    {
      happy,
      compact: factory(`
        const output=await host.wasm("stdout",{});
        return {checkpoint:{length:output.length},writes:{sink:[{id:"large",seed:0,value:output.length,payload:"AP+AQQ=="}]},done:true};
      `),
      uncompacted: factory(`
        const output=await host.wasm("stdout",{});
        return {checkpoint:{output},writes:{},done:false};
      `),
    },
    `
    const concat=(...parts)=>{
      const result=new Uint8Array(parts.reduce((size,part)=>size+part.length,0));
      let offset=0;
      for(const part of parts){result.set(part,offset);offset+=part.length;}
      return result;
    };
    const uleb=value=>{
      const result=[];
      do {const byte=value&127;value>>>=7;result.push(byte|(value?128:0));} while(value);
      return result;
    };
    const section=(id,data)=>concat([id],uleb(data.length),data);
    const string=value=>{const bytes=new TextEncoder().encode(value);return concat(uleb(bytes.length),bytes);};
    const stdoutModule=size=>{
      const data=new Uint8Array(size+16);
      const view=new DataView(data.buffer);
      view.setUint32(0,16,true);view.setUint32(4,size,true);
      data.fill(97,16);data[16]=34;data[data.length-1]=34;
      const body=[0,65,1,65,0,65,1,65,8,16,0,26,11];
      return new WebAssembly.Module(concat(
        [0,97,115,109,1,0,0,0],
        section(1,[2,96,4,127,127,127,127,1,127,96,0,0]),
        section(2,concat([1],string("wasi_snapshot_preview1"),string("fd_write"),[0,0])),
        section(3,[1,1]),
        section(5,concat([1,0],uleb(Math.ceil(data.length/65536)))),
        section(7,concat([2],string("memory"),[2,0],string("_start"),[0,1])),
        section(10,concat([1],uleb(body.length),body)),
        section(11,concat([1,0,65,0,11],uleb(data.length),data))
      ));
    };
    await action({action:"materialize",query:"rows"});
    const initial={revision:0,checkpoint:null,done:false};
    const commits=()=>calls.filter(request=>request.action==="commit");

    program.steps=factories.compact;
    program.wasm.stdout=stdoutModule(16*1024*1024+1);
    await assert.rejects(()=>pagedComputeStep([program],service,capture),/WASM output exceeds byte limit/);
    assert.equal(commits().length,0);
    assert.deepEqual((await action({action:"status"})).execution,initial);

    program.steps=factories.uncompacted;
    program.wasm.stdout=stdoutModule(8*1024*1024+1024);
    await assert.rejects(()=>pagedComputeStep([program],service,capture),/execution step exceeds byte limit/);
    assert.equal(commits().length,1);
    assert.deepEqual((await action({action:"status"})).execution,initial);
    assert.deepEqual(await action({action:"query",sql:"SELECT count(*) AS rows FROM duckdb_private.output_rows"}),[{rows:0}]);

    program.steps=factories.compact;
    program.wasm.stdout=stdoutModule(16*1024*1024);
    const length=16*1024*1024-2;
    assert.deepEqual(await pagedComputeStep([program],service,capture),{revision:1,checkpoint:{length},done:true});
    assert.equal(commits().length,2);
    assert.ok(new TextEncoder().encode(JSON.stringify(commits().at(-1).step)).length<1024);
    const rows=(await action({action:"output",sink:"sink"})).rows;
    assert.equal(rows.length,1);
    assert.equal(rows[0].id,"large");
    assert.equal(rows[0].value,length);
    `,
  );
});
