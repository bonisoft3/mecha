import type { TypeTable } from "../../packages/client/src/types.ts";

export type SnapshotTable = {
  columns: { name: string; type: string }[];
  rows: Record<string, string | null>[];
};

export type Snapshot = {
  id: string;
  name: string;
  version: string;
  revision: number;
  tables: Record<string, SnapshotTable>;
};

export type SnapshotStatement = {
  create: string;
  insert: string;
  values: [string];
};

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (name: string) => {
  if (!identifier.test(name)) {
    throw new Error(`invalid snapshot identifier: ${name}`);
  }
  return `"${name}"`;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function physical(type: string, types?: TypeTable): string {
  const domain = Object.values(types?.types ?? {}).find((entry) =>
    entry.column === "domain" && entry.sql &&
    (type === entry.sql || type === `public.${entry.sql}`)
  );
  if (domain) type = domain.pg;
  const builtins: Record<string, string> = {
    text: "VARCHAR",
    varchar: "VARCHAR",
    bpchar: "VARCHAR",
    tsvector: "VARCHAR",
    boolean: "BOOLEAN",
    bool: "BOOLEAN",
    smallint: "SMALLINT",
    int2: "SMALLINT",
    integer: "INTEGER",
    int4: "INTEGER",
    bigint: "BIGINT",
    int8: "BIGINT",
    real: "FLOAT",
    float4: "FLOAT",
    "double precision": "DOUBLE",
    float8: "DOUBLE",
    uuid: "UUID",
    date: "DATE",
    bytea: "BLOB",
    json: "JSON",
    jsonb: "JSON",
    interval: "INTERVAL",
    timestamp: "TIMESTAMP",
    timestamptz: "TIMESTAMPTZ",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
    time: "TIME",
    "time without time zone": "TIME",
    // An unbounded PostgreSQL numeric has no lossless DuckDB decimal type.
    numeric: "VARCHAR",
    decimal: "VARCHAR",
  };
  if (Object.hasOwn(builtins, type)) return builtins[type];
  if (
    /^(?:character varying|character|varchar|bpchar)(?:\([1-9][0-9]*\))?$/.test(
      type,
    )
  ) return "VARCHAR";
  const temporal = /^(timestamp|time)\(([0-6])\)(?: (with|without) time zone)?$/
    .exec(type);
  if (temporal && !(temporal[1] === "time" && temporal[3] === "with")) {
    return temporal[1] === "time"
      ? "TIME"
      : temporal[3] === "with"
      ? "TIMESTAMPTZ"
      : "TIMESTAMP";
  }
  const decimal = /^(?:numeric|decimal)\(([1-9][0-9]*),([0-9]+)\)$/.exec(type);
  if (
    decimal && Number(decimal[1]) <= 38 &&
    Number(decimal[2]) <= Number(decimal[1])
  ) {
    return `DECIMAL(${Number(decimal[1])},${Number(decimal[2])})`;
  }
  throw new Error(`unsupported snapshot PostgreSQL type: ${type}`);
}

/** JSON holds text cells, so neither host parses an exact number through a JS double. */
export function snapshotStatements(
  tables: unknown,
  reads: readonly string[],
  types?: TypeTable,
): SnapshotStatement[] {
  if (
    !object(tables) ||
    JSON.stringify(Object.keys(tables).sort()) !==
      JSON.stringify([...reads].sort())
  ) {
    throw new Error("snapshot tables differ from declared reads");
  }
  return reads.map((name) => {
    const table = tables[name];
    if (
      !object(table) || !Array.isArray(table.columns) ||
      table.columns.length === 0 || !Array.isArray(table.rows)
    ) {
      throw new Error(`invalid snapshot table: ${name}`);
    }
    const seen = new Set<string>();
    const columns = table.columns.map((column: unknown) => {
      if (
        !object(column) || typeof column.name !== "string" ||
        typeof column.type !== "string" || seen.has(column.name)
      ) {
        throw new Error(`invalid snapshot column in ${name}`);
      }
      seen.add(column.name);
      return {
        name: column.name,
        quoted: quote(column.name),
        type: physical(column.type, types),
      };
    });
    const fields = [...seen].sort().join();
    for (const row of table.rows) {
      if (!object(row) || Object.keys(row).sort().join() !== fields) {
        throw new Error(`snapshot row columns differ in ${name}`);
      }
      for (const column of columns) {
        const value = row[column.name];
        if (value !== null && typeof value !== "string") {
          throw new Error(
            `snapshot cell ${name}.${column.name} must be text or null`,
          );
        }
        if (value === null) continue;
        if (
          column.type === "BLOB" &&
          !/^\\x(?:[0-9a-fA-F]{2})*$/.test(value as string)
        ) {
          throw new Error(
            `snapshot bytea ${name}.${column.name} must use hexadecimal text`,
          );
        }
        if (column.type.startsWith("DECIMAL(")) {
          const scale = Number(column.type.slice(8, -1).split(",")[1]);
          if (
            !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value as string) ||
            ((value as string).split(".")[1]?.length ?? 0) > scale
          ) {
            throw new Error(
              `snapshot decimal ${name}.${column.name} exceeds its scale`,
            );
          }
        }
      }
    }
    const projection = columns.map((column) => {
      const cell = `(value ->> '${column.name}')`;
      return column.type === "BLOB"
        ? `from_hex(substring(${cell}, 3))`
        : `CAST(${cell} AS ${column.type})`;
    });
    return {
      create: `CREATE TABLE ${quote(name)} (${
        columns.map((column) => `${column.quoted} ${column.type}`).join(", ")
      })`,
      insert: `INSERT INTO ${quote(name)} SELECT ${
        projection.join(", ")
      } FROM json_each(CAST(? AS JSON))`,
      values: [JSON.stringify(table.rows)],
    };
  });
}

export function validateSnapshot(value: unknown): asserts value is Snapshot {
  if (
    !object(value) ||
    !["id", "name", "version"].every((key) =>
      typeof value[key] === "string" && value[key].length > 0
    ) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !object(value.tables)
  ) {
    throw new Error("invalid snapshot identity");
  }
}
