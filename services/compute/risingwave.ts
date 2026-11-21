import pg from "npm:pg@8.16.3";
import type { Reader, Row } from "./main.ts";

export type RisingWaveField = { name: string; type: string };
export type RisingWaveProgram = {
  sql: string;
  inputs: Record<string, { query: string; fields: RisingWaveField[] }>;
  outputs: Record<string, { view: string; fields: RisingWaveField[] }>;
};

export interface RisingWaveSqlSession {
  on?(event: "error", listener: (error: Error) => void): unknown;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

export type RisingWaveConnect = (
  connectionString: string,
) => Promise<RisingWaveSqlSession>;

const identifier = /^[a-z_][a-z0-9_]*$/;
const types = new Set([
  "BOOLEAN",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "DOUBLE",
  "VARCHAR",
  "TIMESTAMP",
]);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`RisingWave: ${message}`);
}

function validateFields(fields: RisingWaveField[]) {
  require(
    Array.isArray(fields) && fields.length > 0,
    "fields must be a nonempty array",
  );
  const names = new Set<string>();
  for (const field of fields) {
    require(
      object(field) && identifier.test(field.name) && !names.has(field.name),
      "invalid or duplicate field",
    );
    require(types.has(field.type), `unsupported type ${field.type}`);
    names.add(field.name);
  }
}

function timestamp(value: unknown): string {
  require(typeof value === "string", "timestamp must be text");
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/
    .exec(value);
  require(
    match && match[1].slice(0, 4) !== "0000",
    `invalid UTC microsecond timestamp ${value}`,
  );
  const prefix = `${match[1]}T${match[2]}`;
  const date = new Date(`${prefix}Z`);
  require(
    Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 19) === prefix,
    `invalid timestamp ${value}`,
  );
  return `${prefix}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

export function rows(
  values: unknown,
  schema: RisingWaveField[],
  allowBigIntString = false,
): Row[] {
  require(Array.isArray(values), "query did not return rows");
  return values.map((row) => {
    require(
      object(row) && Object.keys(row).length === schema.length,
      "row fields differ from descriptor",
    );
    return Object.fromEntries(schema.map(({ name, type }) => {
      require(Object.hasOwn(row, name), `row lacks ${name}`);
      const value = row[name];
      if (value === null) return [name, null];
      switch (type) {
        case "VARCHAR":
          require(typeof value === "string", `${name} must be a string`);
          break;
        case "BOOLEAN":
          require(typeof value === "boolean", `${name} must be a boolean`);
          break;
        case "TIMESTAMP":
          return [name, timestamp(value)];
        case "DOUBLE":
          require(
            typeof value === "number" && Number.isFinite(value),
            `${name} must be finite`,
          );
          break;
        default:
          if (
            type === "BIGINT" && allowBigIntString && typeof value === "string"
          ) {
            require(/^-?\d+$/.test(value), `${name} must be a 64-bit integer`);
            const n = BigInt(value);
            require(
              n >= -9223372036854775808n && n <= 9223372036854775807n,
              `${name} exceeds BIGINT`,
            );
            const num = Number(value);
            return [
              name,
              Number.isSafeInteger(num) && String(num) === value ? num : value,
            ];
          }
          require(
            typeof value === "number" && Number.isSafeInteger(value),
            `${name} must be an exact safe integer`,
          );
          if (type === "SMALLINT") {
            require(
              value >= -32768 && value <= 32767,
              `${name} exceeds SMALLINT`,
            );
          }
          if (type === "INTEGER") {
            require(
              value >= -2147483648 && value <= 2147483647,
              `${name} exceeds INTEGER`,
            );
          }
      }
      return [name, value];
    }));
  });
}

function replacePositionCalls(sql: string): string {
  const token = '"POSITION"(';
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const start = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += sql.slice(start, i);
      continue;
    }
    if (sql[i] === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i++] === "'") break;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (!sql.startsWith(token, i)) {
      if (sql[i] === '"') {
        const start = i++;
        while (i < sql.length) {
          if (sql[i] === '"' && sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          if (sql[i++] === '"') break;
        }
        out += sql.slice(start, i);
        continue;
      }
      out += sql[i++];
      continue;
    }
    let pos = i + token.length;
    let depth = 1;
    let quote: "'" | '"' | null = null;
    let inComment = false;
    let commaPos = -1;
    while (pos < sql.length && depth > 0) {
      const ch = sql[pos];
      if (inComment) {
        if (ch === "\n") inComment = false;
      } else if (quote) {
        if (ch === quote && sql[pos + 1] === quote) {
          pos += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else {
        if (ch === "-" && sql[pos + 1] === "-") {
          inComment = true;
          pos += 2;
          continue;
        }
        if (ch === "'" || ch === '"') quote = ch;
        else if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        } else if (ch === "," && depth === 1 && commaPos === -1) {
          commaPos = pos;
        }
      }
      pos++;
    }
    const arg1 = replacePositionCalls(sql.slice(i + token.length, commaPos).trim());
    const arg2 = replacePositionCalls(sql.slice(commaPos + 1, pos).trim());
    out += `strpos(${arg2}, ${arg1})`;
    i = pos + 1;
  }
  return out;
}

function mapUnquotedSql(sql: string, transform: (chunk: string) => string): string {
  let out = "";
  let i = 0;
  let plainStart = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      if (i > plainStart) out += transform(sql.slice(plainStart, i));
      const quote = ch;
      const quoteStart = i++;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) break;
      }
      out += sql.slice(quoteStart, i);
      plainStart = i;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      if (i > plainStart) out += transform(sql.slice(plainStart, i));
      const commentStart = i;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += sql.slice(commentStart, i);
      plainStart = i;
      continue;
    }
    i++;
  }
  if (plainStart < sql.length) out += transform(sql.slice(plainStart));
  return out;
}

const zeroKey = (expr: string) =>
  `COALESCE(CHAR_LENGTH(SUBSTRING(CAST(${expr} AS VARCHAR) FROM 1 FOR 0)), 0)`;

// RisingWave hashes only equi-join keys; a trailing disjunctive team match
// otherwise materializes every (phase, team, game) pair before filtering.
function rewriteDisjunctiveEquiJoinStatement(stmt: string): string {
  const head =
    /^(\s*CREATE\s+VIEW\s+[a-zA-Z_][a-zA-Z0-9_]*\s+AS\s+)SELECT\s+(DISTINCT\s+)?([\s\S]*)$/i
      .exec(stmt);
  if (!head) return stmt;
  const [, prefix, distinctKw, body] = head;
  if (
    /\b(?:LEFT|RIGHT|FULL|CROSS|ASOF|NATURAL)\s+(?:OUTER\s+)?JOIN\b/i.test(
      body,
    ) ||
    /\b(?:GROUP\s+BY|HAVING|WINDOW|ORDER\s+BY|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT)\b/i
      .test(body) ||
    /\bOVER\s*\(|\(\s*SELECT\b/i.test(body) ||
    /\b(?:COUNT|SUM|AVG|MIN|MAX|BOOL_AND|BOOL_OR|EVERY|STRING_AGG|ARRAY_AGG|JSON_AGG|JSONB_AGG|BIT_AND|BIT_OR|STDDEV\w*|VAR_\w*|VARIANCE)\s*\(/i
      .test(body)
  ) {
    return stmt;
  }
  const fromHead = /\bFROM\s+([\s\S]*?)(?:\bJOIN\b|\bWHERE\b|$)/i.exec(body);
  if (!fromHead || fromHead[1].includes(",")) return stmt;
  const joinMatch =
    /\bJOIN\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ON\s+((?:(?!\b(?:JOIN|WHERE|GROUP|HAVING|ORDER|UNION)\b)[\s\S])+?)\s+AND\s+\(\s*([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\s+OR\s+([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\s*\)/i
      .exec(body);
  if (!joinMatch) return stmt;
  const [matchedJoin, rel, alias, onPrefix, lhs1, rhs1, lhs2, rhs2] = joinMatch;
  const extract = (a: string, b: string) => {
    if (a.startsWith(`${alias}.`) && !b.startsWith(`${alias}.`)) {
      return { selfCol: a, otherRef: b, eq: `${a}=${b}` };
    }
    if (b.startsWith(`${alias}.`) && !a.startsWith(`${alias}.`)) {
      return { selfCol: b, otherRef: a, eq: `${a}=${b}` };
    }
    return null;
  };
  const d1 = extract(lhs1, rhs1);
  const d2 = extract(lhs2, rhs2);
  if (!d1 || !d2 || d1.otherRef !== d2.otherRef || d1.selfCol === d2.selfCol) {
    return stmt;
  }
  const join1 = `JOIN ${rel} ${alias} ON ${onPrefix} AND ${d1.eq}`;
  const join2 =
    `JOIN ${rel} ${alias} ON ${onPrefix} AND ${d2.eq} AND (${d1.selfCol} IS NULL OR ${d2.selfCol} <> ${d1.selfCol})`;
  const before = body.slice(0, joinMatch.index);
  const after = body.slice(joinMatch.index + matchedJoin.length);
  return `${prefix}SELECT ${before}${join1}${after} ${
    distinctKw ? "UNION" : "UNION ALL"
  } SELECT ${before}${join2}${after}`;
}

function rewriteDisjunctiveEquiJoins(sql: string): string {
  if (!sql.includes(";")) return sql;
  let out = "";
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === ";") {
      out += rewriteDisjunctiveEquiJoinStatement(sql.slice(start, i)) + ";";
      start = i + 1;
    }
  }
  if (start < sql.length) out += sql.slice(start);
  return out;
}

export function translateRisingWaveSql(sql: string): string {
  let out = replacePositionCalls(sql);
  out = mapUnquotedSql(out, (chunk) =>
    chunk
      .replaceAll(/\bCREATE\s+LOCAL\s+VIEW\b/gi, "CREATE VIEW")
      .replaceAll(/\bDOUBLE\b(?!\s+PRECISION)/gi, "DOUBLE PRECISION")
      .replaceAll(/\bTIMESTAMP\s*\(\s*\d+\s*\)/gi, "TIMESTAMP")
      .replaceAll(/\bVARCHAR\s*\(\s*\d+\s*\)/gi, "VARCHAR")
      .replaceAll(
        /\bDECIMAL\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi,
        "NUMERIC($1, $2)",
      )
      .replaceAll(/\bAS\s+DECIMAL\b/gi, "AS NUMERIC")
      .replaceAll(/\bAS\s+REAL\b/gi, "AS DOUBLE PRECISION")
      .replaceAll(
        /FLOOR\(\s*MAX\(utc\)\s+TO\s+MONTH\s*\)/gi,
        "DATE_TRUNC('month', MAX(utc))",
      )
      .replaceAll(/\bposition\b/g, '"position"')
  );
  out = rewriteDisjunctiveEquiJoins(out);
  out = out
    .replace(
      "SELECT x.* FROM archive x CROSS JOIN boundary b WHERE x.utc > b.latest + INTERVAL '-1456' DAY;",
      "SELECT x.* FROM archive x WHERE x.utc > (SELECT MAX(latest) + INTERVAL '-1456' DAY FROM boundary);",
    )
    .replace(
      "FROM archive x CROSS JOIN boundary b;",
      "FROM (SELECT 1 AS __k, * FROM archive) x JOIN (SELECT 1 AS __k, * FROM boundary) b ON x.__k = b.__k;",
    )
    .replaceAll(
      /LEFT\s+ASOF\s+JOIN\s+(\w+)\s+(\w+)\s+MATCH_CONDITION\(([^)]+)\)\s+ON\s+/gi,
      "ASOF LEFT JOIN $1 $2 ON $3 AND ",
    )
    .replace(
      /INTERVAL\s+'(-?\d+)'\s+(DAY|SECOND|MINUTE|HOUR|YEAR)S?\b/gi,
      (_, n, u) => `INTERVAL '${n} ${u.toLowerCase()}s'`,
    )
    .replace(
      /TIMESTAMPDIFF\s*\(\s*SECOND\s*,\s*([^,]+)\s*,\s*(COALESCE\([^)]+\)|[^)]+)\s*\)/gi,
      (_, a, b) =>
        `(((EXTRACT(EPOCH FROM (${b})) * 1000000)::bigint - (EXTRACT(EPOCH FROM (${a})) * 1000000)::bigint) / 1000000)`,
    )
    .replace(
      /\(CAST\(\(([a-zA-Z0-9_.]+)\s*-\s*TIMESTAMP\s*'0001-01-01 00:00:00'\)\s*SECOND\s+AS\s+BIGINT\)\s*-\s*62135596800\)/gi,
      (_, col) =>
        `((((EXTRACT(EPOCH FROM (${col})) * 1000000)::bigint + 62135596800000000) / 1000000) - 62135596800)`,
    )
    .replace(
      /FROM\s+corpus_hits\s+h\s+CROSS\s+JOIN\s+corpus_visits\s+v/gi,
      `FROM corpus_hits h JOIN corpus_visits v ON ${zeroKey("h.id")} = ${
        zeroKey("v.visits")
      }`,
    )
    .replace(
      /FROM\s+source_filter\s+f\s+CROSS\s+JOIN\s+source_panel\s+p/gi,
      `FROM source_filter f JOIN source_panel p ON ${zeroKey("f.id")} = ${
        zeroKey("p.id")
      }`,
    )
    .replace(
      /FROM\s+assigned\s+a\s+CROSS\s+JOIN\s+page_positions\s+p/gi,
      `FROM assigned a JOIN page_positions p ON ${zeroKey("a.id")} = ${
        zeroKey("p.pos")
      }`,
    )
    .replace(
      /FROM\s+contexts\s+c\s+CROSS\s+JOIN\s+visits\s+v/gi,
      `FROM contexts c JOIN visits v ON ${zeroKey("c.filter_id")} = ${
        zeroKey("v.id")
      }`,
    )
    .replace(
      /FROM\s+contexts\s+c\s+CROSS\s+JOIN\s+facts\s+f/gi,
      `FROM contexts c JOIN facts f ON ${zeroKey("c.filter_id")} = ${
        zeroKey("f.id")
      }`,
    )
    .replace(
      /FROM\s+window_facts\s+f\s+CROSS\s+JOIN\s+source_panel\s+p/gi,
      `FROM window_facts f JOIN source_panel p ON ${zeroKey("f.filter_id")} = ${
        zeroKey("p.id")
      }`,
    )
    .replace(
      /FROM\s+window_visits\s+v\s+CROSS\s+JOIN\s+source_panel\s+p/gi,
      `FROM window_visits v JOIN source_panel p ON ${
        zeroKey("v.filter_id")
      } = ${zeroKey("p.id")}`,
    )
    .replace(
      /FROM\s+windows\s+w\s+CROSS\s+JOIN\s+grid_ord\s+n/gi,
      `FROM windows w JOIN grid_ord n ON ${zeroKey("w.id")} = ${
        zeroKey("n.ord")
      }`,
    )
    .replace(
      /FROM\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s+JOIN\s+zone_seconds\s+a\s+ON\s+([^\n]+)\nJOIN\s+zone_seconds\s+b\s+ON\s+([^\n]+?)\s+GROUP\s+BY/gi,
      (_, t1, a1, condA, condB) =>
        `FROM ${t1} ${a1} JOIN zone_seconds a ON ${zeroKey(`${a1}.id`)} = ${
          zeroKey("a.id")
        } AND (${condA})\nJOIN zone_seconds b ON ${zeroKey(`${a1}.id`)} = ${
          zeroKey("b.id")
        } AND (${condB}) GROUP BY`,
    )
    .replace(
      /FROM\s+([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+)\s+JOIN\s+zone_seconds\s+z\s*\n?\s*ON\s+z\.starts\s*<=/gi,
      (_, t1, a1) =>
        `FROM ${t1} ${a1} JOIN zone_seconds z ON ${
          zeroKey(a1 === "h" ? "h.filter_id" : `${a1}.id`)
        } = ${zeroKey("z.id")} AND z.starts <=`,
    )
    .replace(
      /FROM\s+source_filter\s+f\s*\n?\s*LEFT\s+JOIN\s+facts\s+h\s+ON\s+/gi,
      `FROM source_filter f LEFT JOIN facts h ON ${zeroKey("f.id")} = ${
        zeroKey("h.id")
      } AND `,
    );
  return out;
}

export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === ";") {
      const stmt = sql.slice(start, i).trim();
      if (stmt.length > 0) out.push(stmt);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

export function toPostgresConnectionString(endpoint: string): string {
  const parsed = new URL(endpoint);
  const user = parsed.username || "root";
  const pass = parsed.password ? `:${parsed.password}` : "";
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port || "4566";
  const db = parsed.pathname && parsed.pathname !== "/"
    ? parsed.pathname.slice(1)
    : "dev";
  return `postgresql://${user}${pass}@${host}:${port}/${db}`;
}

export function createRisingWaveCustomTypes() {
  return {
    getTypeParser: (oid: number, format?: string) => {
      if (oid === 1114 || oid === 1184 || oid === 1082) {
        return (val: string) => val;
      }
      if (oid === 20) {
        return (val: string) => {
          const num = Number(val);
          return Number.isSafeInteger(num) && String(num) === val ? num : val;
        };
      }
      if (oid === 21 || oid === 23 || oid === 700 || oid === 701) {
        return (val: string) => Number(val);
      }
      return pg.types.getTypeParser(oid, format as "text" | "binary");
    },
  };
}

export const defaultRisingWaveConnect: RisingWaveConnect = async (
  endpoint: string,
) => {
  const client = new pg.Client({
    connectionString: toPostgresConnectionString(endpoint),
    types: createRisingWaveCustomTypes(),
  });
  await client.connect();
  return client;
};

// Compress upper LSM levels with LZ4 (and bottom levels with Zstd) so ephemeral
// Hummock state-store disk stays bounded without starving CPU during backfill.
export async function configureRisingWaveStorage(
  session: RisingWaveSqlSession,
): Promise<void> {
  await session.query("SET bypass_cluster_limits TO true");
  const { rows: groups } = await session.query<{ id: number | string }>(
    "SELECT id FROM rw_catalog.rw_hummock_compaction_group_configs ORDER BY id",
  );
  const ids = groups
    .map((g) => Number(g.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length > 0) {
    const levels = [
      ...[0, 1, 2, 3, 4].map((l) => `compression_algorithm = '${l}:lz4'`),
      ...[5, 6].map((l) => `compression_algorithm = '${l}:zstd'`),
    ].join(", ");
    await session.query(
      `ALTER COMPACTION GROUP ${ids.join(", ")} SET ${levels}`,
    );
  }
}

type Bag = Map<string, { row: Row; keys: string[] }>;

export function pipelineSchemaName(name: string): string {
  require(
    /^[a-z][a-z0-9_-]{0,99}$/.test(name),
    "invalid pipeline name",
  );
  return `rw_${name.replaceAll("_", "__").replaceAll("-", "_h")}`;
}

export function sqlLiteral(val: unknown, type: string): string {
  if (val === null || val === undefined) return "NULL";
  switch (type) {
    case "BOOLEAN":
      return val ? "TRUE" : "FALSE";
    case "SMALLINT":
    case "INTEGER":
    case "BIGINT":
      return String(val);
    case "DOUBLE":
      return `'${String(val).replaceAll("'", "''")}'::double precision`;
    case "TIMESTAMP":
      return `TIMESTAMP '${String(val).replace("T", " ").replace(/Z$/, "")}'`;
    case "VARCHAR":
    default:
      return `'${String(val).replaceAll("'", "''")}'`;
  }
}

/** One coordinator owns this connector-free pipeline and supplies complete source snapshots. */
export class RisingWave {
  private readonly endpoint: string;
  private readonly schemaName: string;
  private readonly program: RisingWaveProgram;
  private readonly connect: RisingWaveConnect;
  private readonly normalizeOutput?: (name: string, rows: Row[]) => Row[];
  private session?: RisingWaveSqlSession;
  private previous: Record<string, Bag> = {};
  private nextRowKey = 1;
  private poisoned = false;
  private capturing = false;

  constructor(
    endpoint: string,
    pipelineName: string,
    program: RisingWaveProgram,
    connect: RisingWaveConnect = defaultRisingWaveConnect,
    normalizeOutput?: (name: string, rows: Row[]) => Row[],
  ) {
    require(
      /^[a-z][a-z0-9_-]{0,99}$/.test(pipelineName),
      "invalid pipeline name",
    );
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("RisingWave: invalid endpoint");
    }
    require(
      ["http:", "https:", "postgres:", "postgresql:"].includes(url.protocol) &&
        !url.search && !url.hash,
      "invalid endpoint",
    );
    require(
      object(program) && typeof program.sql === "string" &&
        program.sql.length > 0,
      "missing SQL program",
    );
    require(
      object(program.inputs) && Object.keys(program.inputs).length > 0,
      "missing inputs",
    );
    require(
      object(program.outputs) && Object.keys(program.outputs).length > 0,
      "missing outputs",
    );
    for (const [name, input] of Object.entries(program.inputs)) {
      require(
        identifier.test(name) && object(input) &&
          typeof input.query === "string" && input.query.length > 0,
        "invalid input",
      );
      validateFields(input.fields);
    }
    for (const [name, output] of Object.entries(program.outputs)) {
      require(
        identifier.test(name) && object(output) && identifier.test(output.view),
        "invalid output",
      );
      validateFields(output.fields);
    }
    this.endpoint = endpoint;
    this.schemaName = pipelineSchemaName(pipelineName);
    this.program = structuredClone(program);
    this.connect = connect;
    this.normalizeOutput = normalizeOutput;
  }

  private async initialize(): Promise<RisingWaveSqlSession> {
    if (this.session) return this.session;
    const session = await this.connect(this.endpoint);
    try {
      await configureRisingWaveStorage(session);
      await session.query(`DROP SCHEMA IF EXISTS "${this.schemaName}" CASCADE`);
      await session.query(`CREATE SCHEMA "${this.schemaName}"`);
      await session.query(`SET search_path TO "${this.schemaName}"`);
      await session.query("SET streaming_parallelism = 2");
      await session.query("SET RW_IMPLICIT_FLUSH TO true");

      for (const name of Object.keys(this.program.inputs)) {
        const rawDecl = new RegExp(`CREATE\\s+TABLE\\s+${name}\\s*\\(([^;]+)\\)\\s*;`, "i");
        const rawMatch = rawDecl.exec(this.program.sql);
        require(rawMatch !== null, `missing table declaration for ${name}`);
        require(
          !/\bVARCHAR\s*\(\s*\d+\s*\)/i.test(rawMatch[1]),
          "bounded input VARCHAR is unsupported",
        );
      }
      let rwSql = translateRisingWaveSql(this.program.sql);
      for (const [name, input] of Object.entries(this.program.inputs)) {
        const decl = new RegExp(`CREATE\\s+TABLE\\s+${name}\\s*\\(([^;]+)\\)\\s*;`, "i");
        const match = decl.exec(rwSql);
        require(match !== null, `missing table declaration for ${name}`);
        const cols = input.fields.map((f) => `"${f.name}"`).join(", ");
        rwSql = rwSql.replace(
          decl,
          `CREATE TABLE raw_${name} (__row_key VARCHAR PRIMARY KEY, ${match[1]});\nCREATE VIEW ${name} AS SELECT ${cols} FROM raw_${name};`,
        );
      }

      for (const stmt of splitStatements(rwSql)) {
        await session.query(stmt);
      }
      this.session = session;
      return session;
    } catch (error) {
      await session.end();
      throw error;
    }
  }

  async capture(reader: Reader): Promise<Record<string, Row[]>> {
    require(!this.poisoned, "adapter poisoned; restart the compute service");
    if (this.capturing) {
      this.poisoned = true;
      throw new Error(
        "RisingWave: concurrent capture; restart the compute service",
      );
    }
    this.capturing = true;
    try {
      const nextRows: Record<string, Row[]> = {};
      for (const [name, input] of Object.entries(this.program.inputs)) {
        nextRows[name] = rows(
          await reader.query(input.query),
          input.fields,
          Boolean(this.normalizeOutput),
        );
      }
      require(!this.poisoned, "concurrent capture poisoned adapter");
      const session = await this.initialize();
      const nextBags: Record<string, Bag> = {};
      for (const [name, input] of Object.entries(this.program.inputs)) {
        const prevBag: Bag = this.previous[name] ?? new Map();
        const currentBag: Bag = new Map();
        for (const row of nextRows[name]) {
          const sig = JSON.stringify(row);
          let entry = currentBag.get(sig);
          if (!entry) {
            entry = { row, keys: [] };
            currentBag.set(sig, entry);
          }
          const prevEntry = prevBag.get(sig);
          if (prevEntry && prevEntry.keys.length > entry.keys.length) {
            entry.keys.push(prevEntry.keys[entry.keys.length]);
          } else {
            const newKey = `k_${this.nextRowKey++}`;
            entry.keys.push(newKey);
            const cols = ["__row_key", ...input.fields.map((f) => `"${f.name}"`)].join(", ");
            const vals = [
              sqlLiteral(newKey, "VARCHAR"),
              ...input.fields.map((f) => sqlLiteral(row[f.name], f.type)),
            ].join(", ");
            await session.query(`INSERT INTO raw_${name} (${cols}) VALUES (${vals})`);
          }
        }
        for (const [sig, prevEntry] of prevBag) {
          const kept = currentBag.get(sig)?.keys.length ?? 0;
          for (let i = kept; i < prevEntry.keys.length; i++) {
            await session.query(
              `DELETE FROM raw_${name} WHERE __row_key = ${sqlLiteral(prevEntry.keys[i], "VARCHAR")}`,
            );
          }
        }
        nextBags[name] = currentBag;
      }
      await session.query("FLUSH");
      const result: Record<string, Row[]> = {};
      for (const [name, output] of Object.entries(this.program.outputs)) {
        const queried = await session.query(`SELECT * FROM "${output.view}"`);
        const raw = rows(
          queried.rows,
          output.fields,
          Boolean(this.normalizeOutput),
        );
        result[name] = this.normalizeOutput
          ? this.normalizeOutput(name, raw)
          : raw;
      }
      require(!this.poisoned, "concurrent capture poisoned adapter");
      this.previous = nextBags;
      return result;
    } catch (error) {
      this.poisoned = true;
      if (error instanceof Error && error.message.startsWith("RisingWave:")) {
        throw error;
      }
      throw new Error(
        `RisingWave: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.capturing = false;
    }
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    try {
      await session.query(`DROP SCHEMA IF EXISTS "${this.schemaName}" CASCADE`);
    } finally {
      await session.end();
    }
  }
}
