import pg from "pg";
import { type BatchSpec, computationGraph } from "./batches.ts";
import { type DeltaStep, DeltaStore } from "./deltas.ts";
import { type CompilationProfile, NativeFeldera } from "./native-feldera.ts";
import {
  type IncrementalProgram,
  installSources,
  sqlIdentifier,
} from "./native-sources.ts";
import {
  type Delta,
  type Publication,
  publish,
  publishDelta,
} from "./publication.ts";

type Row = Record<string, unknown>;
type Relations = Record<string, Row[]>;
type Part = {
  key: string;
  inputs: Relations;
  previous: Relations;
  output?: Relations;
};
type Capture = {
  id: string;
  delta: DeltaStep;
  parts: Part[];
  initial: boolean;
};
type Computation = Publication & {
  calculate(input: unknown): Promise<unknown>;
};

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

  readonly engine: NativeFeldera;
  readonly spec: BatchSpec;
  private readonly ready = Promise.withResolvers<void>();
  private busy = false;
  private failure: { error: unknown } | undefined;
  private first = true;
  private readonly names: string[];
  constructor(
    private readonly db: pg.Pool,
    endpoint: string,
    private readonly computation: Computation,
    private readonly program: IncrementalProgram,
    private readonly version: string,
    uri: string,
    claims: Parameters<typeof publish>[3],
    profile: CompilationProfile = "optimized",
  ) {
    this.names = Object.keys(program.outputs);
    this.engine = new NativeFeldera(
      endpoint,
      computation.name,
      program,
      version,
      uri,
      profile,
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
          CREATE TABLE IF NOT EXISTS compute.stream_owner(name text NOT NULL,sink text NOT NULL,id text NOT NULL,partition text NOT NULL,PRIMARY KEY(name,sink,id));
          CREATE INDEX IF NOT EXISTS stream_owner_partition ON compute.stream_owner(name,partition);
          ALTER TABLE compute.stream_partition ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT true;
          CREATE INDEX IF NOT EXISTS stream_partition_dirty ON compute.stream_partition(name,key) WHERE dirty;
          ALTER TABLE compute.stream_state ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT ''`,
        );
        await client.query(
          "INSERT INTO compute.stream_state(name) VALUES($1) ON CONFLICT DO NOTHING",
          [computation.name],
        );
        const changed = await client.query(
          "UPDATE compute.stream_state SET version=$2,initialized=false WHERE name=$1 AND version<>$2 RETURNING name",
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
            ELSE
              IF TG_OP<>'INSERT' THEN
                UPDATE compute.stream_partition p SET dirty=true FROM compute.stream_owner o
                  WHERE o.name=TG_ARGV[0] AND o.sink=TG_TABLE_NAME AND o.id=OLD.id::text AND p.name=o.name AND p.key=o.partition;
              END IF;
              IF TG_OP<>'DELETE' THEN
                UPDATE compute.stream_partition p SET dirty=true FROM compute.stream_owner o
                  WHERE o.name=TG_ARGV[0] AND o.sink=TG_TABLE_NAME AND o.id=NEW.id::text AND p.name=o.name AND p.key=o.partition;
              END IF;
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
      capture: async (client) => {
        if (!client) {
          throw new Error("native capture requires coordinator transaction");
        }
        await this.ready.promise;
        this.busy = true;
        const delta = await this.engine.capture();
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
        const { rows: prior } = await client.query(
          "SELECT * FROM compute.stream_partition WHERE name=$1 AND key=ANY($2::text[])",
          [computation.name, [...keys]],
        );
        const old = new Map(prior.map((row) => [row.key, row]));
        const store = new DeltaStore(
          Object.fromEntries(this.names.map((name) => [name, "__partition"])),
        );
        store.bootstrap(
          Object.fromEntries(this.names.map((name) => [
            name,
            prior.filter((r) => r.input_version === version).flatMap((r) =>
              r.inputs[name]
            ),
          ])),
        );
        const changed = store.apply(delta);
        keys.clear();
        for (const key of changed.keys) keys.add(key);
        for (const row of obsolete) keys.add(row.key);
        if (!state.initialized && keys.size === 0) keys.add("");
        const id = crypto.randomUUID();
        const parts: Part[] = [];
        for (const key of [...keys].sort()) {
          const inputs = store.capture(key) as Relations;
          const previous = old.get(key)?.outputs ?? this.emptySinks();
          parts.push({ key, inputs, previous });
          await client.query(
            `INSERT INTO compute.stream_partition(name,key,input_version,inputs,outputs,capture_id) VALUES($1,$2,$3,$4,$5,$6)
            ON CONFLICT(name,key) DO UPDATE SET input_version=EXCLUDED.input_version,inputs=EXCLUDED.inputs,capture_id=EXCLUDED.capture_id,dirty=true`,
            [
              computation.name,
              key,
              version,
              JSON.stringify(inputs),
              JSON.stringify(previous),
              id,
            ],
          );
        }
        return {
          id,
          delta,
          parts,
          initial: !state.initialized,
        } satisfies Capture;
      },
      captured: async (value) => {
        await this.ready.promise;
        const capture = value as Capture;
        await this.engine.acknowledge(capture.id, capture.delta);
        this.busy = false;
        this.first = false;
        console.log(
          JSON.stringify({
            computation: computation.name,
            capture: capture.id,
            partitions: capture.parts.length,
            deltaRows: Object.values(capture.delta).reduce(
              (n, rows) => n + rows.length,
              0,
            ),
          }),
        );
      },
      calculate: async (value) => {
        const capture = value as Capture;
        for (const part of capture.parts) {
          const inputs = Object.fromEntries(
            Object.entries(part.inputs).map((
              [name, rows],
            ) => [name, rows.map(({ __partition: _, ...row }) => row)]),
          );
          part.output = await computation.calculate(inputs) as Relations;
        }
        return capture;
      },
      publish: async (client, value) => {
        const capture = value as Capture;
        if (capture.parts.length === 0) return;
        const next = this.emptySinks();
        const previous = this.emptySinks();
        await client.query(
          "DELETE FROM compute.stream_owner WHERE name=$1 AND partition=ANY($2::text[])",
          [computation.name, capture.parts.map((p) => p.key)],
        );
        for (const part of capture.parts) {
          for (const sink of computation.to) {
            const rows = part.output![sink];
            if (!Array.isArray(rows)) {
              throw new Error(`missing partition sink ${sink}`);
            }
            next[sink].push(...rows);
            previous[sink].push(...part.previous[sink]);
            for (let offset = 0; offset < rows.length; offset += 500) {
              await client.query(
                `INSERT INTO compute.stream_owner(name,sink,id,partition)
                SELECT $1,$2,row.id::text,$3 FROM jsonb_populate_recordset(NULL::public.${
                  sqlIdentifier(sink)
                },$4::jsonb) row`,
                [
                  computation.name,
                  sink,
                  part.key,
                  JSON.stringify(
                    rows.slice(offset, offset + 500).map((r) => ({ id: r.id })),
                  ),
                ],
              );
            }
          }
          await client.query(
            "UPDATE compute.stream_partition SET outputs=$3::jsonb WHERE name=$1 AND key=$2",
            [computation.name, part.key, JSON.stringify(part.output)],
          );
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
              deletes: previous[sink].filter((row) => !current.has(row.id)).map(
                (row) => String(row.id),
              ),
            };
          }
          await publishDelta(client, computation, delta, claims);
        }
        await client.query(
          "UPDATE compute.stream_partition SET dirty=false WHERE name=$1 AND key=ANY($2::text[])",
          [computation.name, capture.parts.map((p) => p.key)],
        );
        await client.query(
          "UPDATE compute.stream_state SET initialized=true WHERE name=$1",
          [computation.name],
        );
      },
    };
    const capture = this.spec.capture;
    this.spec.capture = async (client) => {
      try {
        const result = await capture(client);
        this.failure = undefined;
        return result;
      } catch (error) {
        this.failure = { error };
        throw error;
      }
    };
    const captured = this.spec.captured!;
    this.spec.captured = async (inputs) => {
      try {
        await captured(inputs);
      } catch (error) {
        this.failure = { error };
        throw error;
      }
    };
  }
  private emptySinks(): Relations {
    return Object.fromEntries(this.computation.to.map((name) => [name, []]));
  }
  async initialize() {
    await this.db.query(
      "UPDATE compute.stream_partition SET dirty=true WHERE name=$1 AND input_version<>$2",
      [this.computation.name, this.version],
    );
    const { rows } = await this.db.query(
      "SELECT inputs,capture_id FROM compute.stream_partition WHERE name=$1 AND input_version=$2",
      [this.computation.name, this.version],
    );
    const baseline = Object.fromEntries(
      this.names.map((name) => [name, rows.flatMap((row) => row.inputs[name])]),
    );
    await this.engine.initialize(
      this.db,
      baseline,
      rows.map((r) => r.capture_id),
    );
    this.ready.resolve();
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
