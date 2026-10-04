import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as duckdb from "@duckdb/duckdb-wasm/blocking"
import { typedSql } from "./lake-types.js"

// What a projection must be is decided by the type a column is, so these
// fields name types directly and the mapping is the identity. Whether a
// projected value then canonicalizes correctly is a question about the type
// table, which this package does not hold: a consumer asks it, against the
// table it was emitted with.
const asWritten = (type: string) => type

describe("typed lake portable types", () => {
  const fields = [
    { name: "amount", type: "decimal" as const, precision: 8, scale: 2 },
    { name: "day", type: "date" as const },
    { name: "elapsed", type: "duration" as const },
    { name: "stamp", type: "timestamp" as const },
    { name: "payload", type: "bytes" as const },
    { name: "meta", type: "json" as const },
  ]

  it("projects lossy Arrow values before they leave DuckDB", () => {
    const sql = typedSql(asWritten, "SELECT * FROM readings", fields)
    expect(sql).toContain('CAST("amount" AS VARCHAR) AS "amount"')
    expect(sql).toContain("strftime(\"day\", '%Y-%m-%d')")
    expect(sql).toContain("CASE typeof(\"stamp\") WHEN 'TIMESTAMP_NS' THEN CASE WHEN epoch_ns(\"stamp\") % 1000 <> 0 THEN error('timestamp exceeds microsecond precision') ELSE strftime(\"stamp\", '%Y-%m-%dT%H:%M:%S.%fZ') END WHEN 'TIMESTAMP WITH TIME ZONE' THEN strftime(\"stamp\" AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') ELSE strftime(\"stamp\", '%Y-%m-%dT%H:%M:%S.%fZ') END")
    expect(sql).toContain('base64("payload") AS "payload"')
  })

  it("keeps an all-type fixture at the lake boundary", () => {
    const allFields = [
      { name: "text", type: "string" as const },
      { name: "enabled", type: "bool" as const },
      { name: "count", type: "int32" as const },
      { name: "sequence", type: "int64" as const },
      { name: "ratio", type: "double" as const },
      { name: "blob", type: "bytes" as const },
      { name: "id", type: "uuid" as const },
      { name: "stamp", type: "timestamp" as const },
      { name: "day", type: "date" as const },
      { name: "clock", type: "time" as const },
      { name: "zone", type: "timezone" as const },
      { name: "elapsed", type: "duration" as const },
      { name: "amount", type: "decimal" as const, precision: 8, scale: 2 },
      { name: "meta", type: "json" as const },
      { name: "shape", type: "geojson" as const },
    ]
    const sql = typedSql(asWritten, "SELECT * FROM portable_fixture", allFields)
    expect(sql).toContain('CAST("sequence" AS VARCHAR) AS "sequence"')
    expect(sql).toContain('CAST("meta" AS VARCHAR) AS "meta"')
    expect(sql).toContain('CAST("shape" AS VARCHAR) AS "shape"')
  })

  it("projects actual Arrow bigint and decimal values before JavaScript loses them", async () => {
    const wasm = fileURLToPath(new URL("../../../../../node_modules/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm", import.meta.url))
    const db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: "" } }, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME)
    await db.instantiate(() => {})
    db.open({ path: ":memory:" })
    const conn = db.connect()
    try {
      const source = "SELECT 9007199254740993::BIGINT AS sequence, 123.4500::DECIMAL(10,4) AS amount"
      const raw = conn.query(source).toArray()[0].toJSON()
      expect(typeof raw.sequence).toBe("bigint")
      expect(raw.amount).not.toBe("123.45")
      const fields = [{ name: "sequence", type: "int64" as const }, { name: "amount", type: "decimal" as const, precision: 10, scale: 4 }]
      const projected = conn.query(typedSql(asWritten, source, fields)).toArray()[0].toJSON()
      expect(projected).toEqual({ sequence: "9007199254740993", amount: "123.4500" })
    } finally {
      conn.close()
    }
  })

  it("converts actual DuckDB intervals from integer microseconds", async () => {
    const wasm = fileURLToPath(new URL("../../../../../node_modules/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm", import.meta.url))
    const db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: "" } }, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME)
    await db.instantiate(() => {})
    db.open({ path: ":memory:" })
    const conn = db.connect()
    try {
      const fields = [{ name: "elapsed", type: "duration" as const }]
      for (const [source, expected] of [
        ["SELECT INTERVAL '3 days 01:02:03.123456' AS elapsed", "PT262923.123456S"],
        ["SELECT INTERVAL '3652500 days' AS elapsed", "PT315576000000S"],
      ]) {
        const projected = conn.query(typedSql(asWritten, source, fields)).toArray()[0].toJSON()
        expect(projected).toEqual({ elapsed: expected })
      }
      expect(() => conn.query(typedSql(asWritten, "SELECT INTERVAL '1 month' AS elapsed", fields))).toThrow()
    } finally {
      conn.close()
    }
  })

  // A string, bool, int32, double, uuid, date or timezone column is its
  // Postgres base type rather than a domain, so the lake reads it as DuckDB's
  // native type instead of VARCHAR. Arrow carries each of those without loss,
  // and a date is projected to its day.
  it("reads native base-typed columns in their canonical JSON kind", async () => {
    const wasm = fileURLToPath(new URL("../../../../../node_modules/@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm", import.meta.url))
    const db = await duckdb.createDuckDB({ mvp: { mainModule: wasm, mainWorker: "" } }, new duckdb.ConsoleLogger(), duckdb.NODE_RUNTIME)
    await db.instantiate(() => {})
    db.open({ path: ":memory:" })
    const conn = db.connect()
    try {
      const source = "SELECT 'x'::VARCHAR AS text, true AS enabled, (-2147483648)::INTEGER AS count, 1.5::DOUBLE AS ratio, " +
        "'8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e'::UUID AS id, DATE '0001-01-01' AS day, 'America/Sao_Paulo'::VARCHAR AS zone"
      const fields = [
        { name: "text", type: "string" as const },
        { name: "enabled", type: "bool" as const },
        { name: "count", type: "int32" as const },
        { name: "ratio", type: "double" as const },
        { name: "id", type: "uuid" as const },
        { name: "day", type: "date" as const },
        { name: "zone", type: "timezone" as const },
      ]
      const projected = conn.query(typedSql(asWritten, source, fields)).toArray()[0].toJSON()
      expect(projected).toEqual({
        text: "x", enabled: true, count: -2147483648, ratio: 1.5,
        id: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e", day: "0001-01-01", zone: "America/Sao_Paulo",
      })
    } finally {
      conn.close()
    }
  })
})
