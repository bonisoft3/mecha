import pg from "npm:pg@8.16.3";
import { type BatchSpec, computationGraph } from "./batches.ts";
import {
  type BoundedOutput,
  type BoundedRuntime,
  collectBoundedFiles,
} from "./bounded-runtime.ts";
import { type DeltaStep, DeltaStore } from "./deltas.ts";
import { NativeRisingWave } from "./native-risingwave.ts";
import {
  type IncrementalProgram,
  installSources,
  sqlIdentifier,
} from "./native-sources.ts";
import {
  type Delta,
  dropStagedPages,
  type Publication,
  publish,
  publishDelta,
  publishStagedPages,
  stagePages,
} from "./publication.ts";
import { strictJson } from "./workers.ts";

type Row = Record<string, unknown>;
type Relations = Record<string, Row[]>;
type Capture = {
  id: string;
  keys: string[];
  initial: boolean;
  deltaRows: number;
};
type Calculated = {
  capture: Capture;
  outputs: Record<string, Relations>;
  persisted?: boolean;
};
type StepsCalculated = {
  capture: Capture;
  bounded?: BoundedOutput;
};
export type NativeSteps = {
  runtime: BoundedRuntime;
  directory: string;
};
type Computation = Publication & {
  calculate(input: unknown): Promise<unknown>;
  calculateMany?(
    entries: Iterable<readonly [string, unknown]>,
  ): Promise<Record<string, unknown>>;
  normalizeRisingWaveInputs?(
    inputs: Relations,
    program: IncrementalProgram,
  ): Relations;
};

const CHUNK_ROW_THRESHOLD = 5000;
const PARTITION_UPSERT_BATCH = 250;
const OWNER_INSERT_BATCH = 2000;
const CALCULATE_MANY_BATCH = 128;

export class NativeRuntime {
  static validateGraph(runtimes: readonly NativeRuntime[]): void {
    computationGraph(runtimes.map((runtime) => ({
      name: runtime.computation.name,
      reads: Object.values(runtime.program.incremental.inputs).map((input) =>
        input.table
      ),
      to: runtime.computation.to,
    })));
  }

  readonly engine: NativeRisingWave;
  readonly spec: BatchSpec;
  onReady: (() => void) | undefined;
  private readonly ready = Promise.withResolvers<void>();
  private busy = false;
  private failure: { error: unknown } | undefined;
  private first = true;
  private readonly names: string[];
  private readonly pendingDeltas = new Map<string, DeltaStep>();
  private readonly pendingInputs = new Map<string, Map<string, Relations>>();
  constructor(
    private readonly db: pg.Pool,
    endpoint: string,
    private readonly computation: Computation,
    private readonly program: IncrementalProgram,
    private readonly version: string,
    uri: string,
    claims: Parameters<typeof publish>[3],
    private readonly steps?: NativeSteps,
  ) {
    this.names = Object.keys(program.outputs);
    this.engine = new NativeRisingWave(
      endpoint,
      computation.name,
      program,
      version,
      uri,
    );
    this.spec = {
      name: computation.name,
      reads: [],
      to: [],
      version,

      initialize: async (client) => {
        await client.query(
          `CREATE TABLE IF NOT EXISTS compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL);
          CREATE TABLE IF NOT EXISTS compute.stream_state(name text PRIMARY KEY,initialized boolean NOT NULL DEFAULT false);
          CREATE TABLE IF NOT EXISTS compute.stream_partition(name text NOT NULL,key text NOT NULL,input_version text NOT NULL,inputs jsonb NOT NULL,outputs jsonb NOT NULL,capture_id text NOT NULL,PRIMARY KEY(name,key));
          CREATE TABLE IF NOT EXISTS compute.stream_partition_chunk(name text NOT NULL,key text NOT NULL,rel text NOT NULL,seq integer NOT NULL,rows jsonb NOT NULL,PRIMARY KEY(name,key,rel,seq),FOREIGN KEY(name,key) REFERENCES compute.stream_partition(name,key) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS compute.stream_owner(name text NOT NULL,sink text NOT NULL,id text NOT NULL,partition text NOT NULL,PRIMARY KEY(name,sink,id));
          CREATE INDEX IF NOT EXISTS stream_owner_partition ON compute.stream_owner(name,partition);
          ALTER TABLE compute.stream_partition ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT true;
          CREATE INDEX IF NOT EXISTS stream_partition_dirty ON compute.stream_partition(name,key) WHERE dirty;
          ALTER TABLE compute.stream_state ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '';
          ALTER TABLE compute.stream_state ADD COLUMN IF NOT EXISTS last_capture_id text NOT NULL DEFAULT ''`,
        );
        await client.query(
          "INSERT INTO compute.stream_state(name) VALUES($1) ON CONFLICT DO NOTHING",
          [computation.name],
        );
        const changed = await client.query(
          "UPDATE compute.stream_state SET version=$2,initialized=false,last_capture_id='' WHERE name=$1 AND version<>$2 RETURNING name",
          [computation.name, version],
        );
        if (changed.rowCount) {
          await client.query(
            "UPDATE compute.stream_partition SET dirty=true WHERE name=$1",
            [computation.name],
          );
        }
        await client.query(
          `CREATE OR REPLACE FUNCTION compute.repair_sink() RETURNS trigger
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $repair$
          DECLARE affected boolean := false;
          BEGIN
            IF TG_OP='UPDATE' THEN
              IF OLD.id IS DISTINCT FROM NEW.id AND EXISTS(SELECT FROM compute.stream_owner
                WHERE name=TG_ARGV[0] AND sink=TG_TABLE_NAME AND id=OLD.id::text) THEN
                RAISE EXCEPTION 'derived sink identities are immutable';
              END IF;
            END IF;
            IF TG_OP='TRUNCATE' THEN
              UPDATE compute.stream_partition p SET dirty=true FROM compute.stream_owner o
                WHERE o.name=TG_ARGV[0] AND o.sink=TG_TABLE_NAME AND p.name=o.name AND p.key=o.partition;
              affected := FOUND;
            ELSE
              IF TG_OP<>'INSERT' THEN
                UPDATE compute.stream_partition p SET dirty=true FROM compute.stream_owner o
                  WHERE o.name=TG_ARGV[0] AND o.sink=TG_TABLE_NAME AND o.id=OLD.id::text AND p.name=o.name AND p.key=o.partition;
                affected := FOUND;
              END IF;
              IF TG_OP<>'DELETE' THEN
                UPDATE compute.stream_partition p SET dirty=true FROM compute.stream_owner o
                  WHERE o.name=TG_ARGV[0] AND o.sink=TG_TABLE_NAME AND o.id=NEW.id::text AND p.name=o.name AND p.key=o.partition;
                affected := affected OR FOUND;
              END IF;
            END IF;
            IF affected THEN
              PERFORM pg_notify('compute_native_ready', TG_ARGV[0]);
            END IF;
            RETURN NULL;
          END $repair$;
          REVOKE ALL ON FUNCTION compute.repair_sink() FROM PUBLIC`,
        );
        for (const sink of computation.to) {
          const table = `public.${sqlIdentifier(sink)}`;
          const owner = computation.name.replaceAll("'", "''");
          await client.query(
            `DROP TRIGGER IF EXISTS duckstream_repair ON ${table};
            CREATE TRIGGER duckstream_repair AFTER INSERT OR UPDATE OR DELETE ON ${table}
              FOR EACH ROW EXECUTE FUNCTION compute.repair_sink('${owner}');
            DROP TRIGGER IF EXISTS duckstream_repair_truncate ON ${table};
            CREATE TRIGGER duckstream_repair_truncate AFTER TRUNCATE ON ${table}
              FOR EACH STATEMENT EXECUTE FUNCTION compute.repair_sink('${owner}')`,
          );
        }
        await installSources(client, program, version, computation.name);
      },
      writesCapture: true,
      prepareCapture: async () => {
        await this.ready.promise;
        this.busy = true;
        try {
          const delta = await this.engine.capture();
          this.failure = undefined;
          return delta;
        } catch (error) {
          this.busy = false;
          this.failure = { error };
          this.onReady?.();
          throw error;
        }
      },
      abortCapture: () => {
        this.busy = false;
        this.onReady?.();
      },
      capture: async (client, prepared) => {
        if (!client) {
          throw new Error("native capture requires coordinator transaction");
        }
        await this.ready.promise;
        this.busy = true;
        const delta = (prepared as DeltaStep | undefined) ??
          await this.engine.capture();
        const keys = new Set(
          Object.values(delta).flatMap((rows) =>
            rows.map(({ row }) => {
              if (typeof row.__partition !== "string") {
                throw new Error("missing native partition");
              }
              return row.__partition;
            })
          ),
        );
        const { rows: obsolete } = await client.query(
          "SELECT key FROM compute.stream_partition WHERE name=$1 AND dirty",
          [computation.name],
        );
        for (const row of obsolete) keys.add(row.key);
        const { rows: [state] } = await client.query(
          "SELECT initialized FROM compute.stream_state WHERE name=$1",
          [computation.name],
        );
        if (!state.initialized && keys.size === 0) keys.add("");
        const prior = await this.loadPartitions(client, [...keys]);
        const store = new DeltaStore(
          Object.fromEntries(this.names.map((name) => [name, "__partition"])),
        );
        store.bootstrap(
          Object.fromEntries(this.names.map((name) => [
            name,
            prior.filter((r) => r.input_version === version).flatMap((r) =>
              r.inputs[name] ?? []
            ),
          ])),
        );
        const changed = store.apply(delta);
        keys.clear();
        for (const key of changed.keys) keys.add(key);
        for (const row of obsolete) keys.add(row.key);
        if (!state.initialized && keys.size === 0) keys.add("");
        const id = crypto.randomUUID();
        const sortedKeys = [...keys].sort();
        if (this.steps && sortedKeys.some((key) => key !== "")) {
          throw new Error(
            "bounded step computations require global partitioning",
          );
        }
        const partInputs = new Map<string, Relations>();
        const serializedPayloads: string[] = [];
        const chunkedKeys: string[] = [];
        let totalCapturedRows = 0;
        for (const key of sortedKeys) {
          const inputs = store.capture(key) as Relations;
          if (computation.normalizeRisingWaveInputs) {
            const empty = Object.fromEntries(
              this.names.map((name) => [name, [] as Row[]]),
            );
            for (const [name, rows] of Object.entries(inputs)) {
              for (
                let offset = 0;
                offset < rows.length;
                offset += CHUNK_ROW_THRESHOLD
              ) {
                const slice = rows.slice(offset, offset + CHUNK_ROW_THRESHOLD)
                  .map(({ __partition: _, ...row }) => row);
                computation.normalizeRisingWaveInputs(
                  { ...empty, [name]: slice },
                  program,
                );
              }
            }
          }
          partInputs.set(key, inputs);
          const rowCount = Object.values(inputs).reduce(
            (sum, rows) => sum + rows.length,
            0,
          );
          totalCapturedRows += rowCount;
          if (rowCount > CHUNK_ROW_THRESHOLD) {
            serializedPayloads.push('{"__chunked":true}');
            chunkedKeys.push(key);
          } else {
            serializedPayloads.push(JSON.stringify(inputs));
          }
        }
        if (sortedKeys.length > 0) {
          await client.query(
            "DELETE FROM compute.stream_partition_chunk WHERE name=$1 AND key=ANY($2::text[])",
            [computation.name, sortedKeys],
          );
          for (
            let offset = 0;
            offset < sortedKeys.length;
            offset += PARTITION_UPSERT_BATCH
          ) {
            await client.query(
              `INSERT INTO compute.stream_partition(name,key,input_version,inputs,outputs,capture_id)
              SELECT $1,u.k,$3,u.i::jsonb,'{}'::jsonb,$5
              FROM unnest($2::text[],$4::text[]) AS u(k,i)
              ON CONFLICT(name,key) DO UPDATE
                SET input_version=EXCLUDED.input_version,inputs=EXCLUDED.inputs,capture_id=EXCLUDED.capture_id,dirty=true`,
              [
                computation.name,
                sortedKeys.slice(offset, offset + PARTITION_UPSERT_BATCH),
                version,
                serializedPayloads.slice(
                  offset,
                  offset + PARTITION_UPSERT_BATCH,
                ),
                id,
              ],
            );
          }
          for (const key of chunkedKeys) {
            const inputs = partInputs.get(key)!;
            for (const [rel, rows] of Object.entries(inputs)) {
              let seq = 0;
              for (
                let offset = 0;
                offset < rows.length;
                offset += CHUNK_ROW_THRESHOLD
              ) {
                await client.query(
                  "INSERT INTO compute.stream_partition_chunk(name,key,rel,seq,rows) VALUES($1,$2,$3,$4,$5::jsonb)",
                  [
                    computation.name,
                    key,
                    rel,
                    seq++,
                    JSON.stringify(rows.slice(offset, offset + CHUNK_ROW_THRESHOLD)),
                  ],
                );
              }
            }
          }
        }
        await client.query(
          "UPDATE compute.stream_state SET last_capture_id=$2 WHERE name=$1",
          [computation.name, id],
        );
        const deltaRows = Object.values(delta).reduce(
          (n, rows) => n + rows.length,
          0,
        );
        this.pendingDeltas.clear();
        this.pendingInputs.clear();
        this.pendingDeltas.set(id, delta);
        if (!this.steps && totalCapturedRows <= 50_000) {
          this.pendingInputs.set(id, partInputs);
        }
        return {
          id,
          keys: sortedKeys,
          initial: !state.initialized,
          deltaRows,
        } satisfies Capture;
      },
      captured: async (value) => {
        await this.ready.promise;
        const capture = value as Capture;
        const emptyDelta = Object.fromEntries(
          this.names.map((name) => [name, []]),
        ) as DeltaStep;
        await this.engine.acknowledge(
          capture.id,
          this.pendingDeltas.get(capture.id) ?? emptyDelta,
        );
        this.pendingDeltas.delete(capture.id);
        this.busy = false;
        this.first = false;
        console.log(
          JSON.stringify({
            computation: computation.name,
            capture: capture.id,
            partitions: capture.keys.length,
            deltaRows: capture.deltaRows,
          }),
        );
      },
      calculate: async (value) => {
        const capture = value as Capture;
        if (this.steps) {
          if (capture.keys.length === 0) {
            return { capture } satisfies StepsCalculated;
          }
          if (capture.keys.length !== 1 || capture.keys[0] !== "") {
            throw new Error(
              "bounded step computations require global partitioning",
            );
          }
          const boundedCapture = await this.steps.runtime.materializeCapture(
            capture.id,
            (rel) => this.streamRelationRows("", rel),
          );
          try {
            const bounded = await this.steps.runtime.calculate(boundedCapture);
            return { capture, bounded } satisfies StepsCalculated;
          } catch (error) {
            await this.steps.runtime.discardCapture(boundedCapture);
            throw error;
          }
        }
        const cached = this.pendingInputs.get(capture.id);
        const persistOutputs = capture.keys.length > CALCULATE_MANY_BATCH;
        const outputs: Record<string, Relations> = {};
        for (
          let offset = 0;
          offset < capture.keys.length;
          offset += CALCULATE_MANY_BATCH
        ) {
          const slice = capture.keys.slice(
            offset,
            offset + CALCULATE_MANY_BATCH,
          );
          const sliceMap = new Map<string, Relations>();
          const missing: string[] = [];
          for (const key of slice) {
            const hit = cached?.get(key);
            if (hit) {
              sliceMap.set(key, hit);
              cached!.delete(key);
            } else {
              missing.push(key);
            }
          }
          for (
            let i = 0;
            i < missing.length;
            i += PARTITION_UPSERT_BATCH
          ) {
            const loaded = await this.loadPartitions(
              this.db,
              missing.slice(i, i + PARTITION_UPSERT_BATCH),
            );
            for (const row of loaded) sliceMap.set(row.key, row.inputs);
          }
          const prepared: [string, Relations][] = [];
          for (const key of slice) {
            const partInput = sliceMap.get(key);
            if (!partInput) {
              throw new Error(`missing retained native partition ${key}`);
            }
            const rawInputs = Object.fromEntries(
              Object.entries(partInput).map((
                [name, rows],
              ) => [name, rows.map(({ __partition: _, ...row }) => row)]),
            );
            const inputs = computation.normalizeRisingWaveInputs
              ? computation.normalizeRisingWaveInputs(rawInputs, program)
              : rawInputs;
            prepared.push([key, inputs]);
          }
          const batchOut: Record<string, Relations> = computation.calculateMany
            ? await computation.calculateMany(prepared) as Record<
              string,
              Relations
            >
            : {};
          if (!computation.calculateMany) {
            for (const [key, inputs] of prepared) {
              batchOut[key] = await computation.calculate(inputs) as Relations;
            }
          }
          if (persistOutputs) {
            for (
              let i = 0;
              i < slice.length;
              i += PARTITION_UPSERT_BATCH
            ) {
              const keysPart = slice.slice(i, i + PARTITION_UPSERT_BATCH);
              await this.db.query(
                `UPDATE compute.stream_partition AS p
                SET outputs=u.o::jsonb
                FROM unnest($2::text[],$3::text[]) AS u(k,o)
                WHERE p.name=$1 AND p.key=u.k`,
                [
                  computation.name,
                  keysPart,
                  keysPart.map((k) => strictJson(batchOut[k] ?? {})),
                ],
              );
            }
          } else {
            Object.assign(outputs, batchOut);
          }
        }
        return {
          capture,
          outputs,
          ...(persistOutputs ? { persisted: true } : {}),
        } satisfies Calculated;
      },
      ...(this.steps
        ? {
          stage: async (client, value) => {
            const { bounded } = value as StepsCalculated;
            if (!bounded) {
              return {
                publish: () => Promise.resolve(),
                close: () => Promise.resolve(),
              };
            }
            const staged = await stagePages(
              client,
              computation,
              (sink) => this.steps!.runtime.pages(bounded, sink),
            );
            return {
              publish: async (tx) => {
                for (const sink of computation.to) {
                  const stage = `pg_temp.${
                    sqlIdentifier(staged.stages.get(sink)!.name)
                  }`;
                  await tx.query(
                    `DELETE FROM compute.stream_owner o
                    WHERE o.name=$1 AND o.sink=$2 AND o.partition=''
                      AND NOT EXISTS (SELECT 1 FROM ${stage} s WHERE s.id::text=o.id)`,
                    [computation.name, sink],
                  );
                  await tx.query(
                    `INSERT INTO compute.stream_owner(name,sink,id,partition)
                    SELECT $1,$2,s.id::text,'' FROM ${stage} s
                    ON CONFLICT(name,sink,id) DO UPDATE SET partition=EXCLUDED.partition`,
                    [computation.name, sink],
                  );
                }
                const sinks = await publishStagedPages(
                  tx,
                  computation,
                  staged,
                  claims,
                );
                await tx.query(
                  "UPDATE compute.stream_partition SET dirty=false WHERE name=$1 AND key=''",
                  [computation.name],
                );
                await tx.query(
                  "UPDATE compute.stream_state SET initialized=true WHERE name=$1",
                  [computation.name],
                );
                return () =>
                  console.log(
                    JSON.stringify({ computation: computation.name, sinks }),
                  );
              },
              close: () => dropStagedPages(client, staged),
            };
          },
          release: async (_inputs, value) => {
            const { bounded } = value as StepsCalculated;
            if (bounded) {
              await this.steps!.runtime.release(bounded.capture, bounded);
            }
          },
          discard: async (value) => {
            const { bounded } = value as StepsCalculated;
            if (bounded) {
              await this.steps!.runtime.release(bounded.capture, bounded);
            }
          },
        }
        : {}),
      publish: async (client, value) => {
        const { capture, outputs, persisted } = value as Calculated;
        if (capture.keys.length === 0) {
          this.pendingInputs.delete(capture.id);
          return;
        }
        if (persisted) {
          const removedTable = `removed_${
            crypto.randomUUID().replaceAll("-", "")
          }`;
          if (capture.initial) {
            await client.query(
              "DELETE FROM compute.stream_owner WHERE name=$1",
              [computation.name],
            );
          } else {
            await client.query(
              `CREATE TEMP TABLE ${
                sqlIdentifier(removedTable)
              }(sink text NOT NULL,id text NOT NULL) ON COMMIT DROP`,
            );
            await client.query(
              `WITH d AS (
                DELETE FROM compute.stream_owner
                WHERE name=$1 AND partition=ANY($2::text[])
                RETURNING sink,id
              ) INSERT INTO pg_temp.${
                sqlIdentifier(removedTable)
              }(sink,id) SELECT sink,id FROM d`,
              [computation.name, capture.keys],
            );
          }
          const slicePublication: Publication = {
            ...computation,
            sinkWrites: Object.fromEntries(
              computation.to.map((sink) => [sink, "upsert" as const]),
            ),
            onComplete: undefined,
          };
          for (const sink of computation.to) {
            for (
              let offset = 0;
              offset < capture.keys.length;
              offset += CALCULATE_MANY_BATCH
            ) {
              const sliceKeys = capture.keys.slice(
                offset,
                offset + CALCULATE_MANY_BATCH,
              );
              const { rows: partRows } = await client.query<{
                key: string;
                rows: Row[] | null;
                present: boolean;
              }>(
                "SELECT key,outputs->$3 AS rows,outputs ? $3 AS present FROM compute.stream_partition WHERE name=$1 AND key=ANY($2::text[])",
                [computation.name, sliceKeys, sink],
              );
              const byKey = new Map(partRows.map((r) => [r.key, r]));
              const upserts: Row[] = [];
              const ownerRecs: string[] = [];
              const ownerParts: string[] = [];
              const seenIds = new Set<unknown>();
              for (const key of sliceKeys) {
                const entry = byKey.get(key);
                if (!entry?.present || !Array.isArray(entry.rows)) {
                  throw new Error(`missing partition sink ${sink}`);
                }
                for (const row of entry.rows) {
                  if (seenIds.has(row.id)) {
                    throw new Error(`overlapping partition ownership: ${sink}`);
                  }
                  seenIds.add(row.id);
                  upserts.push(row);
                  ownerRecs.push(JSON.stringify({ id: row.id }));
                  ownerParts.push(key);
                }
              }
              for (
                let i = 0;
                i < ownerRecs.length;
                i += OWNER_INSERT_BATCH
              ) {
                try {
                  await client.query(
                    `INSERT INTO compute.stream_owner(name,sink,id,partition)
                    SELECT $1,$2,(jsonb_populate_record(NULL::public.${
                      sqlIdentifier(sink)
                    },u.rec::jsonb)).id::text,u.part
                    FROM unnest($3::text[],$4::text[]) AS u(rec,part)`,
                    [
                      computation.name,
                      sink,
                      ownerRecs.slice(i, i + OWNER_INSERT_BATCH),
                      ownerParts.slice(i, i + OWNER_INSERT_BATCH),
                    ],
                  );
                } catch (error) {
                  if (
                    error instanceof pg.DatabaseError && error.code === "23505"
                  ) {
                    throw new Error(`overlapping partition ownership: ${sink}`);
                  }
                  throw error;
                }
              }
              const sliceDelta: Delta = Object.fromEntries(
                computation.to.map((name) => [
                  name,
                  { upserts: name === sink ? upserts : [], deletes: [] },
                ]),
              );
              await publishDelta(client, slicePublication, sliceDelta, claims);
            }
          }
          for (
            let offset = 0;
            offset < capture.keys.length;
            offset += CALCULATE_MANY_BATCH
          ) {
            await client.query(
              "UPDATE compute.stream_partition SET outputs='{}'::jsonb,dirty=false WHERE name=$1 AND key=ANY($2::text[])",
              [
                computation.name,
                capture.keys.slice(offset, offset + CALCULATE_MANY_BATCH),
              ],
            );
          }
          const finalDelta: Delta = {};
          for (const sink of computation.to) {
            let deletes: string[] = [];
            if (computation.sinkWrites?.[sink] !== "upsert") {
              const { rows } = capture.initial
                ? await client.query<{ id: string }>(
                  `SELECT s.id::text AS id FROM public.${
                    sqlIdentifier(sink)
                  } s
                  WHERE NOT EXISTS (
                    SELECT 1 FROM compute.stream_owner o
                    WHERE o.name=$1 AND o.sink=$2 AND o.id=s.id::text
                  )`,
                  [computation.name, sink],
                )
                : await client.query<{ id: string }>(
                  `SELECT r.id FROM pg_temp.${
                    sqlIdentifier(removedTable)
                  } r
                  WHERE r.sink=$2 AND NOT EXISTS (
                    SELECT 1 FROM compute.stream_owner o
                    WHERE o.name=$1 AND o.sink=$2 AND o.id=r.id
                  )`,
                  [computation.name, sink],
                );
              deletes = rows.map((r) => r.id);
            }
            finalDelta[sink] = { upserts: [], deletes };
          }
          await publishDelta(client, computation, finalDelta, claims);
          await client.query(
            "UPDATE compute.stream_state SET initialized=true WHERE name=$1",
            [computation.name],
          );
          this.pendingInputs.delete(capture.id);
          return;
        }
        const next = this.emptySinks();
        const previousIds = Object.fromEntries(
          computation.to.map((sink) => [sink, [] as string[]]),
        );
        const insertedIds = Object.fromEntries(
          computation.to.map((sink) => [sink, new Set<string>()]),
        );
        const { rows: removedOwners } = await client.query<{
          sink: string;
          id: string;
        }>(
          "DELETE FROM compute.stream_owner WHERE name=$1 AND partition=ANY($2::text[]) RETURNING sink,id",
          [computation.name, capture.keys],
        );
        for (const owner of removedOwners) {
          previousIds[owner.sink]?.push(owner.id);
        }
        for (const sink of computation.to) {
          const ownerRecs: string[] = [];
          const ownerParts: string[] = [];
          for (const key of capture.keys) {
            const partOutput = outputs[key];
            const rows = partOutput?.[sink];
            if (!Array.isArray(rows)) {
              throw new Error(`missing partition sink ${sink}`);
            }
            for (const row of rows) {
              next[sink].push(row);
              ownerRecs.push(JSON.stringify({ id: row.id }));
              ownerParts.push(key);
            }
          }
          for (
            let offset = 0;
            offset < ownerRecs.length;
            offset += OWNER_INSERT_BATCH
          ) {
            const { rows: owned } = await client.query<{ id: string }>(
              `INSERT INTO compute.stream_owner(name,sink,id,partition)
              SELECT $1,$2,(jsonb_populate_record(NULL::public.${
                sqlIdentifier(sink)
              },u.rec::jsonb)).id::text,u.part
              FROM unnest($3::text[],$4::text[]) AS u(rec,part)
              RETURNING id`,
              [
                computation.name,
                sink,
                ownerRecs.slice(offset, offset + OWNER_INSERT_BATCH),
                ownerParts.slice(offset, offset + OWNER_INSERT_BATCH),
              ],
            );
            for (const row of owned) insertedIds[sink].add(row.id);
          }
        }
        if (capture.initial) await publish(client, computation, next, claims);
        else {
          const delta: Delta = {};
          for (const sink of computation.to) {
            const current = new Map(next[sink].map((row) => [row.id, row]));
            if (current.size !== next[sink].length) {
              throw new Error(`overlapping partition ownership: ${sink}`);
            }
            delta[sink] = {
              upserts: next[sink],
              deletes: previousIds[sink].filter((id) =>
                !insertedIds[sink].has(id)
              ),
            };
          }
          await publishDelta(client, computation, delta, claims);
        }
        await client.query(
          "UPDATE compute.stream_partition SET dirty=false WHERE name=$1 AND key=ANY($2::text[])",
          [computation.name, capture.keys],
        );
        await client.query(
          "UPDATE compute.stream_state SET initialized=true WHERE name=$1",
          [computation.name],
        );
        this.pendingInputs.delete(capture.id);
      },
    };
    const release = this.spec.release;
    this.spec.release = async (inputs, output) => {
      try {
        await release?.(inputs, output);
      } finally {
        this.onReady?.();
      }
    };
    const capture = this.spec.capture;
    this.spec.capture = async (client, prepared) => {
      try {
        const result = await capture(client, prepared);
        this.failure = undefined;
        return result;
      } catch (error) {
        if (prepared === undefined) this.busy = false;
        // The coordinator retries capture transactions before releasing their prepared delta.
        if (!(error instanceof pg.DatabaseError) || !["40001", "40P01"].includes(error.code ?? "")) {
          this.failure = { error };
          this.onReady?.();
        }
        throw error;
      }
    };
    const captured = this.spec.captured!;
    this.spec.captured = async (inputs) => {
      try {
        await captured(inputs);
      } catch (error) {
        this.failure = { error };
        this.onReady?.();
        throw error;
      } finally {
        this.busy = false;
      }
    };
  }
  private emptySinks(): Relations {
    return Object.fromEntries(this.computation.to.map((name) => [name, []]));
  }
  private async loadPartitions(
    db: { query: pg.Pool["query"] },
    keys?: string[],
    matchingVersion?: string,
  ): Promise<{
    key: string;
    input_version: string;
    inputs: Relations;
    capture_id: string;
  }[]> {
    if (keys && keys.length === 0) return [];
    const { rows } = keys
      ? await db.query<{
        key: string;
        input_version: string;
        inputs: Record<string, unknown>;
        capture_id: string;
      }>(
        "SELECT key,input_version,inputs,capture_id FROM compute.stream_partition WHERE name=$1 AND key=ANY($2::text[])",
        [this.computation.name, keys],
      )
      : await db.query<{
        key: string;
        input_version: string;
        inputs: Record<string, unknown>;
        capture_id: string;
      }>(
        "SELECT key,input_version,inputs,capture_id FROM compute.stream_partition WHERE name=$1 AND input_version=$2",
        [this.computation.name, matchingVersion!],
      );
    const chunkedKeys = rows.filter((r) => r.inputs.__chunked === true).map(
      (r) => r.key,
    );
    const byChunkKey = new Map<string, Relations>();
    if (chunkedKeys.length > 0) {
      for (const key of chunkedKeys) {
        byChunkKey.set(
          key,
          Object.fromEntries(this.names.map((name) => [name, [] as Row[]])),
        );
      }
      const { rows: chunks } = await db.query<{
        key: string;
        rel: string;
        rows: Row[];
      }>(
        "SELECT key,rel,rows FROM compute.stream_partition_chunk WHERE name=$1 AND key=ANY($2::text[]) ORDER BY key,rel,seq",
        [this.computation.name, chunkedKeys],
      );
      for (const chunk of chunks) {
        const target = byChunkKey.get(chunk.key)?.[chunk.rel];
        if (target) target.push(...chunk.rows);
      }
    }
    return rows.map((row) => ({
      key: row.key,
      input_version: row.input_version,
      inputs: byChunkKey.get(row.key) ?? (row.inputs as Relations),
      capture_id: row.capture_id,
    }));
  }
  private async *streamRelationRows(
    key: string,
    rel: string,
  ): AsyncGenerator<Row[]> {
    const { rows: [part] } = await this.db.query<{
      inputs: Record<string, unknown>;
    }>(
      "SELECT inputs FROM compute.stream_partition WHERE name=$1 AND key=$2",
      [this.computation.name, key],
    );
    if (!part) throw new Error(`missing retained native partition ${key}`);
    const empty = Object.fromEntries(
      this.names.map((name) => [name, [] as Row[]]),
    );
    const normalizeBatch = (batch: Row[]): Row[] => {
      const stripped = batch.map(({ __partition: _, ...row }) => row);
      if (!this.computation.normalizeRisingWaveInputs) return stripped;
      return this.computation.normalizeRisingWaveInputs(
        { ...empty, [rel]: stripped },
        this.program,
      )[rel];
    };
    if (part.inputs.__chunked !== true) {
      const batch = (part.inputs as Relations)[rel] ?? [];
      if (batch.length > 0) yield normalizeBatch(batch);
      return;
    }
    let afterSeq = -1;
    for (;;) {
      const { rows: chunks } = await this.db.query<{
        seq: number;
        rows: Row[];
      }>(
        "SELECT seq,rows FROM compute.stream_partition_chunk WHERE name=$1 AND key=$2 AND rel=$3 AND seq>$4 ORDER BY seq LIMIT 8",
        [this.computation.name, key, rel, afterSeq],
      );
      if (chunks.length === 0) break;
      for (const chunk of chunks) {
        afterSeq = chunk.seq;
        if (chunk.rows.length > 0) yield normalizeBatch(chunk.rows);
      }
    }
  }
  async initialize() {
    if (this.steps) await collectBoundedFiles(this.steps.directory, []);
    await this.db.query(
      "UPDATE compute.stream_partition SET dirty=true WHERE name=$1 AND input_version<>$2",
      [this.computation.name, this.version],
    );
    const { rows: [state] } = await this.db.query<{
      initialized: boolean;
      version: string;
      last_capture_id: string;
    }>(
      "SELECT initialized, version, last_capture_id FROM compute.stream_state WHERE name=$1",
      [this.computation.name],
    );
    const lastCaptureId = state?.version === this.version
      ? (state.last_capture_id ?? "")
      : "";
    if (
      state?.version === this.version &&
      await this.engine.tryAttach(this.db, lastCaptureId)
    ) {
      this.ready.resolve();
      return;
    }
    const rows = await this.loadPartitions(this.db, undefined, this.version);
    const baseline = Object.fromEntries(
      this.names.map((name) => [
        name,
        rows.flatMap((row) => row.inputs[name] ?? []),
      ]),
    );
    await this.engine.initialize(
      this.db,
      baseline,
      rows.map((r) => r.capture_id),
      lastCaptureId,
    );
    this.ready.resolve();
  }
  async close() { await this.engine.close(); }
  async check() {
    if (this.failure) throw this.failure.error;
    await this.engine.check();
  }
  async pending() {
    if (this.failure) throw this.failure.error;
    if (this.busy || this.first) await this.engine.check();
    if (this.busy) return false;
    if (this.first || await this.engine.pending()) return true;
    const { rows } = await this.db.query(
      `SELECT 1 FROM compute.stream_partition WHERE name=$1 AND dirty
      AND NOT EXISTS(SELECT FROM compute.batch WHERE name=$1 AND claimed IS NOT NULL) LIMIT 1`,
      [this.computation.name],
    );
    return rows.length !== 0;
  }
}
