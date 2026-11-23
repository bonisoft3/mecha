// One execution, scripted step by step, through the server's node-api adapter
// and the edge's synchronous adapter: every answer must be the same.
import { assertEquals } from "@std/assert";
import { DuckDBInstance } from "npm:@duckdb/node-api@1.5.6-r.1";
import { capturedRows, captureDigest, captureQuery } from "../../packages/compute-snapshot/src/capture.ts";
import { type ExecutionDatabase, PagedExecution } from "../../packages/compute-snapshot/src/execution.ts";
import { executionDatabase as edgeDatabase } from "../../packages/mecha-edge/src/execution-host.ts";
import { fixture, host } from "../../packages/mecha-edge/test/duckdb-fixture.ts";
import { executionDatabase } from "./bounded-runtime.ts";
import { fields, nativeSql, row, table } from "./portable-fixture.ts";

async function script(execution: PagedExecution) {
  const answers: unknown[] = [];
  const record = async (work: Promise<unknown>) => {
    try {
      answers.push(await work);
    } catch (error) {
      answers.push({ error: (error as Error).message });
    }
  };
  await record(execution.state());
  await record(execution.commit(0, {
    checkpoint: { phase: 1, wide: 1e30 },
    statements: [
      "CREATE TABLE notes(id VARCHAR, n DOUBLE)",
      "CREATE TABLE scratch AS SELECT i::INTEGER AS i, i::VARCHAR AS r, 1.5::DECIMAL(9,2) AS amount, DATE '2026-11-22' + i::INTEGER AS day, [i, i + 1] AS pair, {'n': i} AS nested, TIMESTAMPTZ '2026-11-22 10:00:00+00' AS at, TIMESTAMP '2026-11-22 10:00:00' AS local FROM range(3) t(i)",
    ],
    writes: {
      a: [
        { id: "z", value: { text: 'line\nquoted "x" café', wide: 1e30 } },
        { id: "m", value: { text: "雪", wide: 2 ** 53, decimal: 1000000000000000100 } },
      ],
      b: [],
    },
    done: false,
  }));
  await record(execution.query("SELECT * FROM scratch ORDER BY i"));
  await record(execution.query("SELECT 9007199254740993::BIGINT AS unsafe"));
  await record(execution.query("SELECT 1; SELECT 2"));
  const sql =
    "SELECT i::BIGINT AS ordinal, repeat('é', i % 700) AS text, i AS r FROM range(5000) t(i)";
  for (let after = -1;;) {
    const page = await execution.queryPage(sql, "ordinal", 1, after);
    answers.push({ after: page.after, next: page.next, done: page.done, count: page.rows.length, last: page.rows.at(-1) });
    if (page.done) break;
    after = page.next;
  }
  await record(execution.queryPage("SELECT 1 AS ordinal UNION ALL SELECT 1", "ordinal", 1));
  await record(execution.commit(1, {
    checkpoint: null,
    statements: ["INSERT INTO notes VALUES('x', 2.25)"],
    writes: { a: [{ id: "a", value: { text: "first", wide: -0.5 } }, { id: "z", value: { text: "replaced", wide: 0 } }] },
    done: true,
  }));
  await record(execution.query("SELECT * FROM notes"));
  await record(execution.commit(2, { checkpoint: null, writes: {}, done: true }));
  await record(execution.manifest());
  for (const sink of ["a", "b"]) {
    for (let after = 0;;) {
      const page = await execution.output(sink, after);
      answers.push(page);
      if (page.done) break;
      after = page.next;
    }
  }
  await record(execution.dropScratch());
  await record(execution.query("SELECT count(*)::INTEGER AS n FROM duckdb_tables() WHERE table_name IN ('notes', 'scratch')"));
  return answers;
}

Deno.test("the server's and the edge's DuckDB answer one execution alike", async () => {
  const server = await DuckDBInstance.create(":memory:", { threads: "1" });
  const edge = await fixture();
  try {
    const expected = await script(await PagedExecution.open(edgeDatabase(host(edge)), ["a", "b"]));
    const actual = await script(await PagedExecution.open(executionDatabase(server), ["a", "b"]));
    assertEquals(actual, expected);
  } finally {
    server.closeSync();
    edge.reset();
  }
});

// The duckdb-wasm stand-in for workerd's build has no ICU, so no timestamp crosses here.
const portable = fields.filter((field) => field.type !== "timestamp");
const { timestamp_value: _, ...portableRow } = row;
const portableSql = `SELECT * EXCLUDE (timestamp_value) FROM (${nativeSql})`;

async function capture(db: ExecutionDatabase) {
  const conn = await db.connect();
  try {
    await conn.query("CREATE SCHEMA duckstream_private");
    const captured: Record<string, unknown> = {};
    const queries = {
      typed: [portableSql, { fields: portable, types: table }],
      untyped: [
        "SELECT i::VARCHAR AS id, '{\"a\":1}'::JSON AS document, 'null'::JSON AS literal, i::DOUBLE / 3 AS third, 1e30 AS wide, [i, -i] AS pair, {'r': i} AS r, repeat('é', (i % 10) * 60) AS text FROM range(5000) t(i) ORDER BY i DESC",
        undefined,
      ],
    } as const;
    for (const [name, [sql, boundary]] of Object.entries(queries)) {
      const target = `duckstream_private.result_${name}`;
      await conn.query(`CREATE TABLE ${target}(sequence BIGINT, value VARCHAR)`);
      await captureQuery(conn, target, sql, boundary);
      const lines: string[] = [];
      await captureDigest(conn, target, (line) => lines.push(line));
      const rows = (await conn.query(`SELECT sequence::INTEGER AS sequence, value FROM ${target} ORDER BY sequence`))
        .map((row) => ({ sequence: Number(row.sequence), value: String(row.value) }));
      captured[name] = { lines, first: rows.slice(0, 3), last: rows.at(-1), count: rows.length };
      // Pages and Cloudflare's single-call path read every row at once from the same capture.
      await conn.query("BEGIN");
      assertEquals(await capturedRows(conn, sql, boundary), rows.map((row) => JSON.parse(row.value)));
      await conn.query("ROLLBACK");
    }
    return captured;
  } finally {
    conn.close();
  }
}

Deno.test("the server's and the edge's DuckDB capture one relation as the same text and digest", async () => {
  const server = await DuckDBInstance.create(":memory:", { threads: "1" });
  const edge = await fixture();
  try {
    const expected = await capture(edgeDatabase(host(edge)));
    const actual = await capture(executionDatabase(server));
    assertEquals(actual, expected);
    const typed = actual.typed as { first: { value: string }[] };
    assertEquals(JSON.parse(typed.first[0].value), portableRow);
    // A JSON column is captured as its text, as the server's reader returned it.
    const untyped = actual.untyped as { first: { value: string }[] };
    assertEquals(JSON.parse(untyped.first[0].value).document, '{"a":1}');
    assertEquals(JSON.parse(untyped.first[0].value).literal, "null");
  } finally {
    server.closeSync();
    edge.reset();
  }
});
