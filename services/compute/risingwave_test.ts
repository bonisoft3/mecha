import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  configureRisingWaveStorage,
  RisingWave,
  type RisingWaveProgram,
  type RisingWaveSqlSession,
  rows,
  translateRisingWaveSql,
} from "./risingwave.ts";
import type { Row } from "./main.ts";

const fields = [{ name: "id", type: "BIGINT" }, {
  name: "at",
  type: "TIMESTAMP",
}];
const program: RisingWaveProgram = {
  sql:
    "CREATE TABLE source (id BIGINT, at TIMESTAMP); CREATE MATERIALIZED VIEW result AS SELECT * FROM source;",
  inputs: { source: { query: "SELECT id, at FROM frozen", fields } },
  outputs: { answer: { view: "result", fields } },
};
const a = { id: 1, at: "2026-10-23T03:10:02.123456Z" };
const b = { id: 2, at: "2026-10-23T03:10:03.000000Z" };
const reader = (r: Row[]) => ({ query: () => Promise.resolve(r) });

function fakeSession() {
  const store = new Map<string, Row>();
  const queries: string[] = [];
  let failDml = false;
  let failQuery = false;
  let invalidOutput = false;
  let closed = false;

  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
    ): Promise<{ rows: R[] }> {
      queries.push(text);
      if (text.startsWith("INSERT INTO raw_source")) {
        if (failDml) return Promise.reject(new Error("connection lost"));
        const match = /VALUES \('([^']+)', (\d+), TIMESTAMP '([^']+)'\)/.exec(
          text,
        );
        if (match) {
          store.set(match[1], {
            id: Number(match[2]),
            at: match[3].replace(" ", "T") + "Z",
          });
        }
        return Promise.resolve({ rows: [] });
      }
      if (text.startsWith("DELETE FROM raw_source")) {
        if (failDml) return Promise.reject(new Error("connection lost"));
        const match = /WHERE __row_key = '([^']+)'/.exec(text);
        if (match) {
          if (!store.has(match[1])) {
            return Promise.reject(new Error("invalid retraction"));
          }
          store.delete(match[1]);
        }
        return Promise.resolve({ rows: [] });
      }
      if (text.startsWith('SELECT * FROM "result"')) {
        if (failQuery) return Promise.reject(new Error("503"));
        if (invalidOutput) {
          return Promise.resolve({
            rows: [{ id: 9007199254740992, at: null }] as unknown as R[],
          });
        }
        return Promise.resolve({
          rows: [...store.values()] as unknown as R[],
        });
      }
      return Promise.resolve({ rows: [] });
    },
    end(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    session,
    connect: () => Promise.resolve(session),
    queries,
    store,
    set failDml(v: boolean) {
      failDml = v;
    },
    set failQuery(v: boolean) {
      failQuery = v;
    },
    set invalidOutput(v: boolean) {
      invalidOutput = v;
    },
    get closed() {
      return closed;
    },
  };
}

Deno.test("RisingWave captures multiset snapshots via bag differences", async () => {
  const fake = fakeSession();
  const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
  assertEquals(await rw.capture(reader([a, a, b])), { answer: [a, a, b] });
  assertEquals(await rw.capture(reader([a, b])), { answer: [a, b] });
  assertEquals(await rw.capture(reader([])), { answer: [] });
  await rw.close();
  assertEquals(fake.closed, true);
});

Deno.test("RisingWave flushes an empty first capture", async () => {
  const fake = fakeSession();
  const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
  assertEquals(await rw.capture(reader([])), { answer: [] });
  assertEquals(fake.queries.includes("FLUSH"), true);
});

Deno.test("RisingWave refuses unsupported and lossy values before mutation", async () => {
  const fake = fakeSession();
  for (
    const type of ["DECIMAL", "REAL", "TIMESTAMP_TZ", "UUID", "VARCHAR(4)"]
  ) {
    const invalid = structuredClone(program);
    invalid.inputs.source.fields[0].type = type;
    assertThrows(
      () => new RisingWave("http://localhost:4566", "test", invalid, fake.connect),
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
    const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
    await assertRejects(() => rw.capture(reader([row])), Error);
  }
  assertEquals(fake.queries, []);
});

Deno.test("RisingWave permanently poisons ambiguous DML or query failures without retry", async () => {
  const fake = fakeSession();
  fake.failDml = true;
  const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
  await assertRejects(() => rw.capture(reader([a])), Error, "connection lost");
  fake.failDml = false;
  await assertRejects(() => rw.capture(reader([a])), Error, "poisoned");

  const fake2 = fakeSession();
  fake2.failQuery = true;
  const rw2 = new RisingWave("http://localhost:4566", "test", program, fake2.connect);
  await assertRejects(() => rw2.capture(reader([a])), Error, "503");
  fake2.failQuery = false;
  await assertRejects(() => rw2.capture(reader([a])), Error, "poisoned");
});

Deno.test("RisingWave rejects lossy output and poisons the adapter", async () => {
  const fake = fakeSession();
  fake.invalidOutput = true;
  const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
  await assertRejects(() => rw.capture(reader([a])), Error, "safe integer");
  await assertRejects(() => rw.capture(reader([a])), Error, "poisoned");
});

Deno.test("RisingWave rejects concurrent captures and poisons the in-flight capture", async () => {
  const fake = fakeSession();
  const pending = Promise.withResolvers<Row[]>();
  const rw = new RisingWave("http://localhost:4566", "test", program, fake.connect);
  const first = rw.capture({ query: () => pending.promise });
  await assertRejects(
    () => rw.capture(reader([a])),
    Error,
    "concurrent capture",
  );
  pending.resolve([a]);
  await assertRejects(() => first, Error, "poisoned");
});

Deno.test("RisingWave admits bounded VARCHAR outputs in SQL casts but refuses truncating inputs", async () => {
  const fake = fakeSession();
  const descriptor = structuredClone(program);
  descriptor.sql =
    "CREATE TABLE source (id VARCHAR(3), at TIMESTAMP); CREATE MATERIALIZED VIEW result AS SELECT id, at FROM source;";
  descriptor.inputs.source.fields[0].type = "VARCHAR";
  descriptor.outputs.answer.fields[0].type = "VARCHAR";
  const rw = new RisingWave("http://localhost:4566", "test", descriptor, fake.connect);
  await assertRejects(
    () => rw.capture(reader([{ id: "the", at: a.at }])),
    Error,
    "bounded input VARCHAR",
  );
});

Deno.test("translateRisingWaveSql rewrites Calcite/Duckstream constructs without mutating string literals or quoted identifiers", () => {
  const sql = [
    'CREATE TABLE t (id VARCHAR, ts TIMESTAMP(6), amount DOUBLE, "position" VARCHAR, "DOUBLE" INTEGER);',
    "-- Explicit filtered relations survive the stock export's missing aggregate filters.",
    `CREATE LOCAL VIEW v AS SELECT CAST('the' AS VARCHAR(3)) AS id, 'DOUBLE' AS kind, 'position' AS role, '"POSITION"(a, b)' AS raw_fn, "POSITION"('|', t.position) AS pipe_pos, t.position, TIMESTAMPDIFF(SECOND, ts, ts) AS d FROM t;`,
  ].join("\n");
  const translated = translateRisingWaveSql(sql);
  assertEquals(translated.includes("CREATE VIEW v"), true);
  assertEquals(translated.includes("amount DOUBLE PRECISION"), true);
  assertEquals(translated.includes('"DOUBLE" INTEGER'), true);
  assertEquals(translated.includes("'DOUBLE' AS kind"), true);
  assertEquals(translated.includes("'position' AS role"), true);
  assertEquals(translated.includes('\'"POSITION"(a, b)\' AS raw_fn'), true);
  assertEquals(translated.includes(`strpos(t."position", '|') AS pipe_pos`), true);
  assertEquals(translated.includes('t."position"'), true);
  assertEquals(translated.includes('""position""'), false);
  assertEquals(translated.includes("TIMESTAMP(6)"), false);
  assertEquals(translated.includes("VARCHAR(3)"), false);
  const crossSql =
    "CREATE VIEW c AS SELECT f.id, p.id AS pid FROM source_filter f CROSS JOIN source_panel p;";
  assertEquals(translateRisingWaveSql(crossSql).includes("chr(1)"), false);
  assertEquals(
    translateRisingWaveSql(crossSql).includes(
      "COALESCE(CHAR_LENGTH(SUBSTRING(CAST(f.id AS VARCHAR) FROM 1 FOR 0)), 0)",
    ),
    true,
  );
});

Deno.test("rows validates schema types and normalizes timestamps", () => {
  assertEquals(
    rows([{ id: 7, at: "2026-10-23 03:10:02.12" }], fields),
    [{ id: 7, at: "2026-10-23T03:10:02.120000Z" }],
  );
});

// Archive-scale RisingWave pipelines stall when a trailing OR team predicate
// leaves StreamHashJoin keyed on phase_id alone; rewrite to composite equi-joins
// while preserving bag multiplicity when home_id = away_id.
Deno.test("translateRisingWaveSql splits disjunctive team joins into composite equi-joins", () => {
  const bagSql = [
    "CREATE LOCAL VIEW scores AS",
    " SELECT m.group_id,m.team_id,g.id",
    " FROM members m JOIN source_game g ON g.phase_id=m.phase_id AND g.played",
    " AND (g.home_id=m.team_id OR g.away_id=m.team_id);",
  ].join("\n");
  const bagOut = translateRisingWaveSql(bagSql);
  assertEquals(bagOut.includes(" OR "), true);
  assertEquals(bagOut.includes("g.home_id=m.team_id OR g.away_id=m.team_id"), false);
  assertEquals(bagOut.includes("ON g.phase_id=m.phase_id AND g.played AND g.home_id=m.team_id UNION ALL SELECT"), true);
  assertEquals(bagOut.includes("ON g.phase_id=m.phase_id AND g.played AND g.away_id=m.team_id AND (g.home_id IS NULL OR g.away_id <> g.home_id);"), true);

  const distinctSql = [
    "CREATE LOCAL VIEW pairs AS",
    " SELECT DISTINCT t.group_id,x.* FROM source_team_group t JOIN live l ON l.group_id=t.group_id",
    " JOIN ranked r ON r.group_id=t.group_id JOIN source_stage_group g ON g.id=t.group_id",
    " JOIN source_game x ON x.phase_id=g.phase_id AND (t.team_id=x.home_id OR t.team_id=x.away_id)",
    " WHERE x.played OR NOT x.withdrawn;",
  ].join("\n");
  const distinctOut = translateRisingWaveSql(distinctSql);
  assertEquals(distinctOut.includes("t.team_id=x.home_id OR t.team_id=x.away_id"), false);
  assertEquals(distinctOut.includes("SELECT DISTINCT"), false);
  assertEquals(distinctOut.includes("ON x.phase_id=g.phase_id AND t.team_id=x.home_id\n WHERE x.played OR NOT x.withdrawn UNION SELECT"), true);
  assertEquals(distinctOut.includes("ON x.phase_id=g.phase_id AND t.team_id=x.away_id AND (x.home_id IS NULL OR x.away_id <> x.home_id)\n WHERE x.played OR NOT x.withdrawn;"), true);

  // Aggregating or outer-join views do not distribute over UNION ALL.
  const aggSql =
    "CREATE LOCAL VIEW totals AS SELECT m.id, COUNT(*) AS n FROM members m JOIN games g ON g.phase=m.phase AND (g.home=m.id OR g.away=m.id) GROUP BY m.id;";
  assertEquals(
    translateRisingWaveSql(aggSql).includes("(g.home=m.id OR g.away=m.id)"),
    true,
  );
  const outerSql =
    "CREATE LOCAL VIEW opt AS SELECT m.id, g.id AS gid FROM members m LEFT JOIN games g ON g.phase=m.phase AND (g.home=m.id OR g.away=m.id);";
  assertEquals(
    translateRisingWaveSql(outerSql).includes("(g.home=m.id OR g.away=m.id)"),
    true,
  );
});

Deno.test("configureRisingWaveStorage enables LZ4 on upper levels and Zstd on bottom levels across compaction groups", async () => {
  const executed: string[] = [];
  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      executed.push(sql);
      if (sql.includes("rw_hummock_compaction_group_configs")) {
        return Promise.resolve({
          rows: [{ id: 2 }, { id: "3" }] as unknown as R[],
        });
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => Promise.resolve(),
  };
  await configureRisingWaveStorage(session);
  assertEquals(executed, [
    "SET bypass_cluster_limits TO true",
    "SELECT id FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id",
    "ALTER COMPACTION GROUP 2, 3 SET compression_algorithm = '0:lz4', compression_algorithm = '1:lz4', compression_algorithm = '2:lz4', compression_algorithm = '3:lz4', compression_algorithm = '4:lz4', compression_algorithm = '5:zstd', compression_algorithm = '6:zstd'",
  ]);
});
