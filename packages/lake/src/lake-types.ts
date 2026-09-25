import type { TypeField, Types, CarrierField, Carriers } from "@mecha/client/types"

function quoted(name: string): string {
  if (name.length === 0) throw new Error("a typed lake field has no name")
  return `"${name.replaceAll('"', '""')}"`
}

function durationProjection(column: string): string {
  const micros = `epoch_us(${column})`
  return `CASE WHEN ${column} IS NULL THEN NULL WHEN date_part('year', ${column}) <> 0 OR date_part('month', ${column}) <> 0 THEN error('duration cannot contain calendar months or years') WHEN ${micros} < 0 THEN error('duration cannot be negative') ELSE concat('PT', CAST(${micros} // 1000000 AS VARCHAR), CASE WHEN ${micros} % 1000000 = 0 THEN '' ELSE concat('.', rtrim(lpad(CAST(${micros} % 1000000 AS VARCHAR), 6, '0'), '0')) END, 'S') END AS ${column}`
}

/**
 * Projects type columns before Arrow constructs JavaScript values. Arrow's
 * Date conversion drops precision, and its int64 conversion is not portable;
 * keeping these exact strings makes the row adapter a validation step rather
 * than a lossy reconstruction.
 */
function projection(canonicalType: (type: string) => string, field: TypeField | CarrierField): string | undefined {
  const column = quoted(field.name)
  switch (canonicalType(field.type)) {
    case "int64":
    case "decimal":
    case "json":
    case "geojson":
      return `CAST(${column} AS VARCHAR) AS ${column}`
    case "duration":
      return durationProjection(column)
    case "bytes":
      return `base64(${column}) AS ${column}`
    case "timestamp":
      return `CASE typeof(${column}) WHEN 'TIMESTAMP_NS' THEN CASE WHEN epoch_ns(${column}) % 1000 <> 0 THEN error('timestamp exceeds microsecond precision') ELSE strftime(${column}, '%Y-%m-%dT%H:%M:%S.%fZ') END WHEN 'TIMESTAMP WITH TIME ZONE' THEN strftime(${column} AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%fZ') ELSE strftime(${column}, '%Y-%m-%dT%H:%M:%S.%fZ') END AS ${column}`
    case "date":
      return `strftime(${column}, '%Y-%m-%d') AS ${column}`
    case "time":
      return `CAST(${column} AS VARCHAR) AS ${column}`
    default:
      return undefined
  }
}

/**
 * Wrap SQL so type columns cross Arrow in a lossless representation. Takes
 * the type mapping rather than a bound table: a projection is decided by which
 * type a column is and by nothing else the table says.
 */
export function typedSql(canonicalType: (type: string) => string, sql: string, fields: readonly (TypeField | CarrierField)[]): string {
  const replacements = fields.map((field) => projection(canonicalType, field)).filter((value): value is string => value !== undefined)
  if (replacements.length === 0) return sql
  return `SELECT * REPLACE (${replacements.join(", ")}) FROM (${sql}) AS "_mecha_typed"`
}

/** Applies the row-level type boundary after typedSql has avoided Arrow loss. */
export function normalizeLakeRows(types: Types | Carriers, fields: readonly (TypeField | CarrierField)[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => types.normalizeRow(fields, row, "duckdb"))
}
