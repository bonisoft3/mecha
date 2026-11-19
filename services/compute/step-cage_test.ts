import { assertEquals, assertRejects } from "@std/assert";
import { StepCage, type StepHost } from "./step-cage.ts";
import { Runner } from "./workers.ts";

const host: StepHost = {
  seed: 7,
  query: (sql) => Promise.resolve([{ sql }]),
  wasm: (name, input) => Promise.resolve({ name, input }),
  wasmFromQuery: (name, input, query) =>
    Promise.resolve({ name, input, query }),
};
function cage(body: string, prelude = "") {
  return new StepCage({
    file: "step-probe.js",
    endowments: [],
    source: `${prelude}
      export const reads = []; export const queries = {};
      export const finish = () => ({});
      export const plan = async (host, seed, state) => { ${body} };`,
  });
}

Deno.test("step cage correlates asynchronous host capabilities and seed", async () => {
  using worker = cage(`
    const [rows, wasm, fused] = await Promise.all([
      host.query("select 1"), host.wasm("kernel", state), host.wasmFromQuery("kernel", {}, {sql: "select 2", path: ["games"], orderBy: "id"})
    ]);
    return {checkpoint: {rows, wasm, fused, seed: host.seed}, writes: {}, done: true};`);
  assertEquals(await worker.advance(host, { n: 3 }), {
    checkpoint: {
      rows: [{ sql: "select 1" }],
      wasm: { name: "kernel", input: { n: 3 } },
      fused: {
        name: "kernel",
        input: {},
        query: { sql: "select 2", path: ["games"], orderBy: "id" },
      },
      seed: 7,
    },
    writes: {},
    done: true,
  });
});

Deno.test("step cage recreates module state and freezes checkpoint inputs", async () => {
  using worker = cage(
    `
    return {checkpoint: {count: ++count, frozen: Object.isFrozen(state)}, writes: {}, done: false};`,
    "let count = 0;",
  );
  const first = await worker.advance(host, {});
  assertEquals(first.checkpoint, { count: 1, frozen: true });
  assertEquals(await worker.advance(host, first.checkpoint), first);
});

Deno.test("step cage propagates host and module errors", async () => {
  using worker = cage('await host.query("broken");');
  await assertRejects(
    () =>
      worker.advance({
        ...host,
        query: () => Promise.reject(new Error("SQL failed")),
      }, {}),
    Error,
    "SQL failed",
  );
  using broken = cage('throw new Error("step failed");');
  await assertRejects(() => broken.advance(host, {}), Error, "step failed");
});

Deno.test("step cage rejects undeclared globals and unknown host methods", async () => {
  for (
    const expression of [
      "Deno.readTextFile('secret')",
      "new TextEncoder()",
      "host.readFile('secret')",
    ]
  ) {
    using worker = cage(
      `${expression}; return {checkpoint: null, writes: {}, done: true};`,
    );
    await assertRejects(() => worker.advance(host, {}));
  }
  using worker = cage(
    "return {checkpoint: [typeof fetch, typeof WebAssembly, typeof postMessage], writes: {}, done: true};",
  );
  assertEquals((await worker.advance(host, {})).checkpoint, [
    "undefined",
    "undefined",
    "undefined",
  ]);
});

Deno.test("step cage closes pending advance and rejects reuse", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  using worker = cage('await host.query("blocked");');
  const pending = worker.advance({
    ...host,
    query: () => {
      entered();
      return new Promise(() => {});
    },
  }, {});
  const rejected = assertRejects(() => pending, Error, "closed");
  await started;
  worker.close();
  await rejected;
  await assertRejects(() => worker.advance(host, {}), Error, "closed");
});

Deno.test("step cage bounds checkpoint, output and wasm messages", async () => {
  using checkpoint = cage("return state;");
  await assertRejects(
    () => checkpoint.advance(host, "x".repeat(8 * 1024 * 1024)),
    RangeError,
    "8 MiB",
  );
  for (
    const body of [
      'return {checkpoint: "x".repeat(8 * 1024 * 1024), writes: {}, done: true};',
      'await host.wasm("kernel", "x".repeat(8 * 1024 * 1024));',
    ]
  ) {
    using worker = cage(body);
    await assertRejects(() => worker.advance(host, {}), Error, "8 MiB");
  }
  using compacted = cage(
    'const r = await host.wasm("kernel", {}); return {checkpoint: r.keep, writes: {}, done: true};',
  );
  assertEquals(
    await compacted.advance({
      ...host,
      wasm: () => Promise.resolve({ keep: "ok", drop: "x".repeat(12 * 1024 * 1024) }),
    }, {}),
    { checkpoint: "ok", writes: {}, done: true },
  );
  using oversizedReply = cage(
    'await host.wasm("kernel", {}); return {checkpoint: null, writes: {}, done: true};',
  );
  await assertRejects(
    () =>
      oversizedReply.advance({
        ...host,
        wasm: () => Promise.resolve({ drop: "x".repeat(16 * 1024 * 1024) }),
      }, {}),
    Error,
    "16 MiB",
  );
});

Deno.test("step cage forwards concurrency and output field selection, and Runner pools WASI workers with deduplicated caching", async () => {
  using worker = cage(`
    const [a, b] = await Promise.all([
      host.wasm("kernel", { id: 1 }, ["rps"]),
      host.wasmFromQuery("kernel", { id: 2 }, { sql: "select 1", path: ["games"], orderBy: "id" }, ["rps", "extra"]),
    ]);
    return { checkpoint: { concurrency: host.concurrency, a, b }, writes: {}, done: true };
  `);
  assertEquals(
    await worker.advance({
      seed: 11,
      concurrency: 4,
      query: () => Promise.resolve([]),
      wasm: (_name, input, select) => Promise.resolve({ input, select }),
      wasmFromQuery: (_name, input, _query, select) => Promise.resolve({ input, select }),
    }, {}),
    {
      checkpoint: {
        concurrency: 4,
        a: { input: { id: 1 }, select: ["rps"] },
        b: { input: { id: 2 }, select: ["rps", "extra"] },
      },
      writes: {},
      done: true,
    },
  );

  // Echo stdin JSON to stdout so Runner executes multiple WASI jobs across its pool.
  const echoHex =
    "0061736d01000000010c0260047f7f7f7f017f60000002440216776173695f736e617073686f745f70726576696577310766645f72656164000016776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400020a33013100410041103602004104418020360200410041004101410810001a41044108280200360200410141004101410c10011a0b";
  const echoBytes = new Uint8Array(echoHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const stored = new Map<string, string>();
  let puts = 0;
  using runner = await Runner.cached(
    { echo: echoBytes },
    {
      get: (keys) => Promise.resolve(new Map(keys.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)!]))),
      put: (k, v) => {
        puts++;
        stored.set(k, v);
        return Promise.resolve();
      },
    },
    { concurrency: 4 },
  );
  const jobs = Array.from({ length: 8 }, (_, i) => ({
    wasm: "echo",
    input: JSON.stringify({ rps: i % 4, discard: "y".repeat(64) }),
    select: ["rps"],
  }));
  const first = await runner.run(jobs);
  assertEquals(first, Array.from({ length: 8 }, (_, i) => ({ rps: i % 4 })));
  assertEquals(puts, 4);
  const second = await runner.run(jobs);
  assertEquals(second, first);
  assertEquals(puts, 4);

  // Closing Runner while a WASM job is executing in a worker settles its promise instead of hanging.
  const loopHex =
    "0061736d01000000010401600000030201000503010001071302066d656d6f72790200065f737461727400000a0901070003400c000b0b";
  const loopModule = await WebAssembly.compile(
    new Uint8Array(loopHex.match(/../g)!.map((h) => parseInt(h, 16))),
  );
  const closingRunner = new Runner({ spin: loopModule }, { concurrency: 1 });
  const inFlight = closingRunner.run([{ wasm: "spin", input: "{}" }]);
  const closedPromise = assertRejects(() => inFlight, Error, "WASM runner is closed");
  await new Promise((r) => setTimeout(r, 40));
  closingRunner.close();
  await closedPromise;
});
