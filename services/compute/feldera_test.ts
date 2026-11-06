import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Feldera, type FelderaProgram } from "./feldera.ts";
import type { Row } from "./main.ts";

const fields = [{ name: "id", type: "BIGINT" }, {
  name: "at",
  type: "TIMESTAMP",
}];
const program: FelderaProgram = {
  sql:
    "CREATE TABLE source (id BIGINT, at TIMESTAMP); CREATE MATERIALIZED VIEW result AS SELECT * FROM source;",
  inputs: { source: { query: "SELECT id, at FROM frozen", fields } },
  outputs: { answer: { view: "result", fields } },
};
const a = { id: 1, at: "2026-10-23T03:10:02.123456Z" };
const reader = (rows: Row[]) => ({ query: () => Promise.resolve(rows) });

function runtime(descriptor: FelderaProgram = program) {
  const original = globalThis.fetch;
  const relation = (name: string) => ({
    name,
    materialized: true,
    fields:
      (name === "source"
        ? descriptor.inputs.source.fields
        : descriptor.outputs.answer.fields).map((
          { name: fieldName, type },
        ) => ({
          name: fieldName,
          columntype: {
            type,
            ...(type === "TIMESTAMP" ? { precision: 6 } : type === "VARCHAR"
              ? {
                precision: name === "source"
                  ? fake.inputPrecision
                  : fake.outputPrecision,
              }
              : {}),
          },
        })),
  });
  const fake = {
    incarnation: "one",
    inputPrecision: -1,
    outputPrecision: -1,
    records: 0,
    rows: [] as Row[],
    posts: [] as unknown[][],
    requests: [] as string[],
    fail: "",
    failAfterIngress: false,
    invalidOutput: false,
    restartOnRead: false,
    parseErrors: 0,
    connectors: {},
    state: "Running",
    [Symbol.dispose]() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/v0/pipelines/test", "");
    const method = init?.method ?? "GET";
    fake.requests.push(`${method} ${path}`);
    if (path === fake.fail && fake.fail) {
      return Promise.resolve(new Response("connection lost", { status: 503 }));
    }
    let value: unknown;
    if (path === "/stop") fake.state = "Stopped";
    if (path === "/start") fake.state = "Running";
    if (method === "PUT") {
      fake.records = 0;
      fake.rows = [];
    }
    if (path === "") {
      value = {
        deployment_status: fake.state,
        deployment_id: "deployment",
        program_status: "Success",
        platform_version: "0.367.0+test",
        program_code: descriptor.sql,
        program_info: {
          input_connectors: fake.connectors,
          output_connectors: {},
          schema: {
            inputs: [relation("source")],
            outputs: [relation("result")],
          },
        },
      };
    } else if (path.startsWith("/ingress")) {
      const updates: ({ insert?: Row; delete?: Row })[] = JSON.parse(
        String(init?.body),
      );
      fake.posts.push(updates);
      fake.records += updates.length;
      for (const change of updates) {
        if (change.insert) fake.rows.push(change.insert);
        else {
          const index = fake.rows.findIndex((row) =>
            JSON.stringify(row) === JSON.stringify(change.delete)
          );
          if (index < 0) throw new Error("invalid retraction");
          fake.rows.splice(index, 1);
        }
      }
      if (fake.failAfterIngress) {
        return Promise.resolve(
          new Response("lost ingress response", { status: 503 }),
        );
      }
      value = { token: fake.incarnation };
    } else if (path === "/completion_status") {
      if (parsed.searchParams.get("token") !== fake.incarnation) {
        return Promise.resolve(
          new Response("stale incarnation", { status: 410 }),
        );
      }
      value = { status: "complete" };
    } else if (path === "/stats") {
      value = {
        global_metrics: {
          incarnation_uuid: fake.incarnation,
          runtime_version: "0.367.0",
          total_input_records: fake.records,
          total_completed_records: fake.records,
        },
        inputs: [{
          fatal_error: null,
          metrics: {
            num_parse_errors: fake.parseErrors,
            num_transport_errors: 0,
          },
        }],
        outputs: [],
      };
    } else if (path === "/query") {
      if (fake.restartOnRead) fake.incarnation = "restarted";
      return Promise.resolve(
        new Response(
          fake.invalidOutput
            ? '{"id":9007199254740992,"at":null}\n'
            : fake.rows.map((row) => JSON.stringify(row)).join("\n"),
        ),
      );
    } else value = "ok";
    return Promise.resolve(Response.json(value));
  };
  return fake;
}
const adapter = () => new Feldera("http://localhost:18096", "test", program);

Deno.test("Feldera computes multiset deltas, retains state, and publishes only completed captures", async () => {
  using fake = runtime();
  const f = adapter();
  assertEquals(await f.capture(reader([a, a])), { answer: [a, a] });
  assertEquals(await f.capture(reader([a])), { answer: [a] });
  const changed = { ...a, id: 2 };
  assertEquals(await f.capture(reader([changed])), { answer: [changed] });
  assertEquals(await f.capture(reader([])), { answer: [] });
  assertEquals(fake.posts, [[{ insert: a }, { insert: a }], [{ delete: a }], [{
    delete: a,
  }, { insert: changed }], [{ delete: changed }]]);
  assertEquals(
    fake.requests.filter((path) => path.startsWith("PUT")).length,
    1,
  );
  assertEquals(
    fake.requests.indexOf("GET /query") >
      fake.requests.indexOf("GET /completion_status"),
    true,
  );
});

Deno.test("Feldera establishes a token even for an empty first capture", async () => {
  using fake = runtime();
  assertEquals(await adapter().capture(reader([])), { answer: [] });
  assertEquals(fake.posts, [[]]);
  assertEquals(fake.requests.includes("GET /completion_status"), true);
});

Deno.test("Feldera refuses unsupported and lossy values before HTTP mutation", async () => {
  using fake = runtime();
  for (
    const type of ["DECIMAL", "REAL", "TIMESTAMP_TZ", "UUID", "VARCHAR(4)"]
  ) {
    const invalid = structuredClone(program);
    invalid.inputs.source.fields[0].type = type;
    assertThrows(
      () => new Feldera("http://localhost", "test", invalid),
      Error,
      "unsupported type",
    );
  }
  for (
    const row of [
      { ...a, id: 9007199254740992 },
      { ...a, at: "2026-02-30T03:10:02.000000Z" },
      { ...a, at: "2026-10-23T03:10:02.1234567Z" },
      { ...a, extra: 1 },
    ]
  ) {
    await assertRejects(() => adapter().capture(reader([row])), Error);
  }
  assertEquals(fake.requests, []);
});

Deno.test("Feldera refuses descriptor connector metadata", async () => {
  using fake = runtime();
  fake.connectors = { forbidden: {} };
  await assertRejects(
    () => adapter().capture(reader([a])),
    Error,
    "connectors are forbidden",
  );
  assertEquals(fake.posts, []);
  assertEquals(fake.requests.includes("POST /start"), false);
});

Deno.test("Feldera permanently poisons ambiguous ingress without retry", async () => {
  using fake = runtime();
  fake.failAfterIngress = true;
  const f = adapter();
  await assertRejects(() => f.capture(reader([a])), Error, "503");
  fake.failAfterIngress = false;
  assertEquals(fake.rows, [a]);
  await assertRejects(() => f.capture(reader([a])), Error, "poisoned");
  assertEquals(
    fake.requests.filter((path) => path === "POST /ingress/source").length,
    1,
  );
});

Deno.test("Feldera refuses restart between captures and during egress", async () => {
  using fake = runtime();
  const f = adapter();
  await f.capture(reader([a]));
  fake.incarnation = "restarted";
  await assertRejects(
    () => f.capture(reader([a])),
    Error,
    "incarnation changed",
  );
  const fresh = adapter();
  fake.restartOnRead = true;
  fake.incarnation = "another";
  await assertRejects(
    () => fresh.capture(reader([a])),
    Error,
    "incarnation changed",
  );
  await assertRejects(() => fresh.capture(reader([a])), Error, "poisoned");
});

Deno.test("Feldera refuses an external writer, parse errors, and lossy output", async () => {
  using fake = runtime();
  const f = adapter();
  await f.capture(reader([a]));
  fake.records++;
  await assertRejects(() => f.capture(reader([a])), Error, "unexpected writer");
  fake.parseErrors = 1;
  await assertRejects(
    () => adapter().capture(reader([a])),
    Error,
    "ingress failed",
  );
  fake.parseErrors = 0;
  fake.invalidOutput = true;
  const invalid = adapter();
  await assertRejects(
    () => invalid.capture(reader([a])),
    Error,
    "safe integer",
  );
  await assertRejects(() => invalid.capture(reader([a])), Error, "poisoned");
});

Deno.test("Feldera rejects concurrent captures and poisons the in-flight capture", async () => {
  using _fake = runtime();
  const pending = Promise.withResolvers<Row[]>();
  const f = adapter();
  const first = f.capture({ query: () => pending.promise });
  await assertRejects(
    () => f.capture(reader([a])),
    Error,
    "concurrent capture",
  );
  pending.resolve([a]);
  await assertRejects(() => first, Error, "poisoned");
});

Deno.test("Feldera poisons failed egress after successful ingress", async () => {
  using fake = runtime();
  fake.fail = "/query";
  const f = adapter();
  await assertRejects(() => f.capture(reader([a])), Error, "503");
  assertEquals(fake.rows, [a]);
  fake.fail = "";
  await assertRejects(() => f.capture(reader([a])), Error, "poisoned");
  assertEquals(fake.posts.length, 1);
});

Deno.test("Feldera admits native bounded VARCHAR outputs but refuses truncating inputs", async () => {
  const descriptor = structuredClone(program);
  descriptor.sql =
    "CREATE TABLE source (id VARCHAR, at TIMESTAMP); CREATE MATERIALIZED VIEW result AS SELECT id, at FROM source;";
  descriptor.inputs.source.fields[0].type = "VARCHAR";
  descriptor.outputs.answer.fields[0].type = "VARCHAR";
  using fake = runtime(descriptor);
  fake.outputPrecision = 3;
  const row = { id: "the", at: a.at };
  const f = new Feldera("http://localhost", "test", descriptor);
  assertEquals(await f.capture(reader([row])), { answer: [row] });
  fake.inputPrecision = 3;
  await assertRejects(
    () =>
      new Feldera("http://localhost", "test", descriptor).capture(
        reader([row]),
      ),
    Error,
    "bounded input VARCHAR",
  );
});
