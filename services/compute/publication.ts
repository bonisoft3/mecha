import type pg from "npm:pg@8.16.3";
import type { TypeTable } from "./portable-contract.ts";
import { postgresRows, type TypeSchemas, validateSchemas } from "./portable.ts";
import {
  type SinkWrites,
  validateSinkWrites,
} from "../../packages/compute-snapshot/src/sink-writes.ts";

type Row = Record<string, unknown>;
export type Publication = {
  name: string;
  to: string[];
  sinkWrites?: SinkWrites;
  onComplete?: string;
  types?: TypeTable;
  sinkTypes?: TypeSchemas;
};
export type Delta = Record<string, { upserts: Row[]; deletes: string[] }>;
export type Summary = Record<
  string,
  { rows: number; upserted: number; deleted: number }
>;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const BATCH = 500;
const isRow = (value: unknown): value is Row =>
  value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

function identifier(name: string) {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function json(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (value: unknown): void => {
    if (
      value === null || typeof value === "string" || typeof value === "boolean"
    ) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !isRow(value)) {
      throw new Error("publication requires finite JSON values");
    }
    if (ancestors.has(value)) {
      throw new Error("publication requires acyclic JSON values");
    }
    ancestors.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
    ancestors.delete(value);
  };
  visit(value);
  return JSON.stringify(value);
}

function validate(spec: Publication, out: unknown): Record<string, Row[]> {
  validateSinkWrites(spec.to, spec.sinkWrites);
  for (const table of spec.to) identifier(table);
  if (spec.onComplete !== undefined) identifier(spec.onComplete);
  if (new Set(spec.to).size !== spec.to.length) {
    throw new Error(`computation ${spec.name}: duplicate sinks`);
  }
  if (!isRow(out)) {
    throw new Error(`computation ${spec.name} returned no {sink: rows}`);
  }
  if (
    JSON.stringify(Object.keys(out).sort()) !==
      JSON.stringify([...spec.to].sort())
  ) {
    throw new Error(`computation ${spec.name} returned different sinks`);
  }
  for (const [table, rows] of Object.entries(out)) {
    if (!Array.isArray(rows) || !rows.every(isRow)) {
      throw new Error(`computation ${spec.name}: ${table} is no list of rows`);
    }
    const ids = new Set<string>();
    const columns = rows.length
      ? JSON.stringify(Object.keys(rows[0]).sort())
      : "";
    for (const row of rows) {
      if (typeof row.id !== "string" || ids.has(row.id)) {
        throw new Error(`${table} row id is not a unique text id`);
      }
      ids.add(row.id);
      for (const name of Object.keys(row)) identifier(name);
      if (JSON.stringify(Object.keys(row).sort()) !== columns) {
        throw new Error(`${table} rows differ in columns`);
      }
      json(row);
    }
  }
  return out as Record<string, Row[]>;
}

function validateDelta(spec: Publication, out: unknown): Delta {
  if (!isRow(out)) {
    throw new Error(`computation ${spec.name} returned no {sink: delta}`);
  }
  const upserts: Record<string, Row[]> = {};
  for (const [table, delta] of Object.entries(out)) {
    if (
      !isRow(delta) ||
      Object.keys(delta).sort().join(",") !== "deletes,upserts" ||
      !Array.isArray(delta.upserts) || !Array.isArray(delta.deletes)
    ) throw new Error(`${table} delta requires upserts and deletes`);
    upserts[table] = delta.upserts as Row[];
  }
  validate(spec, upserts);
  for (const [table, delta] of Object.entries(out as Delta)) {
    const ids = new Set(delta.upserts.map((row) => row.id));
    for (const id of delta.deletes) {
      if (typeof id !== "string" || ids.has(id)) {
        throw new Error(`${table} delta id is repeated or is not a text id`);
      }
      ids.add(id);
    }
  }
  return out as Delta;
}

export type PublicationIsolation =
  | "read committed"
  | "repeatable read"
  | "serializable";

async function roleSettings(client: pg.PoolClient, claims: Row) {
  const role = claims.role ?? "anon";
  if (typeof role !== "string" || !role.length) {
    throw new Error("publication claims require a text role");
  }
  // PostgREST 12.2.3 uses cluster-wide settings granted to the authenticator.
  const { rows: settings } = await client.query<{ key: string; value: string }>(
    `
    WITH role_setting AS (
      SELECT r.rolname, unnest(r.rolconfig) AS setting
      FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE member = current_user::regrole::oid
    ), kv_settings AS (
      SELECT rolname, substr(setting, 1, strpos(setting, '=') - 1) AS key,
        lower(substr(setting, strpos(setting, '=') + 1)) AS value FROM role_setting
    )
    SELECT kv.key, kv.value FROM kv_settings kv JOIN pg_settings ps ON ps.name = kv.key
    AND (ps.context = 'user' OR has_parameter_privilege(current_user::regrole::oid, ps.name, 'set'))
    WHERE kv.rolname = $1`,
    [role],
  );
  const level = settings.find(({ key }) =>
    key === "default_transaction_isolation"
  )?.value;
  const isolation: PublicationIsolation =
    level === "serializable" || level === "repeatable read"
      ? level
      : "read committed";
  return { role, settings, isolation };
}

/** Caller owns the transaction and must roll it back if publication fails. */
export async function publish(
  client: pg.PoolClient,
  spec: Publication,
  out: unknown,
  claims: Row,
): Promise<Summary> {
  return await apply(client, spec, validate(spec, out), claims);
}

/** Caller commits the delta, freshness guard and receipt in the same transaction. */
export async function publishDelta(
  client: pg.PoolClient,
  spec: Publication,
  out: unknown,
  claims: Row,
): Promise<Summary> {
  const delta = validateDelta(spec, out);
  return await apply(
    client,
    spec,
    Object.fromEntries(
      Object.entries(delta).map(([table, rows]) => [table, rows.upserts]),
    ),
    claims,
    Object.fromEntries(
      Object.entries(delta).map(([table, rows]) => [table, rows.deletes]),
    ),
  );
}

async function apply(
  client: pg.PoolClient,
  spec: Publication,
  rows: Record<string, Row[]>,
  claims: Row,
  deletions?: Record<string, string[]>,
): Promise<Summary> {
  const sinks = { ...rows };
  validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
  for (const [table, fields] of Object.entries(spec.sinkTypes ?? {})) {
    sinks[table] = postgresRows({ fields, types: spec.types! }, sinks[table]);
  }
  const claimsJson = json(claims);
  const { role, settings, isolation } = await roleSettings(client, claims);
  const { rows: transaction } = await client.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (
    transaction[0].isolation !== "serializable" &&
    transaction[0].isolation !== isolation
  ) {
    throw new Error(
      `publication requires transaction isolation ${isolation}; caller uses ${
        transaction[0].isolation
      }`,
    );
  }
  const applied = settings.filter(({ key }) =>
    key !== "default_transaction_isolation"
  );
  const names = [
    ...new Set([
      "role",
      "request.jwt.claims",
      ...applied.map(({ key }) => key),
    ]),
  ];
  const { rows: previous } = await client.query<
    { name: string; value: string | null }
  >(
    "SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS name",
    [names],
  );
  for (const { key, value } of applied) {
    await client.query("SELECT set_config($1, $2, true)", [key, value]);
  }
  await client.query("SELECT set_config('role', $1, true)", [role]);
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    claimsJson,
  ]);
  await client.query("SELECT public.app_pre_request()");
  for (const table of spec.to) {
    const ids = [
      ...sinks[table].map((row) => row.id),
      ...(deletions?.[table] ?? []),
    ];
    const seen = new Set<string>();
    // PostgreSQL accepts alternate UUID spellings that denote the same key.
    for (let i = 0; i < ids.length; i += BATCH) {
      const { rows: keys } = await client.query<{ id: string }>(
        `SELECT to_jsonb(input)->>'id' AS id
         FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json) AS input`,
        [json(ids.slice(i, i + BATCH).map((id) => ({ id })))],
      );
      for (const { id } of keys) {
        if (id === null || seen.has(id)) {
          throw new Error(
            `${table} publication contains repeated PostgreSQL keys`,
          );
        }
        seen.add(id);
      }
    }
  }
  const summary: Summary = Object.fromEntries(
    spec.to.map((
      table,
    ) => [table, { rows: sinks[table].length, upserted: 0, deleted: 0 }]),
  );
  for (const table of spec.to) {
    const rows = sinks[table];
    if (!rows.length) continue;
    const names = Object.keys(rows[0]);
    const columns = names.map(identifier).join(", ");
    const rest = names.filter((name) => name !== "id");
    const changes = rest.map((name) =>
      `${identifier(name)} = EXCLUDED.${identifier(name)}`
    ).join(", ");
    const existing = rest.map((name) => `sink.${identifier(name)}`).join(", ");
    const incoming = rest.map((name) => `EXCLUDED.${identifier(name)}`).join(
      ", ",
    );
    const conflict = rest.length
      ? `DO UPDATE SET ${changes} WHERE to_jsonb(ROW(${existing})) IS DISTINCT FROM to_jsonb(ROW(${incoming}))`
      : "DO NOTHING";
    for (let i = 0; i < rows.length; i += BATCH) {
      const result = await client.query(
        `INSERT INTO public.${identifier(table)} AS sink (${columns})
         SELECT ${columns} FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json)
         ON CONFLICT (id) ${conflict}`,
        [json(rows.slice(i, i + BATCH))],
      );
      summary[table].upserted += result.rowCount!;
    }
  }
  for (const table of spec.to) {
    if (spec.sinkWrites?.[table] === "upsert") continue;
    if (deletions) {
      const ids = deletions[table];
      for (let i = 0; i < ids.length; i += BATCH) {
        const result = await client.query(
          `DELETE FROM public.${identifier(table)} AS sink
           USING json_populate_recordset(NULL::public.${
            identifier(table)
          }, $1::json) AS removed
           WHERE sink.id = removed.id`,
          [json(ids.slice(i, i + BATCH).map((id) => ({ id })))],
        );
        summary[table].deleted += result.rowCount!;
      }
    } else {
      const result = await client.query(
        `DELETE FROM public.${identifier(table)} AS sink
         WHERE NOT EXISTS (
           SELECT FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json) AS retained
           WHERE sink.id = retained.id
         )`,
        [json(sinks[table].map(({ id }) => ({ id })))],
      );
      summary[table].deleted = result.rowCount!;
    }
  }
  if (spec.onComplete) {
    await client.query(`SELECT public.${identifier(spec.onComplete)}()`);
  }
  // Restore authority before the caller advances the private batch ledger.
  for (const { name, value } of previous) {
    await client.query("SELECT set_config($1, $2, true)", [name, value ?? ""]);
  }
  return summary;
}
