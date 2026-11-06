import { bindBoundary, type PortableType, typedSql, type TypeBoundary } from "./portable-contract.ts";
export { bindBoundary, postgresRows, validateSchemas, type TypeBoundary, type TypeSchemas } from "./portable-contract.ts";
import { type DuckDBConnection, DuckDBTypeId as SQL, type DuckDBValueConverter } from "@duckdb/node-api";

type Row = Record<string, unknown>;

const INTEGERS = [
  SQL.TINYINT,
  SQL.SMALLINT,
  SQL.INTEGER,
  SQL.BIGINT,
  SQL.HUGEINT,
  SQL.UTINYINT,
  SQL.USMALLINT,
  SQL.UINTEGER,
  SQL.UBIGINT,
  SQL.UHUGEINT,
];
const PHYSICAL: Record<PortableType, readonly SQL[]> = {
  string: [SQL.VARCHAR, SQL.ENUM],
  bool: [SQL.BOOLEAN],
  int32: INTEGERS,
  int64: [...INTEGERS, SQL.VARCHAR],
  double: [SQL.FLOAT, SQL.DOUBLE],
  bytes: [SQL.BLOB],
  uuid: [SQL.UUID, SQL.VARCHAR],
  timestamp: [SQL.TIMESTAMP, SQL.TIMESTAMP_TZ, SQL.TIMESTAMP_S, SQL.TIMESTAMP_MS, SQL.TIMESTAMP_NS],
  date: [SQL.DATE],
  time: [SQL.TIME, SQL.TIME_NS],
  timezone: [SQL.VARCHAR],
  duration: [SQL.INTERVAL],
  decimal: [...INTEGERS, SQL.DECIMAL, SQL.VARCHAR],
  json: [SQL.VARCHAR],
  geojson: [SQL.VARCHAR],
};

export async function portableQuery(
  con: DuckDBConnection,
  sql: string,
  boundary: TypeBoundary,
  converter: DuckDBValueConverter<unknown>,
): Promise<Row[]> {
  const held = bindBoundary(boundary);
  // Check before projection hides physical types or a converter can round a decimal.
  const prepared = await con.prepare(sql);
  try {
    const names = Array.from({ length: prepared.columnCount }, (_, index) => prepared.columnName(index));
    held.columns(names);
    for (const field of boundary.fields) {
      const physical = prepared.columnTypeId(names.indexOf(field.name));
      if (physical !== SQL.SQLNULL && !PHYSICAL[field.type as PortableType].includes(physical)) {
        throw new Error(
          `portable field ${field.name}: ${SQL[physical]} requires an explicit SQL cast for ${field.type}`,
        );
      }
    }
  } finally {
    prepared.destroySync();
  }
  const result = await con.runAndReadAll(typedSql(held.bound.canonicalType, sql, boundary.fields));
  held.columns(result.columnNames());
  return held.rows(result.convertRowObjects(converter) as Row[], "duckdb");
}
