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
  wal?: Record<string, SnapshotTableWal>;
};

export type SnapshotWalEntry = {
  lsn: number;
  op: "I" | "D" | "T";
  row: Record<string, string | null> | null;
};

export type SnapshotTableWal = {
  fromLsn: number;
  targetLsn: number;
  pkColumns: string[];
  columns: { name: string; type: string }[];
  entries: SnapshotWalEntry[];
};

export type SnapshotStatement = {
  create: string;
  insert: string;
  values: [string];
};

export type SnapshotWalStep = {
  sql: string;
  values: string[];
};

export type ReplicaWatermark = {
  colSig: string;
  lsn: number;
  rowSig: string;
};

export type ReplicaTablePlan = {
  mode: "noop" | "wal" | "seed";
  steps: SnapshotWalStep[];
  next: ReplicaWatermark;
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

export function snapshotWalStatements(
  name: string,
  wal: SnapshotTableWal,
  types?: TypeTable,
  schema?: string,
): SnapshotWalStep[] {
  if (
    !Number.isSafeInteger(wal.fromLsn) || wal.fromLsn < 0 ||
    !Number.isSafeInteger(wal.targetLsn) || wal.targetLsn < wal.fromLsn
  ) {
    throw new Error(`invalid snapshot WAL LSN bounds for ${name}`);
  }
  const target = schema ? `${quote(schema)}.${quote(name)}` : quote(name);
  const fenced = wal.entries.filter((entry) =>
    entry.lsn > wal.fromLsn && entry.lsn <= wal.targetLsn
  );
  if (!fenced.length) return [];
  const steps: SnapshotWalStep[] = [];
  let delta = fenced;
  const lastTruncate = fenced.findLastIndex((entry) => entry.op === "T");
  if (lastTruncate >= 0) {
    steps.push({ sql: `DELETE FROM ${target}`, values: [] });
    delta = fenced.slice(lastTruncate + 1);
  }
  if (!delta.length) return steps;
  const rowsToValidate = delta.flatMap((entry) => entry.row ? [entry.row] : []);
  const [base] = snapshotStatements(
    { [name]: { columns: wal.columns, rows: rowsToValidate } },
    [name],
    types,
  );
  const columns = wal.columns.map((column) => ({
    name: column.name,
    quoted: quote(column.name),
    type: physical(column.type, types),
  }));
  const projection = columns.map((column) => {
    const cell = `(value ->> '${column.name}')`;
    const expr = column.type === "BLOB"
      ? `from_hex(substring(${cell}, 3))`
      : `CAST(${cell} AS ${column.type})`;
    return `${expr} AS ${column.quoted}`;
  });
  const pks = wal.pkColumns.map((pk) => {
    const col = columns.find((c) => c.name === pk);
    if (!col) throw new Error(`invalid snapshot WAL primary key ${name}.${pk}`);
    return col;
  });
  if (pks.length > 0) {
    const touched = new Map<string, Record<string, string | null>>();
    const latest = new Map<
      string,
      { op: "I" | "D"; row: Record<string, string | null> }
    >();
    for (const entry of delta) {
      if ((entry.op !== "I" && entry.op !== "D") || !entry.row) {
        throw new Error(`invalid snapshot WAL entry in ${name}`);
      }
      const key = JSON.stringify(pks.map((pk) => entry.row![pk.name]));
      touched.set(
        key,
        Object.fromEntries(pks.map((pk) => [pk.name, entry.row![pk.name]])),
      );
      latest.set(key, { op: entry.op, row: entry.row });
    }
    const pkProjection = pks.map((column) => {
      const cell = `(value ->> '${column.name}')`;
      const expr = column.type === "BLOB"
        ? `from_hex(substring(${cell}, 3))`
        : `CAST(${cell} AS ${column.type})`;
      return `${expr} AS ${column.quoted}`;
    });
    steps.push({
      sql: `DELETE FROM ${target} AS t USING (SELECT ${
        pkProjection.join(", ")
      } FROM json_each(CAST(? AS JSON))) AS d WHERE ${
        pks.map((pk) => `t.${pk.quoted} IS NOT DISTINCT FROM d.${pk.quoted}`)
          .join(" AND ")
      }`,
      values: [JSON.stringify([...touched.values()])],
    });
    const inserts = [...latest.values()]
      .filter((item) => item.op === "I")
      .map((item) => item.row);
    if (inserts.length > 0) {
      steps.push({
        sql: base.insert.replace(`INTO ${quote(name)}`, `INTO ${target}`),
        values: [JSON.stringify(inserts)],
      });
    }
  } else {
    for (const entry of delta) {
      if ((entry.op !== "I" && entry.op !== "D") || !entry.row) {
        throw new Error(`invalid snapshot WAL entry in ${name}`);
      }
      if (entry.op === "D") {
        steps.push({
          sql: `DELETE FROM ${target} WHERE rowid = (SELECT t.rowid FROM ${target} AS t, (SELECT ${
            projection.join(", ")
          } FROM json_each(CAST(? AS JSON))) AS d WHERE ${
            columns.map((c) => `t.${c.quoted} IS NOT DISTINCT FROM d.${c.quoted}`)
              .join(" AND ")
          } LIMIT 1)`,
          values: [JSON.stringify([entry.row])],
        });
      } else {
        steps.push({
          sql: base.insert.replace(`INTO ${quote(name)}`, `INTO ${target}`),
          values: [JSON.stringify([entry.row])],
        });
      }
    }
  }
  return steps;
}

export function planReplicaTable(
  name: string,
  table: SnapshotTable,
  statement: SnapshotStatement,
  tableWal: SnapshotTableWal | undefined,
  types: TypeTable | undefined,
  prior: ReplicaWatermark | undefined,
  schema = "duckpipe_replica",
): ReplicaTablePlan {
  const colSig = JSON.stringify({ cols: table.columns, types: types ?? null });
  const rowSig = statement.values[0];
  if (
    prior && prior.colSig === colSig && tableWal &&
    tableWal.fromLsn === prior.lsn && tableWal.targetLsn >= prior.lsn
  ) {
    return {
      mode: "wal",
      steps: snapshotWalStatements(name, tableWal, types, schema),
      next: { colSig, lsn: tableWal.targetLsn, rowSig },
    };
  }
  if (prior && prior.colSig === colSig && prior.rowSig === rowSig) {
    return {
      mode: "noop",
      steps: [],
      next: { colSig, lsn: tableWal?.targetLsn ?? prior.lsn, rowSig },
    };
  }
  const target = `${quote(schema)}.${quote(name)}`;
  const steps: SnapshotWalStep[] = [
    { sql: `DROP TABLE IF EXISTS ${target}`, values: [] },
    {
      sql: statement.create.replace(
        `CREATE TABLE ${quote(name)}`,
        `CREATE TABLE ${target}`,
      ),
      values: [],
    },
  ];
  const insertSql = statement.insert.replace(
    `INTO ${quote(name)}`,
    `INTO ${target}`,
  );
  for (let offset = 0; offset < table.rows.length; offset += 32) {
    steps.push({
      sql: insertSql,
      values: [JSON.stringify(table.rows.slice(offset, offset + 32))],
    });
  }
  return {
    mode: "seed",
    steps,
    next: { colSig, lsn: tableWal?.targetLsn ?? 0, rowSig },
  };
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
