import type pg from "pg";
import { dropOwnedSlots } from "./native-cleanup.ts";
import { rows as normalizeRows } from "./feldera.ts";
import { xxhash3 } from "hash-wasm";
import type { Row } from "./main.ts";
import type { DeltaStep } from "./deltas.ts";
import {
  type IncrementalProgram,
  nativeSql,
  sourceSchema,
  sqlIdentifier,
} from "./native-sources.ts";

export type CompilationProfile = "optimized" | "unoptimized";

export function compilationProfile(value = "optimized"): CompilationProfile {
  if (value !== "optimized" && value !== "unoptimized") {
    throw new Error(`unsupported FELDERA_COMPILATION_PROFILE: ${value}`);
  }
  return value;
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
export async function replicationIdentity(
  uri: string,
  publication: string,
  table: string,
) {
  const url = new URL(uri);
  const identity = `${url.hostname}:${url.port || "5432"}/${
    url.pathname.slice(1)
  }\0${publication}\0${table}`;
  const unsigned = BigInt("0x" + await xxhash3(identity));
  return {
    id: BigInt.asIntN(64, unsigned).toString(),
    slot: `supabase_etl_apply_${unsigned}`,
  };
}

/** A fresh OSS circuit owns fresh CDC identities; captured inputs survive in PostgreSQL. */
export class NativeFeldera {
  private readonly path: string;
  private deployment = "";
  private incarnation = "";
  private sql = "";
  private paused = false;
  private poisoned = false;
  private acknowledged = new Set<string>();
  readonly metrics = { deltaRows: 0, captures: 0, baselineRows: 0 };

  constructor(
    endpoint: string,
    readonly name: string,
    readonly program: IncrementalProgram,
    readonly version: string,
    private uri: string,
    private readonly profile: CompilationProfile = "optimized",
  ) {
    if (!/^[a-z][a-z0-9_-]{0,99}$/.test(name)) {
      throw new Error("invalid native pipeline name");
    }
    this.path = `${endpoint.replace(/\/$/, "")}/v0/pipelines/${name}`;
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ) {
    if (this.poisoned) {
      throw new Error("native pipeline requires reconstruction");
    }
    const response = await fetch(this.path + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (missing && response.status === 404) return response;
    if (!response.ok) {
      throw new Error(`Feldera ${method} ${path}: ${response.status}`);
    }
    return response;
  }
  private async json(path: string, method = "GET", body?: unknown) {
    return await (await this.request(path, method, body)).json();
  }
  private async status(wanted: string) {
    const deadline = Date.now() + (wanted === "Compiled" ? 1200000 : 600000);
    do {
      const state = await this.json("");
      if (
        state.deployment_error ||
        ["SqlError", "RustError", "SystemError"].includes(state.program_status)
      ) {
        throw new Error(
          `native ${this.name}: ${state.program_status}/${state.deployment_status}: ${
            JSON.stringify({
              program_error: state.program_error,
              deployment_error: state.deployment_error,
            })
          }`,
        );
      }
      if (
        wanted === "Compiled"
          ? state.program_status === "Success"
          : state.deployment_status === wanted
      ) return state;
      await delay();
    } while (Date.now() < deadline);
    throw new Error(`native ${this.name}: ${wanted} timed out`);
  }
  private async query(sql: string): Promise<Row[]> {
    const response = await this.request(
      "/query?" + new URLSearchParams({ sql, format: "json" }),
    );
    const text = (await response.text()).trim();
    return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
  }

  async initialize(
    db: pg.Pool,
    baseline: Record<string, Row[]>,
    captureIds: string[],
  ) {
    const existing = await this.request("", "GET", undefined, true);
    await existing.text();
    if (existing.status !== 404) {
      await this.json("/stop?force=true", "POST");
      await this.status("Stopped");
    }
    const schema = sourceSchema(this.version);
    const prefix = "duckstream_" + crypto.randomUUID().replaceAll("-", "");
    const publications = Object.fromEntries(
      Object.keys(this.program.inputs).map((
        name,
        i,
      ) => [name, `${prefix}_${i}`]),
    );
    const identities = await Promise.all(
      Object.keys(this.program.inputs).map(async (name) => ({
        table: `${schema}.${name}`,
        publication: publications[name],
        ...await replicationIdentity(
          this.uri,
          publications[name],
          `${schema}.${name}`,
        ),
      })),
    );
    const client = await db.connect();
    try {
      await client.query(
        "ALTER TABLE compute.native_epoch ADD COLUMN IF NOT EXISTS source_schema text, ADD COLUMN IF NOT EXISTS pipeline_url text",
      );
      const { rows: old } = await client.query(
        "SELECT publications, slots, source_schema FROM compute.native_epoch WHERE name=$1",
        [this.name],
      );
      for (const epoch of old) {
        await dropOwnedSlots(client, epoch.slots);
        for (const publication of epoch.publications) {
          await client.query(
            `DROP PUBLICATION IF EXISTS ${sqlIdentifier(publication)}`,
          );
        }
        if (epoch.source_schema && epoch.source_schema !== schema) {
          if (!/^duckstream_[0-9a-f]{24}$/.test(epoch.source_schema)) {
            throw new Error("invalid owned source schema");
          }
          await client.query(
            `DROP SCHEMA IF EXISTS ${
              sqlIdentifier(epoch.source_schema)
            } CASCADE`,
          );
        }
      }
      const { rows: [ledger] } = await client.query(
        "SELECT to_regclass('compute.native_sources') IS NOT NULL AS present",
      );
      if (ledger.present) {
        const { rows: abandoned } = await client.query(
          "SELECT source_schema FROM compute.native_sources WHERE name=$1 AND source_schema<>$2",
          [this.name, schema],
        );
        for (const owned of abandoned) {
          if (!/^duckstream_[0-9a-f]{24}$/.test(owned.source_schema)) {
            throw new Error("invalid owned carrier schema");
          }
          await client.query(
            `DROP SCHEMA IF EXISTS ${
              sqlIdentifier(owned.source_schema)
            } CASCADE`,
          );
          await client.query(
            "DELETE FROM compute.native_sources WHERE name=$1 AND source_schema=$2",
            [this.name, owned.source_schema],
          );
        }
      }
      await client.query("BEGIN");
      for (const identity of identities) {
        await client.query(
          `CREATE PUBLICATION ${
            sqlIdentifier(identity.publication)
          } FOR TABLE ${
            identity.table.split(".").map(sqlIdentifier).join(".")
          }`,
        );
      }
      // Register exact identities before starting connectors, including interrupted copies.
      const slots: string[] = [];
      for (const identity of identities) {
        const { rows: [table] } = await client.query(
          "SELECT $1::regclass::oid::text AS oid",
          [identity.table],
        );
        slots.push(
          identity.slot,
          identity.slot.replace("_apply_", "_table_sync_") + "_" + table.oid,
        );
      }
      await client.query(
        `INSERT INTO compute.native_epoch(name,publications,slots,source_schema,pipeline_url) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(name) DO UPDATE SET publications=EXCLUDED.publications,slots=EXCLUDED.slots,source_schema=EXCLUDED.source_schema,pipeline_url=EXCLUDED.pipeline_url`,
        [this.name, Object.values(publications), slots, schema, this.path],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    this.sql = nativeSql(this.program, schema, publications);
    await this.json("", "PUT", {
      name: this.name,
      program_code: this.sql,
      udf_rust: "",
      udf_toml: "",
      runtime_config: {
        workers: 1,
        storage: null,
        max_parallel_connector_init: 1,
      },
      program_config: { profile: this.profile },
    });
    await this.status("Compiled");
    await this.json("/start", "POST");
    const state = await this.status("Running");
    if (!/^0\.367\.0(?:\+|$)/.test(state.platform_version)) {
      throw new Error("native manager must be 0.367.0");
    }
    this.deployment = state.deployment_id;
    this.incarnation =
      (await this.json("/stats")).global_metrics.incarnation_uuid;
    const deadline = Date.now() + 600000;
    let ready = false;
    do {
      await this.check();
      const { rows: [installed] } = await db.query(
        "SELECT to_regclass('etl.replication_state') IS NOT NULL AS present",
      );
      if (installed.present) {
        const { rows } = await db.query(
          `SELECT pipeline_id::text,state::text FROM etl.replication_state
          WHERE is_current AND (pipeline_id,table_id) IN
          (SELECT id::bigint,table_name::regclass::oid FROM jsonb_to_recordset($1::jsonb) AS expected(id text,table_name text))`,
          [JSON.stringify(
            identities.map((i) => ({ id: i.id, table_name: i.table })),
          )],
        );
        const inputs = (await this.json("/stats")).inputs.filter((
          i: { endpoint_name: string },
        ) => i.endpoint_name.startsWith("cdc_"));
        ready = rows.length === identities.length && rows.every((r) =>
          ["sync_done", "ready"].includes(r.state)
        ) &&
          inputs.length === identities.length &&
          inputs.every((i: { barrier: boolean }) => i.barrier === false);
        if (rows.some((r) => r.state === "errored")) {
          throw new Error("native CDC bootstrap failed");
        }
      }
      if (ready) break;
      await delay();
    } while (Date.now() < deadline);
    if (!ready) throw new Error("native CDC bootstrap timed out");
    for (const [name, rows] of Object.entries(baseline)) {
      this.metrics.baselineRows += rows.length;
      await this.ingress(name, rows.map((insert) => ({ insert })));
    }
    this.acknowledged = new Set(captureIds);
  }

  async check() {
    const state = await this.json("");
    if (
      state.deployment_id !== this.deployment ||
      state.program_code !== this.sql ||
      !["Running", "Paused"].includes(state.deployment_status)
    ) throw new Error("native pipeline incarnation changed");
    const stats = await this.json("/stats");
    if (stats.global_metrics.incarnation_uuid !== this.incarnation) {
      throw new Error("native runtime restarted");
    }
    for (const input of stats.inputs) {
      if (
        input.fatal_error || input.metrics.num_parse_errors ||
        input.metrics.num_transport_errors
      ) throw new Error(`native input ${input.endpoint_name} failed`);
    }
  }
  async pending(): Promise<boolean> {
    await this.check();
    for (const name of Object.keys(this.program.outputs)) {
      for (const kind of ["add", "remove"]) {
        if (
          (await this.query(
            `SELECT 1 AS pending FROM pending_${kind}_${name} LIMIT 1`,
          )).length
        ) return true;
      }
    }
    return false;
  }
  async capture(): Promise<DeltaStep> {
    await this.check();
    if (!this.paused) {
      await this.json("/pause", "POST");
      await this.status("Paused");
      this.paused = true;
    }
    const names = Object.keys(this.program.outputs);
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const payloads = (selected?: string) =>
      names.map((name) => {
        const fields = [
          "__partition",
          ...this.program.outputs[name].fields.map((f) => f.name),
        ];
        const value = name === selected
          ? `named_struct(${
            fields.flatMap((field) => [literal(field), sqlIdentifier(field)])
              .join(",")
          })`
          : "NULL";
        return `${value} AS ${sqlIdentifier(name)}`;
      }).join(",");
    const queries = names.flatMap((name) =>
      ["add", "remove"].map((kind) =>
        `SELECT ${kind === "add" ? 1 : -1} AS __weight,NULL AS __invalid,${
          payloads(name)
        } FROM pending_${kind}_${name}`
      )
    );
    for (const name of Object.keys(this.program.incremental.checks ?? {})) {
      queries.push(
        `SELECT 0 AS __weight,${
          literal(name)
        } AS __invalid,${payloads()} FROM (SELECT 1 FROM invalid_${name} LIMIT 1)`,
      );
    }
    // Pause stops readers asynchronously; one request gives all relations the same circuit snapshot.
    const captured = await this.query(queries.join(" UNION ALL "));
    const invalid = captured.find((row) => row.__invalid !== null);
    if (invalid) throw new Error(`invalid native input: ${invalid.__invalid}`);
    const result: DeltaStep = {};
    for (const name of names) {
      const fields = [
        { name: "__partition", type: "VARCHAR" },
        ...this.program.outputs[name].fields,
      ];
      result[name] = captured.filter((row) => row[name] !== null).map((
        row,
      ) => ({
        row: normalizeRows([row[name] as Row], fields)[0],
        weight: Number(row.__weight),
      }));
      this.metrics.deltaRows += result[name].length;
    }
    this.metrics.captures++;
    return result;
  }
  private async ingress(
    name: string,
    changes: ({ insert: Row } | { delete: Row })[],
  ) {
    for (let i = 0; i < changes.length; i += 500) {
      const token = (await this.json(
        `/ingress/captured_${name}?format=json&array=true`,
        "POST",
        changes.slice(i, i + 500),
      )).token;
      const deadline = Date.now() + 30000;
      while (
        (await this.json(
          `/completion_status?token=${encodeURIComponent(token)}`,
        )).status !== "complete"
      ) {
        if (Date.now() > deadline) {
          throw new Error("native capture acknowledgment timed out");
        }
        await delay();
      }
    }
  }
  async acknowledge(id: string, delta: DeltaStep) {
    if (this.acknowledged.has(id)) return;
    try {
      if (this.paused) {
        await this.json("/resume", "POST");
        await this.status("Running");
        this.paused = false;
      }
      for (const [name, rows] of Object.entries(delta)) {
        await this.ingress(
          name,
          rows.map(({ row, weight }) => {
            if (weight !== 1 && weight !== -1) {
              throw new Error("native capture weight is not one");
            }
            return weight === 1 ? { insert: row } : { delete: row };
          }),
        );
      }
      this.acknowledged = new Set([id]);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
}
