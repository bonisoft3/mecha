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

Deno.test("RisingWave portable carriers preserve canonical replay validation for all 15 types and refuse lossy carriers", async () => {
  const file = await Deno.makeTempFile({ suffix: ".js" });
  try {
    await Deno.writeTextFile(file, `
      export const reads = [];
      export const queries = { q: "SELECT * FROM source" };
      export const plan = () => [];
      export const finish = (inputs) => ({ sink: inputs.q });
    `);
    const computation = await Computation.load({
      name: "portable_carrier", file, to: ["sink"], wasm: [], types: table,
      queryTypes: { q: fields },
      sinkTypes: { sink: fields },
    }, {} as Runner);
    const rwFields = fields.map((field) => ({
      name: field.name,
      type: field.type === "bool"
        ? "BOOLEAN"
        : field.type === "int32"
        ? "INTEGER"
        : field.type === "int64"
        ? "BIGINT"
        : field.type === "double"
        ? "DOUBLE"
        : field.type === "timestamp"
        ? "TIMESTAMP"
        : "VARCHAR",
    }));
    const cols = rwFields.map((f) => `${f.name} ${f.type}`).join(", ");
    const descriptor = {
      sql: `CREATE TABLE source(${cols}); CREATE MATERIALIZED VIEW q AS SELECT * FROM source;`,
      inputs: { source: { query: "SELECT * FROM source", fields: rwFields } },
      outputs: { q: { view: "q", fields: rwFields } },
    };
    const carrierRow = {
      string_value: row.string_value,
      bool_value: row.bool_value,
      int32_value: row.int32_value,
      int64_value: "9223372036854775807",
      double_value: row.double_value,
      bytes_value: "\\x00ff8041",
      id: row.id.toUpperCase(),
      timestamp_value: "2026-09-21 11:00:00.123456",
      date_value: row.date_value,
      time_value: row.time_value,
      timezone_value: row.timezone_value,
      duration_value: "73:02:03.123456",
      decimal_value: `${row.decimal_value}00`,
      json_value: JSON.stringify(row.json_value),
      geojson_value: JSON.stringify(row.geojson_value),
    };
    const rw = computation.risingwave(
      "http://localhost:4566",
      descriptor,
      () =>
        Promise.resolve({
          query: <R>(sql: string) =>
            Promise.resolve({
              rows: (sql.startsWith("SELECT * FROM") ? [carrierRow] : []) as R[],
            }),
          end: () => Promise.resolve(),
        }),
    );
    const captured = await rw.capture({
      query: () => Promise.resolve([carrierRow]),
    });
    assertEquals(captured, { q: [row] });
    assertEquals(await computation.calculate(captured), { sink: [row] });
    assertEquals(
      computation.normalizeRisingWaveInputs({ q: [carrierRow] }, descriptor),
      { q: [row] },
    );

    const nullCarrierRow = Object.fromEntries(
      fields.map((f) => [f.name, f.name === "id" ? row.id : null]),
    );
    const nullCanonicalRow = Object.fromEntries(
      fields.map((f) => [f.name, f.name === "id" ? row.id : null]),
    );
    assertEquals(
      computation.normalizeRisingWaveInputs(
        { q: [nullCarrierRow] },
        descriptor,
      ),
      { q: [nullCanonicalRow] },
    );
    assertEquals(
      await computation.calculate({ q: [nullCanonicalRow] }),
      { sink: [nullCanonicalRow] },
    );
    const requiredComp = await Computation.load({
      name: "portable_required",
      file,
      to: ["sink"],
      wasm: [],
      types: table,
      queryTypes: {
        q: fields.map((f) => f.name === "id" ? { ...f, required: true } : f),
      },
      sinkTypes: { sink: fields },
    }, {} as Runner);
    assertThrows(
      () =>
        requiredComp.normalizeRisingWaveInputs(
          { q: [{ ...carrierRow, id: null }] },
          descriptor,
        ),
      Error,
      "required",
    );

    const boundaryCarrierRow = {
      ...carrierRow,
      int64_value: "-9223372036854775808",
      double_value: -0,
      bytes_value: "\\x",
      timestamp_value: "2026-09-21 11:00:00",
    };
    const normalizedBoundary = computation.normalizeRisingWaveInputs(
      { q: [boundaryCarrierRow] },
      descriptor,
    ).q[0];
    assertEquals(normalizedBoundary.int64_value, "-9223372036854775808");
    assertEquals(Object.is(normalizedBoundary.double_value, 0), true);
    assertEquals(normalizedBoundary.bytes_value, "");
    assertEquals(
      normalizedBoundary.timestamp_value,
      "2026-09-21T11:00:00.000000Z",
    );

    for (
      const bad of [
        { ...carrierRow, int64_value: "9223372036854775808" },
        { ...carrierRow, double_value: Number.NaN },
        {
          ...carrierRow,
          geojson_value: JSON.stringify({
            type: "Polygon",
            coordinates: [[[0, 0], [1, 0], [1, 1]]],
          }),
        },
      ]
    ) {
      assertThrows(
        () => computation.normalizeRisingWaveInputs({ q: [bad] }, descriptor),
        Error,
      );
    }

    await assertRejects(
      () => computation.calculate({ q: [{ ...row, id: row.id.toUpperCase() }] }),
      Error,
      "not canonical",
    );
    assertThrows(
      () =>
        computation.risingwave("http://localhost:4566", {
          ...descriptor,
          outputs: {
            q: {
              view: "q",
              fields: rwFields.map((f) =>
                f.name === "id" ? { ...f, type: "BIGINT" } : f
              ),
            },
          },
        }),
      Error,
      "cannot use BIGINT carrier for uuid",
    );
    assertThrows(
      () =>
        computation.risingwave("http://localhost:4566", {
          ...descriptor,
          outputs: {
            q: {
              view: "q",
              fields: rwFields.map((f) =>
                f.name === "int64_value" ? { ...f, type: "DOUBLE" } : f
              ),
            },
          },
        }),
      Error,
      "cannot use DOUBLE carrier for int64",
    );
    assertThrows(
      () =>
        computation.risingwave("http://localhost:4566", {
          ...descriptor,
          outputs: {
            q: {
              view: "q",
              fields: rwFields.map((f) =>
                f.name === "decimal_value" ? { ...f, type: "DOUBLE" } : f
              ),
            },
          },
        }),
      Error,
      "cannot use DOUBLE carrier for decimal",
    );
    assertThrows(
      () =>
        computation.risingwave("http://localhost:4566", {
          ...descriptor,
          outputs: { q: { view: "q", fields: [] } },
        }),
      Error,
      "columns differ",
    );
  } finally {
    await Deno.remove(file);
  }
});
