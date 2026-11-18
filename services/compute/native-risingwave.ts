import type pg from "npm:pg@8.16.3";
import {
  dropOwnedSlots,
  pipelineSchemaName,
  retirePipeline,
} from "./native-cleanup.ts";
import {
  configureRisingWaveStorage,
  defaultRisingWaveConnect,
  type RisingWaveConnect,
  type RisingWaveSqlSession,
  rows as normalizeRows,
  splitStatements,
  sqlLiteral,
} from "./risingwave.ts";
import type { Row } from "./main.ts";
import type { DeltaStep } from "./deltas.ts";
import {
  type IncrementalProgram,
  nativeSql,
  sourceSchema,
  sqlIdentifier,
} from "./native-sources.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A RisingWave streaming pipeline backed by a shared transactional PostgreSQL CDC source. */
export class NativeRisingWave {
  private readonly endpoint: string;
  private readonly pipelineUrl: string;
  private readonly rwSchema: string;
  private session?: RisingWaveSqlSession;
  private sql = "";
  private poisoned = false;
  private acknowledged = new Set<string>();
  private capturedNonEmpty = new Set<string>();
  readonly metrics = { deltaRows: 0, captures: 0, baselineRows: 0 };

  constructor(
    endpoint: string,
    readonly name: string,
    readonly program: IncrementalProgram,
    readonly version: string,
    private uri: string,
    private readonly connect: RisingWaveConnect = defaultRisingWaveConnect,
  ) {
    this.rwSchema = pipelineSchemaName(name);
    this.endpoint = endpoint.replace(/\/$/, "");
    this.pipelineUrl = `${this.endpoint}/pipelines/${name}`;
  }

  private async rwQuery<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<R[]> {
    if (this.poisoned || !this.session) {
      throw new Error("native pipeline requires reconstruction");
    }
    return (await this.session.query<R>(sql, values)).rows;
  }

  // Reattach to persisted ${COMPUTE_STATE_DIR}/risingwave state when PostgreSQL
  // slot, publication, SQL hash, and last acknowledged capture all match.
  async tryAttach(
    db: pg.Pool,
    expectedCaptureId: string,
  ): Promise<boolean> {
    if (this.session) {
      await this.session.end();
      this.session = undefined;
    }
    const schema = sourceSchema(this.version);
    const inputNames = Object.keys(this.program.inputs);
    const { rows: [epochTbl] } = await db.query<{ present: boolean }>(
      "SELECT to_regclass('compute.native_epoch') IS NOT NULL AS present",
    );
    if (!epochTbl?.present) return false;
    await db.query(
      "ALTER TABLE compute.native_epoch ADD COLUMN IF NOT EXISTS source_schema text, ADD COLUMN IF NOT EXISTS pipeline_url text, ADD COLUMN IF NOT EXISTS sql_hash text",
    );
    const { rows: [epoch] } = await db.query<{
      publications: string[];
      slots: string[];
      source_schema: string | null;
      pipeline_url: string | null;
      sql_hash: string | null;
    }>(
      "SELECT publications, slots, source_schema, pipeline_url, sql_hash FROM compute.native_epoch WHERE name=$1",
      [this.name],
    );
    if (
      !epoch ||
      epoch.source_schema !== schema ||
      epoch.pipeline_url !== this.pipelineUrl ||
      !epoch.sql_hash
    ) {
      return false;
    }
    const expectedCount = inputNames.length > 0 ? 1 : 0;
    if (
      epoch.publications.length !== expectedCount ||
      epoch.slots.length !== expectedCount
    ) {
      return false;
    }
    const sharedPublication = epoch.publications[0];
    const sharedSlot = epoch.slots[0];
    const publications = Object.fromEntries(
      inputNames.map((name) => [name, sharedPublication]),
    );
    const candidateSql = nativeSql(
      this.program,
      inputNames.length > 0 ? schema : undefined,
      inputNames.length > 0 ? publications : undefined,
      inputNames.length > 0
        ? {
          uri: this.uri,
          slot: sharedSlot,
          publication: sharedPublication,
        }
        : undefined,
    );
    if (epoch.sql_hash !== await sha256Hex(candidateSql)) {
      return false;
    }
    if (inputNames.length > 0) {
      const { rows: [pgOk] } = await db.query<{ ok: boolean }>(
        `SELECT
          to_regnamespace($1) IS NOT NULL
          AND EXISTS(SELECT 1 FROM pg_publication WHERE pubname=$2)
          AND EXISTS(
            SELECT 1 FROM pg_replication_slots
            WHERE slot_name=$3
              AND confirmed_flush_lsn IS NOT NULL
              AND coalesce(wal_status, 'reserved') <> 'lost'
          ) AS ok`,
        [schema, sharedPublication, sharedSlot],
      );
      if (!pgOk?.ok) return false;
    }

    const session = await this.connect(this.endpoint);
    let attached = false;
    try {
      const { rows: [rwSchemaRow] } = await session.query<{
        id: number | string;
      }>(
        `SELECT id FROM rw_catalog.rw_schemas WHERE name = ${
          sqlLiteral(this.rwSchema, "VARCHAR")
        }`,
      );
      if (!rwSchemaRow) return false;
      const schemaId = Number(rwSchemaRow.id);
      const { rows: ddlInProgress } = await session.query(
        "SELECT 1 FROM rw_catalog.rw_ddl_progress LIMIT 1",
      );
      if (ddlInProgress.length > 0) return false;

      const { rows: rwTables } = await session.query<{ name: string }>(
        `SELECT name FROM rw_catalog.rw_tables WHERE schema_id = ${schemaId}`,
      );
      const tableSet = new Set(rwTables.map((r) => r.name));
      if (!tableSet.has("__ack_state")) return false;
      for (const out of Object.keys(this.program.outputs)) {
        if (!tableSet.has(`captured_${out}`)) return false;
      }
      for (const inp of inputNames) {
        if (!tableSet.has(`cdc_${inp}`)) return false;
      }

      const { rows: rwMvs } = await session.query<{ name: string }>(
        `SELECT name FROM rw_catalog.rw_materialized_views WHERE schema_id = ${schemaId}`,
      );
      const mvSet = new Set(rwMvs.map((r) => r.name));
      for (const out of Object.keys(this.program.outputs)) {
        if (!mvSet.has(`pending_${out}`)) return false;
      }
      for (const chk of Object.keys(this.program.incremental.checks ?? {})) {
        if (!mvSet.has(`invalid_${chk}`)) return false;
      }

      await configureRisingWaveStorage(session);
      await session.query(`SET search_path TO "${this.rwSchema}"`);
      await session.query("SET streaming_parallelism = 2");
      await session.query("SET RW_IMPLICIT_FLUSH TO false");
      await session.query("FLUSH");

      const { rows: [ackRow] } = await session.query<{ capture_id: string }>(
        "SELECT capture_id FROM __ack_state WHERE id = 1",
      );
      if (!ackRow || ackRow.capture_id !== expectedCaptureId) {
        return false;
      }

      this.capturedNonEmpty.clear();
      for (const out of Object.keys(this.program.outputs)) {
        const { rows } = await session.query(
          `SELECT 1 AS ok FROM captured_${out} LIMIT 1`,
        );
        if (rows.length > 0) this.capturedNonEmpty.add(out);
      }
      this.session = session;
      this.poisoned = false;
      this.sql = candidateSql;
      this.acknowledged = new Set(expectedCaptureId ? [expectedCaptureId] : []);
      attached = true;
      return true;
    } finally {
      if (!attached) {
        await session.end();
      }
    }
  }

  async initialize(
    db: pg.Pool,
    baseline: Record<string, Row[]>,
    captureIds: string[],
    lastCaptureId = "",
  ) {
    if (this.session) {
      await this.session.end();
      this.session = undefined;
    }
    const session = await this.connect(this.endpoint);
    this.session = session;
    this.poisoned = false;

    try {
      await session.query(`DROP SCHEMA IF EXISTS "${this.rwSchema}" CASCADE`);

      const schema = sourceSchema(this.version);
      const prefix = "duckstream_" + crypto.randomUUID().replaceAll("-", "");
      const sharedPublication = `${prefix}_pub`;
      const sharedSlot = `${prefix}_slot`;
      const inputNames = Object.keys(this.program.inputs);
      const publications = Object.fromEntries(
        inputNames.map((name) => [name, sharedPublication]),
      );
      const initialCounts = new Map<string, number>();
      this.sql = nativeSql(
        this.program,
        inputNames.length > 0 ? schema : undefined,
        inputNames.length > 0 ? publications : undefined,
        inputNames.length > 0
          ? {
            uri: this.uri,
            slot: sharedSlot,
            publication: sharedPublication,
          }
          : undefined,
      );
      const sqlHash = await sha256Hex(this.sql);

      const client = await db.connect();
      try {
        await client.query(
          "ALTER TABLE compute.native_epoch ADD COLUMN IF NOT EXISTS source_schema text, ADD COLUMN IF NOT EXISTS pipeline_url text, ADD COLUMN IF NOT EXISTS sql_hash text",
        );
        const { rows: old } = await client.query(
          "SELECT publications, slots, source_schema, pipeline_url FROM compute.native_epoch WHERE name=$1",
          [this.name],
        );
        for (const epoch of old) {
          if (epoch.pipeline_url && epoch.pipeline_url !== this.pipelineUrl) {
            await retirePipeline(epoch.pipeline_url, this.connect);
          }
          await dropOwnedSlots(client, epoch.slots);
          for (const pub of epoch.publications) {
            await client.query(
              `DROP PUBLICATION IF EXISTS ${sqlIdentifier(pub)}`,
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
        if (inputNames.length > 0) {
          const tableList = inputNames.map((name) =>
            `${sqlIdentifier(schema)}.${sqlIdentifier(name)}`
          ).join(",");
          await client.query(
            `CREATE PUBLICATION ${
              sqlIdentifier(sharedPublication)
            } FOR TABLE ${tableList}`,
          );
          for (const name of inputNames) {
            const { rows: [cnt] } = await client.query(
              `SELECT count(*)::int AS n FROM ${sqlIdentifier(schema)}.${
                sqlIdentifier(name)
              }`,
            );
            initialCounts.set(name, Number(cnt?.n ?? 0));
          }
        }
        await client.query(
          `INSERT INTO compute.native_epoch(name,publications,slots,source_schema,pipeline_url,sql_hash) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(name) DO UPDATE SET publications=EXCLUDED.publications,slots=EXCLUDED.slots,source_schema=EXCLUDED.source_schema,pipeline_url=EXCLUDED.pipeline_url,sql_hash=EXCLUDED.sql_hash`,
          [
            this.name,
            inputNames.length > 0 ? [sharedPublication] : [],
            inputNames.length > 0 ? [sharedSlot] : [],
            schema,
            this.pipelineUrl,
            sqlHash,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await configureRisingWaveStorage(session);
      await session.query(`CREATE SCHEMA "${this.rwSchema}"`);
      await session.query(`SET search_path TO "${this.rwSchema}"`);
      await session.query("SET streaming_parallelism = 2");
      await session.query("SET RW_IMPLICIT_FLUSH TO false");
      await session.query(
        "CREATE TABLE __ack_state (id INT PRIMARY KEY, capture_id VARCHAR)",
      );
      await session.query(
        `INSERT INTO __ack_state (id, capture_id) VALUES (1, ${
          sqlLiteral(lastCaptureId, "VARCHAR")
        })`,
      );

      const statements = splitStatements(this.sql);
      const inputViews = new Set(inputNames.map((n) => n.toLowerCase()));
      const stripLeadingComments = (raw: string): string =>
        raw.replace(/^(?:(?:\s*--[^\n]*\n)|\s)+/, "");
      const isBaselineBootstrap = (raw: string): boolean => {
        const stmt = stripLeadingComments(raw);
        return /^CREATE\s+SOURCE\s+/i.test(stmt) ||
          /^CREATE\s+TABLE\s+captured_/i.test(stmt);
      };
      const isCdcBootstrap = (raw: string): boolean => {
        const stmt = stripLeadingComments(raw);
        if (/^CREATE\s+TABLE\s+cdc_/i.test(stmt)) return true;
        const view = /^CREATE\s+VIEW\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s+/i.exec(
          stmt,
        );
        return Boolean(view && inputViews.has(view[1].toLowerCase()));
      };
      // Seed captured_* before starting cdc_* backfills, then finish CDC snapshots
      // before creating derived MVs so load barriers neither block DDL nor retract MVs.
      for (const stmt of statements.filter(isBaselineBootstrap)) {
        await session.query(stmt);
      }

      this.capturedNonEmpty.clear();
      for (const [name, rows] of Object.entries(baseline)) {
        this.metrics.baselineRows += rows.length;
        await this.seedBaseline(name, rows);
      }
      await session.query("FLUSH");

      for (const stmt of statements.filter(isCdcBootstrap)) {
        await session.query(stmt);
      }

      if (inputNames.length > 0) {
        const watches = new Map(
          inputNames.map((name) => [name, {
            progress: 0,
            phase: "",
            stalledTicks: 0,
            deadline: Date.now() + 600000,
          }]),
        );
        const remaining = new Set(inputNames);
        let flushNext = [...remaining].every((n) =>
          (initialCounts.get(n) ?? 0) <= 10_000
        );
        for (;;) {
          await this.check();
          const { rows: slotRows } = await db.query(
            "SELECT active, confirmed_flush_lsn IS NOT NULL AS flushed FROM pg_replication_slots WHERE slot_name=$1",
            [sharedSlot],
          );
          const slotReady = slotRows.length === 1 &&
            Boolean(slotRows[0].flushed);
          if (flushNext) {
            await session.query("FLUSH");
          }
          let forceFlush = false;
          for (const name of [...remaining]) {
            let expected = initialCounts.get(name) ?? 0;
            const [{ n }] = await this.rwQuery<{ n: number }>(
              `SELECT count(*)::int AS n FROM cdc_${name}`,
            );
            const current = Number(n ?? 0);
            const watch = watches.get(name)!;
            const isLarge = expected - watch.progress > 10_000;
            const stallThreshold = isLarge ? 3 : 0;
            if (
              slotReady && current < expected && current <= watch.progress &&
              watch.stalledTicks >= stallThreshold
            ) {
              const { rows: [live] } = await db.query(
                `SELECT count(*)::int AS n FROM ${sqlIdentifier(schema)}.${
                  sqlIdentifier(name)
                }`,
              );
              if (live?.n !== undefined) {
                expected = Math.min(expected, Number(live.n));
                initialCounts.set(name, expected);
              }
            }
            if (slotReady && current >= expected) {
              remaining.delete(name);
              continue;
            }
            const phase = `${slotRows.length}:${
              Boolean(slotRows[0]?.flushed)
            }`;
            if (current > watch.progress || phase !== watch.phase) {
              watch.progress = current;
              watch.phase = phase;
              watch.stalledTicks = 0;
              watch.deadline = Date.now() + 600000;
            } else {
              watch.stalledTicks++;
              if (watch.stalledTicks >= (isLarge ? 3 : 1)) {
                forceFlush = true;
              }
            }
            if (Date.now() > watch.deadline) {
              throw new Error(
                `native CDC bootstrap made no progress for ten minutes: ${name}`,
              );
            }
          }
          if (remaining.size === 0) {
            await session.query("FLUSH");
            break;
          }
          const largeRemaining = [...remaining].some((n) =>
            (initialCounts.get(n) ?? 0) - (watches.get(n)?.progress ?? 0) >
              10_000
          );
          flushNext = forceFlush || !largeRemaining;
          await sleep(largeRemaining ? 5000 : 100);
        }
      }

      for (
        const stmt of statements.filter((s) =>
          !isBaselineBootstrap(s) && !isCdcBootstrap(s)
        )
      ) {
        await session.query(stmt);
      }
      await session.query("FLUSH");
      this.acknowledged = new Set(captureIds);
    } catch (error) {
      this.poisoned = true;
      await this.close();
      throw error;
    }
  }

  async check() {
    if (this.poisoned || !this.session) {
      throw new Error("native pipeline requires reconstruction");
    }
    const rows = await this.rwQuery<{ present: string | null }>(
      `SELECT schema_name AS present FROM information_schema.schemata WHERE schema_name = '${this.rwSchema}'`,
    );
    if (rows.length === 0 || !rows[0].present) {
      throw new Error("native pipeline incarnation changed");
    }
  }

  async close() {
    const session = this.session;
    this.session = undefined;
    if (session) {
      await session.end();
    }
  }

  async pending(flush: boolean | { done: boolean } = true): Promise<boolean> {
    await this.check();
    const names = Object.keys(this.program.outputs);
    if (names.length === 0) return false;
    const shouldFlush = typeof flush === "boolean" ? flush : !flush.done;
    if (shouldFlush) {
      await this.rwQuery("FLUSH");
      if (typeof flush === "object") flush.done = true;
    }
    return (await this.rwQuery(
      names.map((name) => `(SELECT 1 AS pending FROM pending_${name} LIMIT 1)`)
        .join(" UNION ALL "),
    )).length > 0;
  }

  async capture(): Promise<DeltaStep> {
    await this.check();
    await this.rwQuery("FLUSH");
    const names = Object.keys(this.program.outputs);
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const payloads = (selected?: string) =>
      names.map((name) => {
        const fields = [
          { name: "__partition", type: "VARCHAR" },
          ...this.program.outputs[name].fields,
        ];
        const value = name === selected
          ? `jsonb_build_object(${
            fields.flatMap((field) => [
              literal(field.name),
              field.type === "TIMESTAMP" || field.type === "BIGINT"
                ? `CAST(${sqlIdentifier(field.name)} AS VARCHAR)`
                : sqlIdentifier(field.name),
            ]).join(",")
          })`
          : "NULL::jsonb";
        return `${value} AS ${sqlIdentifier(name)}`;
      }).join(",");
    const queries = names.map((name) =>
      `SELECT __rw_mult AS __weight,NULL::varchar AS __invalid,${
        payloads(name)
      } FROM pending_${name}`
    );
    for (const name of Object.keys(this.program.incremental.checks ?? {})) {
      queries.push(
        `SELECT CAST(0 AS BIGINT) AS __weight,${
          literal(name)
        } AS __invalid,${payloads()} FROM (SELECT 1 FROM invalid_${name} LIMIT 1) __chk`,
      );
    }
    if (queries.length === 0) return {};
    const captured = await this.rwQuery(queries.join(" UNION ALL "));
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
      ) => {
        const weight = Number(row.__weight);
        if (!Number.isSafeInteger(weight) || weight === 0) {
          throw new Error("invalid native capture weight");
        }
        return {
          row: normalizeRows([row[name] as Row], fields, true)[0],
          weight,
        };
      });
      this.metrics.deltaRows += result[name].length;
    }
    this.metrics.captures++;
    return result;
  }

  private outputSchema(name: string) {
    const outputFields = [
      { name: "__partition", type: "VARCHAR" },
      ...this.program.outputs[name].fields,
    ];
    const rowKey = (row: Row) =>
      JSON.stringify(
        outputFields.map((f) => {
          const val = row[f.name] ?? null;
          return Object.is(val, -0) ? 0 : val;
        }),
      );
    const cols = [
      "__key",
      "__rw_mult",
      ...outputFields.map((f) => sqlIdentifier(f.name)),
    ].join(",");
    const formatTuple = (key: string, mult: number, row: Row) =>
      `(${
        [
          sqlLiteral(key, "VARCHAR"),
          String(mult),
          ...outputFields.map((f) => sqlLiteral(row[f.name], f.type)),
        ].join(",")
      })`;
    return { rowKey, cols, formatTuple };
  }

  private async seedBaseline(name: string, rows: readonly Row[]) {
    if (rows.length === 0) return;
    const { rowKey, cols, formatTuple } = this.outputSchema(name);
    const counts = new Map<string, { row: Row; count: number }>();
    for (const row of rows) {
      const key = rowKey(row);
      const prior = counts.get(key);
      if (prior) prior.count++;
      else counts.set(key, { row, count: 1 });
    }
    const chunkSize = 2500;
    let batch: string[] = [];
    for (const [key, { row, count }] of counts) {
      batch.push(formatTuple(key, count, row));
      if (batch.length >= chunkSize) {
        await this.rwQuery(
          `INSERT INTO captured_${name} (${cols}) VALUES ${batch.join(",")}`,
        );
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.rwQuery(
        `INSERT INTO captured_${name} (${cols}) VALUES ${batch.join(",")}`,
      );
    }
    this.capturedNonEmpty.add(name);
  }

  private async ingress(
    name: string,
    changes: readonly { row: Row; weight: number }[],
  ) {
    if (changes.length === 0) return;
    const { rowKey, cols, formatTuple } = this.outputSchema(name);
    const aggregated = new Map<string, { row: Row; delta: number }>();
    for (const { row, weight } of changes) {
      if (!Number.isSafeInteger(weight) || weight === 0) {
        throw new Error("invalid native capture weight");
      }
      const key = rowKey(row);
      const prior = aggregated.get(key);
      const delta = (prior?.delta ?? 0) + weight;
      if (!Number.isSafeInteger(delta)) {
        throw new Error("native capture weight overflow");
      }
      aggregated.set(key, { row, delta });
    }
    const activeKeys = [...aggregated.entries()].filter(([, v]) => v.delta !== 0)
      .map(([k]) => k);
    if (activeKeys.length === 0) return;
    const chunkSize = 2500;
    const priorCounts = new Map<string, number>();
    if (this.capturedNonEmpty.has(name)) {
      for (let i = 0; i < activeKeys.length; i += chunkSize) {
        const chunk = activeKeys.slice(i, i + chunkSize).map((k) =>
          sqlLiteral(k, "VARCHAR")
        ).join(",");
        const existing = await this.rwQuery<{
          __key: string;
          __rw_mult: number | string;
        }>(
          `SELECT __key, __rw_mult FROM captured_${name} WHERE __key IN (${chunk})`,
        );
        for (const row of existing) {
          priorCounts.set(row.__key, Number(row.__rw_mult));
        }
      }
    }
    const deletes: string[] = [];
    const inserts: [string, number, Row][] = [];
    for (const key of activeKeys) {
      const { row, delta } = aggregated.get(key)!;
      const prev = priorCounts.get(key) ?? 0;
      const next = prev + delta;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(`negative captured multiplicity for ${name}`);
      }
      if (prev > 0) deletes.push(sqlLiteral(key, "VARCHAR"));
      if (next > 0) inserts.push([key, next, row]);
    }
    for (let i = 0; i < deletes.length; i += chunkSize) {
      const chunk = deletes.slice(i, i + chunkSize).join(",");
      await this.rwQuery(
        `DELETE FROM captured_${name} WHERE __key IN (${chunk})`,
      );
    }
    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize).map(([k, m, r]) =>
        formatTuple(k, m, r)
      ).join(",");
      await this.rwQuery(
        `INSERT INTO captured_${name} (${cols}) VALUES ${chunk}`,
      );
    }
    if (inserts.length > 0) this.capturedNonEmpty.add(name);
  }

  async acknowledge(id: string, delta: DeltaStep) {
    if (this.acknowledged.has(id)) return;
    try {
      for (const [name, rows] of Object.entries(delta)) {
        await this.ingress(name, rows);
      }
      await this.rwQuery("DELETE FROM __ack_state WHERE id = 1");
      await this.rwQuery(
        `INSERT INTO __ack_state (id, capture_id) VALUES (1, ${
          sqlLiteral(id, "VARCHAR")
        })`,
      );
      await this.rwQuery("FLUSH");
      this.acknowledged = new Set([id]);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
}
