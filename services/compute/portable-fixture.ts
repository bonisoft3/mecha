import type { PortableType, TypeCheck, TypeEntry, TypeField, TypeTable } from "../../packages/client/src/types.ts";

const entry = (
  pg: string,
  json: TypeEntry["json"],
  beyond: TypeCheck[] = [],
  extra: Partial<TypeEntry> = {},
): TypeEntry => ({ pg, json, beyond, column: "plain", subset: false, base: [pg], order: "none", ...extra });

// A consumer-supplied test contract; Mecha has no default portable type table.
export const table: TypeTable = {
  aliases: { bigint: "int64" },
  types: {
    string: entry("text", "string", ["scalar-values"]),
    bool: entry("boolean", "boolean"),
    int32: entry("integer", "number", [], { min: -2147483648, max: 2147483647 }),
    int64: entry("bigint", "string", ["int64-range"], { pattern: "^(0|-?[1-9][0-9]*)$" }),
    double: entry("double precision", "number"),
    bytes: entry("bytea", "string", [], { pattern: "^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }),
    uuid: entry("uuid", "string", [], { pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
    timestamp: entry("timestamptz", "string", ["calendar"], {
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$",
    }),
    date: entry("date", "string", ["calendar"], { pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
    time: entry("time", "string", [], { pattern: "^[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}$" }),
    timezone: entry("text", "string", ["tzdb"]),
    duration: entry("interval", "string", ["duration-range"]),
    decimal: entry("numeric(38,6)", "string", ["decimal-profile"]),
    json: entry("json", "value", ["scalar-values", "finite-numbers"]),
    geojson: entry("json", "value", ["scalar-values", "finite-numbers", "ring-closure"]),
  },
};

export const fields: TypeField[] = Object.keys(table.types).map((type) => ({
  name: type === "uuid" ? "id" : `${type}_value`,
  type: type as PortableType,
  ...(type === "decimal" ? { precision: 38, scale: 6 } : {}),
}));

export const row = {
  string_value: "São Paulo 🌎",
  bool_value: true,
  int32_value: -2147483648,
  int64_value: "9223372036854775807",
  double_value: 1.5,
  bytes_value: "AP+AQQ==",
  id: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e",
  timestamp_value: "2026-09-21T11:00:00.123456Z",
  date_value: "0001-01-01",
  time_value: "23:59:59.123456",
  timezone_value: "America/Sao_Paulo",
  duration_value: "PT262923.123456S",
  decimal_value: "12345678901234567890123456789012.123456",
  json_value: { a: [1, "x", null, true] },
  geojson_value: { type: "Polygon", coordinates: [[[-46, -23], [-45, -23], [-45, -22], [-46, -23]]] },
};

export const nativeSql = `SELECT
  'São Paulo 🌎'::VARCHAR AS string_value,
  true AS bool_value,
  (-2147483648)::INTEGER AS int32_value,
  9223372036854775807::BIGINT AS int64_value,
  1.5::DOUBLE AS double_value,
  from_hex('00ff8041') AS bytes_value,
  '${row.id}'::UUID AS id,
  TIMESTAMPTZ '2026-09-21 08:00:00.123456-03' AS timestamp_value,
  DATE '0001-01-01' AS date_value,
  TIME '23:59:59.123456' AS time_value,
  'America/Sao_Paulo' AS timezone_value,
  INTERVAL '3 days 01:02:03.123456' AS duration_value,
  ${row.decimal_value}::DECIMAL(38,6) AS decimal_value,
  '${JSON.stringify(row.json_value)}'::JSON AS json_value,
  '${JSON.stringify(row.geojson_value)}'::JSON AS geojson_value`;
