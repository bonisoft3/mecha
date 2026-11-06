// The compute service's HTTP acceptance, capture and computation contracts.
//
// The Postgres tests start a throwaway cluster with the initdb on PATH and
// need DuckDB's postgres and ducklake extensions installed (install.ts), as
// the image installs them at build; without initdb they are ignored.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import pgDriver from "pg";
import { Computation, computationVersion, crudClaims, Database, handler, Lake, queryEngine, seedOf, serve } from "./main.ts";
import { executionVersion, type Job, type JobCache, jobKey, Runner } from "./workers.ts";
import { pgTest, postgres } from "./pg-test.ts";
import { PostgresJobCache } from "./job-cache.ts";

Deno.test("engine and Feldera program bytes fence retained computation inputs", async () => {
  assertEquals(queryEngine(), "duckdb-snapshot");
  assertEquals(queryEngine("feldera"), "feldera");
  assertThrows(
    () => queryEngine("auto"),
    Error,
    "unsupported DUCKSTREAM_ENGINE",
  );
  const dir = await Deno.makeTempDir();
  try {
    const spec = {
      name: "analytics",
      file: `${dir}/program.js`,
      feldera: `${dir}/feldera.json`,
      to: ["result"],
      wasm: [],
    };
    await Deno.writeTextFile(spec.file, "export const queries = {};");
    await Deno.writeTextFile(spec.feldera, '{"sql":"SELECT 1"}');
    const snapshot = await computationVersion(spec, [], "duckdb-snapshot");
    const native = await computationVersion(spec, [], "feldera");
    assert(snapshot !== native);
    await Deno.writeTextFile(spec.feldera, '{"sql":"SELECT 2"}');
    assert(native !== await computationVersion(spec, [], "feldera"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("invalidation acknowledgment waits for the acceptance callback", async () => {
  const entered = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  const tables: string[][] = [];
  const handle = handler({
    async refresh(input = []) {
      tables.push(input);
      entered.resolve();
      await accepted.promise;
      return true;
    },
  }, "secret");
  let acknowledged = false;
  const response = handle(
    new Request("http://compute/invalidate", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: JSON.stringify({ tables: ["game", "rating"] }),
    }),
  ).then((response) => {
    acknowledged = true;
    return response;
  });
  await entered.promise;
  assertEquals(acknowledged, false);
  assertEquals(tables, [["game", "rating"]]);
  accepted.resolve();
  assertEquals((await response).status, 204);
});

Deno.test("invalidation refusal remains unacknowledged", async () => {
  const handle = handler({ refresh: () => Promise.resolve(false) }, undefined);
  assertEquals(
    (await handle(
      new Request("http://compute/invalidate", {
        method: "POST",
        body: JSON.stringify({ tables: ["game"] }),
      }),
    )).status,
    503,
  );
});

Deno.test("invalidations validate route, credentials and table names before acceptance", async () => {
  let calls = 0;
  const handle = handler({
    refresh: () => {
      calls++;
      return Promise.resolve(true);
    },
  }, "secret");
  assertEquals((await handle(new Request("http://compute/invalidate"))).status, 404);
  assertEquals((await handle(new Request("http://compute/other", { method: "POST" }))).status, 404);
  assertEquals((await handle(new Request("http://compute/invalidate", { method: "POST" }))).status, 401);
  for (const body of [{}, { tables: [null] }, { tables: ["game;drop table game"] }]) {
    await assertRejects(
      () =>
        handle(
          new Request("http://compute/invalidate", {
            method: "POST",
            headers: { authorization: "Bearer secret" },
            body: JSON.stringify(body),
          }),
        ),
      Error,
      "invalidation requires",
    );
  }
  assertEquals(calls, 0);
});

Deno.test("failed acceptance answers 500 with its cause and leaves ingress available for retry", async () => {
  let fail = true;
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (error: unknown) => void errors.push(error);
  const server = serve(
    {
      refresh() {
        if (fail) {
          throw new AggregateError(
            [new Error("connection reset"), new Error("rollback failed")],
            "acceptance failed",
          );
        }
        return Promise.resolve(true);
      },
    },
    "secret",
    0,
  );
  try {
    const deliver = () =>
      fetch(`http://localhost:${server.addr.port}/invalidate`, {
        method: "POST",
        headers: { authorization: "Bearer secret" },
        body: JSON.stringify({ tables: ["game"] }),
      });
    const refused = await deliver();
    assertEquals([refused.status, await refused.text()], [500, "acceptance failed: connection reset; rollback failed"]);
    assertEquals((errors[0] as Error).message, "acceptance failed");
    fail = false;
    assertEquals((await deliver()).status, 204);
  } finally {
    console.error = log;
    await server.shutdown();
  }
});

Deno.test("publication claims preserve the configured service identity or anonymous default", () => {
  const token = (claims: unknown) =>
    `e30.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.signature`;
  assertEquals(crudClaims(undefined), { role: "anon" });
  assertEquals(crudClaims(token({ role: "service", sub: "compute" })), { role: "service", sub: "compute" });
  for (const claims of [null, [], {}, { role: 42 }]) {
    assertThrows(() => crudClaims(token(claims)), Error, "SERVICE_JWT names no role");
  }
});

Deno.test("onComplete accepts only one lowercase SQL/PostgREST identifier", async () => {
  await assertRejects(
    () =>
      Computation.load({
        name: "bad",
        file: "unused.js",

        to: ["sink"],
        wasm: [],
        endowments: [],
        onComplete: "rpc/capture",
      }, undefined as unknown as Runner),
    Error,
    "no SQL/PostgREST RPC identifier",
  );
});

Deno.test("onComplete does not exceed PostgreSQL's identifier limit", async () => {
  await assertRejects(
    () =>
      Computation.load({
        name: "bad",
        file: "unused.js",

        to: ["sink"],
        wasm: [],
        endowments: [],
        onComplete: `capture_${"x".repeat(57)}`,
      }, undefined as unknown as Runner),
    Error,
    "no SQL/PostgREST RPC identifier",
  );
});

// Postgres.

async function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  const child = new Deno.Command(cmd, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  })
    .spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const { success, stdout, stderr } = await child.output();
  if (!success) throw new Error(`${cmd} ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout).trim();
}

const psql = (url: string, sql: string) => run("psql", [url, "-XAtqc", sql]);

async function eventually(predicate: () => Promise<boolean>, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

pgTest("bootstrap refuses the pre-capture gap and snapshots commits made while capture starts", async () => {
  await using pg = await postgres();
  await psql(pg.url, "CREATE TABLE game (id int PRIMARY KEY); INSERT INTO game VALUES (1)");
  const database = await Database.open(pg.url, undefined);
  await assertRejects(() => database.requireCapture("test_compute"), Error, "not ready");
  const transaction = new Deno.Command("psql", { args: [pg.url, "-Xq"], stdin: "piped", stdout: "null" }).spawn();
  const writer = transaction.stdin.getWriter();
  await writer.write(new TextEncoder().encode("BEGIN; INSERT INTO game VALUES (2);\n"));
  await eventually(async () =>
    (await psql(
      pg.url,
      "SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction' AND backend_xid IS NOT NULL",
    )) === "1"
  );
  const creating = new Deno.Command("psql", {
    args: [pg.url, "-XAtqc", "SELECT pg_create_logical_replication_slot('test_compute', 'pgoutput')"],
    stdout: "null",
  }).spawn();
  await eventually(async () =>
    (await psql(
      pg.url,
      "SELECT count(*) FROM pg_replication_slots WHERE slot_name='test_compute' AND confirmed_flush_lsn IS NULL",
    )) === "1"
  );
  // Slot presence precedes its consistent point while old writers are open.
  await assertRejects(() => database.requireCapture("test_compute"), Error, "not ready");
  await writer.write(new TextEncoder().encode("COMMIT;\n"));
  await writer.close();
  assert((await transaction.status).success);
  assert((await creating.status).success);
  await database.requireCapture("test_compute");
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  await lake.attach();
  await lake.hold(["game"]);
  await lake.detach();
  assertEquals(await lake.query("SELECT id FROM game ORDER BY id"), [{ id: 1 }, { id: 2 }]);
});

pgTest("one capture cannot mix rows from opposite sides of a committed transaction", async () => {
  await using pg = await postgres();
  await psql(
    pg.url,
    `
    CREATE TABLE first_input (id int PRIMARY KEY, value int);
    CREATE TABLE second_input (id int PRIMARY KEY, value int);
    INSERT INTO first_input VALUES (1, 1);
    INSERT INTO second_input VALUES (1, 1);
    CREATE VIEW slow_input AS SELECT id, value, pg_advisory_xact_lock(7216)::text AS barrier FROM first_input;
  `,
  );
  const barrier = new pgDriver.Client({ connectionString: pg.url });
  await barrier.connect();
  try {
    await barrier.query("BEGIN; SELECT pg_advisory_xact_lock(7216)");
    const lake = await Lake.open(pg.url, await Deno.makeTempDir());
    await lake.attach();
    const capture = lake.hold(["slow_input", "second_input"]);
    await eventually(async () =>
      Number(await psql(pg.url, "SELECT count(*) FROM pg_stat_activity WHERE wait_event='advisory'")) > 0
    );
    await psql(pg.url, "BEGIN; UPDATE first_input SET value=2; UPDATE second_input SET value=2; COMMIT");
    await barrier.query("COMMIT");
    await capture;
    await lake.detach();
    assertEquals(
      await lake.query("SELECT a.value AS first, b.value AS second FROM slow_input a CROSS JOIN second_input b"),
      [{ first: 1, second: 1 }],
    );
  } finally {
    await barrier.end();
  }
});

pgTest(
  "a new snapshot sees a commit out of xid order without statistics",
  async () => {
    // A transaction holding an older xid that commits after a younger one:
    // row counts and the newest stamped txid both miss it, which is how the
    // lake once kept a result recorded under a long transaction.
    await using pg = await postgres();
    await psql(
      pg.url,
      `CREATE TABLE game (id int PRIMARY KEY, v int, txid bigint DEFAULT pg_current_xact_id()::text::bigint);
     CREATE FUNCTION restamp() RETURNS trigger LANGUAGE plpgsql AS
       $$BEGIN NEW.txid := pg_current_xact_id()::text::bigint; RETURN NEW; END$$;
     CREATE TRIGGER restamp BEFORE UPDATE ON game FOR EACH ROW EXECUTE FUNCTION restamp();
     INSERT INTO game (id, v) VALUES (1, 0), (2, 0);`,
    );
    const older = new Deno.Command("psql", {
      args: [pg.url, "-Xq"],
      stdin: "piped",
      stdout: "null",
    }).spawn();
    const writer = older.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode("BEGIN; UPDATE game SET v = 1 WHERE id = 1;\n"),
    );
    await eventually(async () =>
      (await psql(
        pg.url,
        "SELECT count(*) FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND state = 'idle in transaction'",
      )) === "1"
    );
    await psql(pg.url, "UPDATE game SET v = 2 WHERE id = 2");
    const lake = await Lake.open(pg.url, await Deno.makeTempDir());
    await lake.attach();
    await lake.hold(["game"]);
    await lake.detach();
    const stamped = await psql(pg.url, "SELECT count(*), max(txid) FROM game");
    assertEquals(await lake.query("SELECT v FROM game ORDER BY id"), [
      { v: 0 },
      { v: 2 },
    ]);
    await writer.write(new TextEncoder().encode("COMMIT;\n"));
    await writer.close();
    assert((await older.status).success);
    assertEquals(
      await psql(pg.url, "SELECT count(*), max(txid) FROM game"),
      stamped,
    );
    await lake.attach();
    await lake.hold(["game"]);
    await lake.detach();
    assertEquals(await lake.query("SELECT v FROM game ORDER BY id"), [
      { v: 1 },
      { v: 2 },
    ]);
  },
);

pgTest(
  "a fresh snapshot replaces truncated data without statistics",
  async () => {
    await using pg = await postgres();
    await psql(
      pg.url,
      "CREATE TABLE game (id int PRIMARY KEY); INSERT INTO game VALUES (1)",
    );
    const lake = await Lake.open(pg.url, await Deno.makeTempDir());
    await lake.attach();
    await lake.hold(["game"]);
    await lake.detach();
    assertEquals(await lake.query("SELECT * FROM game"), [{ id: 1 }]);
    await psql(pg.url, "TRUNCATE game");
    await lake.attach();
    await lake.hold(["game"]);
    await lake.detach();
    assertEquals(await lake.query("SELECT * FROM game"), []);
  },
);

pgTest(
  "each invalidation replaces all declared inputs before detaching Postgres",
  async () => {
    await using pg = await postgres();
    await psql(
      pg.url,
      "CREATE TABLE a (id int); CREATE TABLE b (id int); INSERT INTO a VALUES (1); INSERT INTO b VALUES (1)",
    );
    const lake = await Lake.open(pg.url, await Deno.makeTempDir());
    await lake.attach();
    await lake.hold(["a", "b"]);
    await lake.detach();
    await psql(pg.url, "BEGIN; UPDATE a SET id=2; UPDATE b SET id=2; COMMIT");
    await lake.attach();
    await lake.hold(["a", "b"]);
    await lake.detach();
    assertEquals(
      await lake.query("SELECT a.id a, b.id b FROM a CROSS JOIN b"),
      [{ a: 2, b: 2 }],
    );
    await assertRejects(() => lake.query("SELECT * FROM pg.public.a"));
  },
);

pgTest("a query answers plain rows", async () => {
  await using pg = await postgres();
  await psql(pg.url, "CREATE TABLE t (id uuid, n text, d date, k timestamptz)");
  await psql(
    pg.url,
    "INSERT INTO t VALUES ('00000000-0000-4000-8000-000000000001', '12', '2026-05-24', '2026-05-24 19:00:00+02')",
  );
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  await lake.attach();
  await lake.hold(["t"]);
  await lake.detach();
  assertEquals(
    await lake.query(
      "SELECT id, n::BIGINT AS n, n::DECIMAL(5, 1) AS x, d, k, [n::INTEGER] AS l, {'n': n::HUGEINT} AS s FROM t",
    ),
    [{
      id: "00000000-0000-4000-8000-000000000001",
      n: 12,
      x: 12,
      d: "2026-05-24",
      k: "2026-05-24 17:00:00+00",
      l: [12],
      s: { n: 12 },
    }],
  );
  await assertRejects(() => lake.query("SELECT (2::HUGEINT ** 60)::HUGEINT AS big"), RangeError);
});

const uleb = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...uleb(n >>> 7)]);
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const name = (s: string) => vec([...new TextEncoder().encode(s)].map((b) => [b]));
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const i32 = (n: number) => [0x41, ...(n < 64 ? [n] : [(n & 0x7f) | 0x80, ...uleb(n >>> 7)])];
const store = (at: number, value: number[]) => [...i32(at), ...value, 0x36, 2, 0];
const load = (at: number) => [...i32(at), 0x28, 2, 0];
// fd_read one iovec of 4 KiB at 16, then fd_write what it read.
const ECHO = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  ...section(1, vec([[0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], [0x60, 0, 0]])),
  ...section(2, vec(["fd_read", "fd_write"].map((f) => [...name("wasi_snapshot_preview1"), ...name(f), 0, 0]))),
  ...section(3, vec([[1]])),
  ...section(5, vec([[0, 1]])),
  ...section(7, vec([[...name("memory"), 2, 0], [...name("_start"), 0, 2]])),
  ...section(
    10,
    vec([(() => {
      const body = [
        0,
        ...store(0, i32(16)),
        ...store(4, i32(4096)),
        ...i32(0),
        ...i32(0),
        ...i32(1),
        ...i32(8),
        0x10,
        0,
        0x1a,
        ...store(4, load(8)),
        ...i32(1),
        ...i32(0),
        ...i32(1),
        ...i32(12),
        0x10,
        1,
        0x1a,
        0x0b,
      ];
      return [...uleb(body.length), ...body];
    })()]),
  ),
]);

const ROUNDS = `
export const reads = ["game"];
export const queries = { games: "SELECT 1" };
// A job per game, then one more that sums what the first ones wrote.
export const plan = (inputs, seed, outputs) => {
  const first = inputs.games.map((g) => ({ wasm: "echo", input: { id: g.id, seed } }));
  return outputs.length === 0 ? first : [...first, { wasm: "echo", input: outputs.slice(0, first.length).map((o) => o.id) }];
};
export const finish = (inputs, outputs) => ({
  sink: outputs.slice(0, -1).map((o) => ({ id: o.id, seed: o.seed, all: outputs.at(-1).join() })),
});
`;

Deno.test("Duckstream source bindings must match module reads before capture", async () => {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/source.js`;
  await Deno.writeTextFile(file, `export const reads = ["event"];
export const queries = { events: "SELECT * FROM event" };
export const plan = () => [];
export const finish = () => ({sink: []});`);
  const runner = new Runner({});
  const spec = { name: "source", file, to: ["sink"], wasm: [] };
  try {
    await Computation.load({ ...spec, declaredReads: ["event"] }, runner);
    for (const declaredReads of [[], ["other"], ["event", "other"]]) {
      await assertRejects(() => Computation.load({ ...spec, declaredReads }, runner), Error,
        "module reads differ from declared Duckstream sources");
    }
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a run plans in rounds and finishes in job order", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/rounds.js`, ROUNDS);
  await Deno.writeFile(`${dir}/echo.wasm`, ECHO);
  const games = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}` }));
  const reader = { query: () => Promise.resolve(games) };
  const spec = { name: "rounds", file: `${dir}/rounds.js`, to: ["sink"], wasm: [`${dir}/echo.wasm`], endowments: [] };
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const seed = await seedOf("rounds");
    const all = games.map((g) => g.id).join();
    assertEquals(
      await (await Computation.load(spec, runner)).run(reader),
      { sink: games.map((g) => ({ id: g.id, seed, all })) },
    );
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CDC fanout reuses only an identical fresh read; failures and caller mutations cannot poison the answer", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/rounds.js`, ROUNDS);
  class CountingRunner extends Runner {
    calls = 0;
    fail = false;
    override async run(jobs: Job[]) {
      this.calls++;
      if (this.fail) throw new Error("injected job failure");
      return await super.run(jobs);
    }
  }
  const runner = new CountingRunner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const c = await Computation.load(
      { name: "rounds", file: `${dir}/rounds.js`, to: ["sink"], wasm: [`${dir}/echo.wasm`], endowments: [] },
      runner,
    );
    const rows = [{ id: "g1" }];
    let reads = 0;
    const reader = {
      query: () => {
        reads++;
        return Promise.resolve(rows);
      },
    };
    const first = await c.run(reader) as { sink: { id: string }[] };
    const expected = structuredClone(first);
    first.sink[0].id = "caller-mutated";
    assertEquals(await c.run(reader), expected);
    assertEquals([reads, runner.calls], [2, 2]);
    await assertRejects(() => c.run({ query: () => Promise.reject(new Error("read failed")) }), Error, "read failed");
    rows[0].id = "g2";
    runner.fail = true;
    await assertRejects(() => c.run(reader), Error, "injected job failure");
    runner.fail = false;
    const changed = await c.run(reader) as { sink: { id: string }[] };
    assertEquals(changed.sink[0].id, "g2");
    assertEquals(runner.calls, 5);
    assertEquals(await c.run(reader), changed);
    assertEquals(runner.calls, 5);
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed job ends its run and leaves the runner to the next", async () => {
  // The runner outlives a run, so nothing of a run that failed may answer a
  // job of the next: a job queued behind the failed one, or its reply.
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    await assertRejects(
      () => runner.run([{ wasm: "echo", input: "1" }, { wasm: "missing", input: "2" }, { wasm: "echo", input: "3" }]),
      Error,
      "job 1 (missing)",
    );
    assertEquals(await runner.run([{ wasm: "echo", input: "4" }, { wasm: "echo", input: "5" }]), [4, 5]);
  } finally {
    runner.close();
  }
});

Deno.test("a job naming a wasm the computation does not ship fails the run", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/stray.js`,
    ROUNDS.replace('wasm: "echo", input: { id', 'wasm: "other", input: { id'),
  );
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const c = await Computation.load(
      { name: "stray", file: `${dir}/stray.js`, to: ["sink"], wasm: [`${dir}/echo.wasm`], endowments: [] },
      runner,
    );
    await assertRejects(
      () => c.run({ query: () => Promise.resolve([{ id: "g" }]) }),
      Error,
      "no {wasm, input} of echo",
    );
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a plan that changes a job already answered fails the run", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/fickle.js`,
    `export const reads = []; export const queries = {};
     export const plan = (inputs, seed, outputs) =>
       outputs.length === 0 ? [{ wasm: "echo", input: 1 }] : [{ wasm: "echo", input: 2 }, { wasm: "echo", input: 3 }];
     export const finish = () => ({});`,
  );
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const c = await Computation.load(
      { name: "fickle", file: `${dir}/fickle.js`, to: [], wasm: [`${dir}/echo.wasm`], endowments: [] },
      runner,
    );
    await assertRejects(
      () => c.run({ query: () => Promise.resolve([]) }),
      Error,
      "plan changed the jobs it was answered",
    );
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pure job identities include engine, module bytes, command and exact stdin; failures cannot fill the cache", async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const cache: JobCache = {
    get: (keys) => Promise.resolve(new Map(keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)!]))),
    put: (key, result) => {
      writes++;
      values.set(key, result);
      return Promise.resolve();
    },
  };
  const job = { wasm: "echo", input: '{"n":-0}' };
  using runner = await Runner.cached({ echo: ECHO, alias: ECHO }, cache);
  const first = await runner.run([job, job]) as { n: number }[];
  assert(Object.is(first[0].n, -0));
  assert(Object.is(first[1].n, -0));
  assertEquals(writes, 1);
  first[0].n = 12;
  assert(Object.is(((await runner.run([job]))[0] as { n: number }).n, -0));
  assertEquals(writes, 1);
  await runner.run([{ ...job, input: '{ "n":-0}' }, { ...job, wasm: "alias" }]);
  assertEquals(writes, 3);
  await assertRejects(() => runner.run([{ ...job, input: "not JSON" }]), Error);
  await assertRejects(() => runner.run([{ ...job, input: "not JSON" }]), Error);
  assertEquals(writes, 3);
  using restarted = await Runner.cached({ echo: ECHO }, cache);
  await restarted.run([job]);
  assertEquals(writes, 3);
  const changed = new Uint8Array([...ECHO, 0, 2, 1, 120]);
  using upgraded = await Runner.cached({ echo: changed }, cache);
  await upgraded.run([job]);
  assertEquals(writes, 4);
  assert(await jobKey("engine-v1", job) !== await jobKey("engine-v2", job));
  assertEquals(await executionVersion(), await executionVersion());
  await assertRejects(() => restarted.run([{ ...job, wasm: "missing" }]), Error, "execution identity");
  const failedCache: JobCache = { ...cache, get: () => Promise.reject(new Error("cache unavailable")) };
  using unavailable = await Runner.cached({ echo: ECHO }, failedCache);
  await assertRejects(() => unavailable.run([job]), Error, "cache unavailable");
  const failedWrite: JobCache = {
    get: () => Promise.resolve(new Map()),
    put: () => Promise.reject(new Error("cache write failed")),
  };
  using unwritable = await Runner.cached({ echo: ECHO }, failedWrite);
  await assertRejects(() => unwritable.run([job]), Error, "cache write failed");
});

pgTest("durable job reuse keeps full phased results after edits, deletions and worker/cache restart", async () => {
  await using server = await postgres();
  const dir = await Deno.makeTempDir();
  const spec = { name: "rounds", file: `${dir}/rounds.js`, to: ["sink"], wasm: [`${dir}/echo.wasm`] };
  let writes = 0;
  const counted = (cache: JobCache): JobCache => ({
    get: (keys) => cache.get(keys),
    put: async (key, result) => {
      writes++;
      await cache.put(key, result);
    },
  });
  const expected = async (ids: string[], name = spec.name) => ({
    sink: await Promise.all(ids.map(async (id) => ({ id, seed: await seedOf(name), all: ids.join() }))),
  });
  try {
    await Deno.writeTextFile(spec.file, ROUNDS);
    {
      await using cache = await PostgresJobCache.open(server.url);
      using runner = await Runner.cached({ echo: ECHO }, counted(cache));
      const computation = await Computation.load(spec, runner);
      assertEquals(await computation.calculate({ games: [{ id: "a" }, { id: "b" }] }), await expected(["a", "b"]));
      assertEquals(writes, 3);
      assertEquals(await computation.calculate({ games: [{ id: "a" }, { id: "c" }] }), await expected(["a", "c"]));
      assertEquals(writes, 5);
      assertEquals(await computation.calculate({ games: [{ id: "a" }] }), await expected(["a"]));
      assertEquals(writes, 6);
    }
    {
      await using cache = await PostgresJobCache.open(server.url);
      using runner = await Runner.cached({ echo: ECHO }, counted(cache));
      const replay = await Computation.load(spec, runner);
      assertEquals(await replay.calculate({ games: [{ id: "a" }, { id: "b" }] }), await expected(["a", "b"]));
      assertEquals(writes, 6);
      const other = await Computation.load({ ...spec, name: "different-seed" }, runner);
      assertEquals(await other.calculate({ games: [{ id: "a" }, { id: "b" }] }), await expected(["a", "b"], "different-seed"));
      assertEquals(writes, 8);
      assertEquals(await replay.calculate({ games: [] }), { sink: [] });
      assertEquals(writes, 8);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
