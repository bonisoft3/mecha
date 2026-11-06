import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Computation, duckdb, readerOf } from "./main.ts";
import { bindBoundary, postgresRows, validateSchemas } from "./portable.ts";
import { fields, nativeSql, row, table } from "./portable-fixture.ts";
import { Runner } from "./workers.ts";

Deno.test("native typed queries retain every portable type and leave legacy numeric inputs unchanged", async () => {
  const db = await duckdb();
  const con = await db.connect();
  try {
    const reader = readerOf(con);
    assertEquals(await reader.query(nativeSql, { fields, types: table }), [row]);
    assertEquals(await reader.query("SELECT 42::BIGINT AS count, 1.25::DECIMAL(6,2) AS amount"), [{
      count: 42,
      amount: 1.25,
    }]);
    await assertRejects(
      () => reader.query("SELECT 9223372036854775807::BIGINT AS count"),
      RangeError,
      "exact integers",
    );
    const nullable = `SELECT ${
      fields.map((field) => `CASE WHEN false THEN "${field.name}" ELSE NULL END AS "${field.name}"`).join(", ")
    } FROM (${nativeSql})`;
    assertEquals(await reader.query(nullable, { fields, types: table }), [
      Object.fromEntries(fields.map(({ name }) => [name, null])),
    ]);
  } finally {
    con.closeSync();
    db.closeSync();
  }
});

Deno.test("typed boundaries reject incomplete schemas even when a query returns no rows", async () => {
  const db = await duckdb();
  const con = await db.connect();
  try {
    const reader = readerOf(con);
    const boundary = { fields: [{ name: "id", type: "int32" as const }], types: table };
    await assertRejects(
      () => reader.query("SELECT 1 AS id, 2 AS extra WHERE false", boundary),
      Error,
      "columns differ",
    );
    await assertRejects(() => reader.query("SELECT 1 AS missing WHERE false", boundary), Error);
    await assertRejects(
      () =>
        reader.query("SELECT NULL::INT AS id", { ...boundary, fields: [{ ...boundary.fields[0], required: true }] }),
      Error,
      "required",
    );
    assertThrows(
      () => bindBoundary({ ...boundary, fields: [{ name: "id", type: "bigint" }] }),
      Error,
      "canonical type",
    );
    assertThrows(
      () => bindBoundary({ ...boundary, fields: [boundary.fields[0], boundary.fields[0]] }),
      Error,
      "unique",
    );
    assertThrows(() => bindBoundary({ ...boundary, fields: [{ name: "id", type: "decimal" }] }), Error, "precision");
    assertThrows(() => validateSchemas(undefined, { q: boundary.fields }, ["q"]), Error, "type table");
    assertThrows(() => validateSchemas(table, { other: boundary.fields }, ["q"]), Error, "undeclared");
    assertThrows(() => validateSchemas(table, {}, ["sink"], true), Error, "omit");
  } finally {
    con.closeSync();
    db.closeSync();
  }
});

Deno.test("typed queries refuse precision loss, invalid JSON numbers, and nonportable values", async () => {
  const db = await duckdb();
  const con = await db.connect();
  try {
    const reader = readerOf(con);
    for (
      const [type, expression] of [
        ["timestamp", "TIMESTAMP_NS '2026-01-01 00:00:00.123456789'"],
      ["time", "CAST('23:59:59.123456789' AS TIME_NS)"],
        ["duration", "INTERVAL '1 month'"],
        ["duration", "INTERVAL '-1 microsecond'"],
        ["int64", "9223372036854775808::HUGEINT"],
        ["double", "'Infinity'::DOUBLE"],
        ["json", `'{"integer":9007199254740993}'::JSON`],
        ["geojson", `'{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[2,2]]]}'::JSON`],
      ] as const
    ) {
      await assertRejects(() =>
        reader.query(`SELECT ${expression} AS value`, { fields: [{ name: "value", type }], types: table })
      );
    }
    await assertRejects(
      () =>
        reader.query("SELECT 1.234::DECIMAL(4,3) AS value", {
          fields: [{ name: "value", type: "decimal", precision: 4, scale: 2 }],
          types: table,
        }),
      Error,
      "scale",
    );
  } finally {
    con.closeSync();
    db.closeSync();
  }
});

Deno.test("typed queries reject inexact physical types before conversion, including empty results", async () => {
  const db = await duckdb();
  const con = await db.connect();
  try {
    const reader = readerOf(con);
    for (const where of ["", " WHERE false"]) {
      for (
        const [type, expression] of [
          ["int32", "42.00000000000000000001::DECIMAL(22,20)"],
          ["int64", "9007199254740993::DOUBLE"],
          ["decimal", "1.2345678901234567::DOUBLE"],
          ["double", "42.00000000000000000001::DECIMAL(22,20)"],
        ] as const
      ) {
        await assertRejects(
          () =>
            reader.query(`SELECT ${expression} AS value${where}`, {
              fields: [{ name: "value", type, ...(type === "decimal" ? { precision: 38, scale: 20 } : {}) }],
              types: table,
            }),
          Error,
          "explicit SQL cast",
        );
      }
    }
    assertEquals(
      await reader.query("SELECT CAST(1.25::DECIMAL(3,2) AS DOUBLE) AS value", {
        fields: [{ name: "value", type: "double" }],
        types: table,
      }),
      [{ value: 1.25 }],
    );
  } finally {
    con.closeSync();
    db.closeSync();
  }
});

Deno.test("typed publication prepares bytea input without changing retained canonical output", () => {
  assertEquals(postgresRows({ fields, types: table }, [row]), [{ ...row, bytes_value: "\\x00ff8041" }]);
  assertEquals(row.bytes_value, "AP+AQQ==");
  assertThrows(() => postgresRows({ fields, types: table }, [{ ...row, extra: 1 }]), Error, "columns differ");
  assertThrows(
    () => postgresRows({ fields: [{ name: "id", type: "uuid", required: true }], types: table }, [{ id: null }]),
    Error,
    "required",
  );
});

Deno.test("a computation declares portable query inputs explicitly and validates retained input on replay", async () => {
  const file = await Deno.makeTempFile({ suffix: ".js" });
  const db = await duckdb();
  const con = await db.connect();
  try {
    await Deno.writeTextFile(
      file,
      `
      export const reads = [];
      export const queries = { q: ${JSON.stringify(nativeSql)} };
      export const plan = () => [];
      export const finish = (inputs) => ({ sink: inputs.q });
    `,
    );
    const spec = {
      name: "portable",
      file,
      to: ["sink"],
      wasm: [],
      types: table,
      queryTypes: { q: fields },
      sinkTypes: { sink: fields },
    };
    const computation = await Computation.load(spec, {} as Runner);
    const captured = await computation.capture(readerOf(con));
    assertEquals(await computation.calculate(captured), { sink: [row] });
    await assertRejects(
      () => computation.calculate({ q: [{ ...row, int64_value: "9223372036854775808" }] }),
      Error,
      "64-bit",
    );
    await assertRejects(() => computation.calculate({ q: [{ ...row, int64_value: 42 }] }), Error, "not canonical");
    await assertRejects(
      () => Computation.load({ ...spec, queryTypes: { other: fields } }, {} as Runner),
      Error,
      "undeclared",
    );
    await assertRejects(() => Computation.load({ ...spec, sinkTypes: {} }, {} as Runner), Error, "omit");
  } finally {
    con.closeSync();
    db.closeSync();
    await Deno.remove(file);
  }
});

Deno.test("Feldera UUID carriers preserve canonical replay validation and refuse lossy typed carriers", async () => {
  const file = await Deno.makeTempFile({ suffix: ".js" });
  try {
    await Deno.writeTextFile(file, `
      export const reads = [];
      export const queries = { ids: "SELECT id FROM teams" };
      export const plan = () => [];
      export const finish = (inputs) => ({ sink: inputs.ids });
    `);
    const computation = await Computation.load({
      name: "uuid_carrier", file, to: ["sink"], wasm: [], types: table,
      queryTypes: { ids: [{ name: "id", type: "uuid", required: true }] },
    }, {} as Runner);
    const descriptor = {
      sql: "CREATE TABLE teams(id VARCHAR); CREATE MATERIALIZED VIEW ids AS SELECT id FROM teams;",
      inputs: { teams: { query: "SELECT id FROM teams", fields: [{ name: "id", type: "VARCHAR" }] } },
      outputs: { ids: { view: "ids", fields: [{ name: "id", type: "VARCHAR" }] } },
    };
    computation.feldera("http://localhost:8080", descriptor);
    const id = "12345678-1234-4234-8234-123456789abc";
    assertEquals(await computation.calculate({ ids: [{ id }] }), { sink: [{ id }] });
    await assertRejects(() => computation.calculate({ ids: [{ id: "invalid" }] }), Error);
    await assertRejects(() => computation.calculate({ ids: [{ id: id.toUpperCase() }] }), Error, "not canonical");
    assertThrows(() => computation.feldera("http://localhost:8080", {
      ...descriptor, outputs: { ids: { view: "ids", fields: [{ name: "id", type: "BIGINT" }] } },
    }), Error, "UUID string carrier");
    assertThrows(() => computation.feldera("http://localhost:8080", {
      ...descriptor, outputs: { ids: { view: "ids", fields: [] } },
    }), Error, "columns differ");
    const integer = await Computation.load({
      name: "integer_carrier", file, to: ["sink"], wasm: [], types: table,
      queryTypes: { ids: [{ name: "id", type: "int64" }] },
    }, {} as Runner);
    assertThrows(() => integer.feldera("http://localhost:8080", descriptor), Error, "UUID string carrier");
  } finally {
    await Deno.remove(file);
  }
});
