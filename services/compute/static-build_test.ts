import { assertEquals, assertThrows } from "@std/assert";
import { compile } from "./workers.ts";
import { staticFactory } from "./static-build.ts";

const source = (body: string) =>
  `export const reads=[]; export const queries={}; export const plan=()=>[]; export const finish=(inputs)=>{${body}};`;
const factory = (body: string, endowments: string[] = []) =>
  staticFactory(
    compile("static-test.js", source(body)),
    "static-test.js",
    endowments,
  );

Deno.test("static admission closes escaped and nested ambient capabilities", () => {
  for (
    const body of [
      'return fetch("https://example.com");',
      'return f\\u0065tch("https://example.com");',
      "return (() => env.QUERIES)();",
      "return globalThis;",
      "return this;",
      "return Function;",
      "return eval;",
      "return typeof performance;",
      "return Crypto;",
      "return new TextEncoder();",
      "return import('x');",
      "return import.meta;",
      "return (ambient = 1);",
    ]
  ) assertThrows(() => factory(body), TypeError);
  factory('return new TextEncoder().encode("hello");', ["TextEncoder"]);
});

Deno.test("static cage preserves taming, fresh instances, live exports and data boundaries", async () => {
  const runtime = new URL("./static-cage.ts", import.meta.url).href;
  const config = new URL("./deno.json", import.meta.url).pathname;
  const live = compile(
    "live.js",
    `
    export const reads=[]; export let queries={}; let counter=0;
    export function plan(inputs, seed, outputs) {
      ({queries} = {queries: {counter: ++counter}});
      return [{wasm: "job", input: {queries, seed, count: outputs.length}}];
    }
    export function finish(inputs) { return {queries, inputs}; }
  `,
  );
  const probes = [
    'return Math["random"]();',
    "return new Date();",
    "return Date.now();",
    "return new Date(0).getFullYear();",
    'return "a".localeCompare("b");',
    'return ({}).constructor.constructor("return globalThis")();',
    'return (async()=>{}).constructor("return globalThis")();',
    'return Object.getPrototypeOf(function*(){}).constructor("yield 1")();',
    "Array.prototype.hostLeak=1; return 1;",
    "Math = {}; return Math;",
    "inputs.hostLeak=1; return 1;",
  ].map((body) => factory(body));
  const text = `
    import {StaticCage} from ${JSON.stringify(runtime)};
    import {assertEquals, assertRejects} from "@std/assert";
    const descriptor=${staticFactory(live, "live.js", [])};
    for (let run=0;run<2;run++) {
      const cage=new StaticCage("live.js",descriptor,[]);
      assertEquals(await cage.load(),{reads:[],queries:{}});
      const inputs={a:[{id:"one"}]};
      assertEquals((await cage.ask({inputs,seed:3})).jobs,[{wasm:"job",input:{queries:{counter:1},seed:3,count:0}}]);
      inputs.a[0].id="changed";
      assertEquals((await cage.ask({outputs:[],plan:true})).jobs,[{wasm:"job",input:{queries:{counter:2},seed:3,count:0}}]);
      assertEquals((await cage.ask({outputs:[]})).out,{queries:{counter:2},inputs:{a:[{id:"one"}]}});
      cage.close();
      await assertRejects(()=>cage.ask({outputs:[]}));
    }
    for (const descriptor of [${probes.join(",")}]) {
      const cage=new StaticCage("probe.js",descriptor,[]);
      await cage.load(); await cage.ask({inputs:{},seed:1});
      await assertRejects(()=>cage.ask({outputs:[]}));
      cage.close();
    }
    const attacker=new StaticCage("attacker.js",${
    factory(
      'Error.prepareStackTrace=(error)=>{error.cause.pwned=true;return "tampered"}; return 1;',
    )
  },[]);
    await attacker.load(); await attacker.ask({inputs:{},seed:1});
    await attacker.ask({outputs:[]}); attacker.close();
    const cause={pwned:false};
    const error=new Error("host",{cause});
    assertEquals(error.stack.includes("host"),true);
    assertEquals(cause.pwned,false);
    const utc=new StaticCage("utc.js",${
    factory("return new Date(0).toISOString();")
  },[]);
    await utc.load(); await utc.ask({inputs:{},seed:1});
    assertEquals((await utc.ask({outputs:[]})).out,"1970-01-01T00:00:00.000Z");
  `;
  const file = await Deno.makeTempFile({ suffix: ".mjs" });
  try {
    await Deno.writeTextFile(file, text);
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", config, "--no-lock", file],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("static emission admits physical query metadata without widening executable exports", () => {
  staticFactory(compile("staged.js", source("return inputs;") + "export const queryStages={};"), "staged.js", []);
  assertThrows(() => staticFactory(compile("extra.js", source("return inputs;") + "export const execute=()=>0;"), "extra.js", []), TypeError);
});
