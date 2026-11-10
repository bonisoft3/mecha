import { assertEquals, assertRejects } from "@std/assert";
import { StepCage, type StepHost } from "./step-cage.ts";

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
