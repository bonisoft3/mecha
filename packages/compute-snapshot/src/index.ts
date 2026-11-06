import { initializeOutputs, collectOutputs, stageOutput, sealOutput as sealStagedOutput, publishOutput, type OutputSeal } from './staged-publication.ts';
import { type SinkWrites, validateSinkWrites } from './sink-writes.ts';
export type { OutputSeal } from './staged-publication.ts';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
export interface BatchState {
  phase: 'idle' | 'active'; name: string; requested: number; completed: number;
  wake: number; claimed: number; required: { name: string; revision: number }[];
  due: number; coalesce: number; attempts: number;
}
export interface BatchMachine {
  execute(input: unknown): Promise<{ kind?: string; state?: BatchState; reason?: string }> | { kind?: string; state?: BatchState; reason?: string };
}
export interface Computation {
  name: string;
  version: string;
  reads: string[];
  to: string[];
  sinkWrites?: SinkWrites;
  onComplete?: string;
  coalesceMs?: number;
  maxAttempts?: number;
}
export interface SnapshotTable {
  columns: { name: string; type: string }[];
  rows: Record<string, string | null>[];
}
export interface SnapshotIdentity {
  id: string;
  name: string;
  version: string;
  revision: number;
}
export interface Snapshot extends SnapshotIdentity {
  tables: Record<string, SnapshotTable>;
}
export interface SnapshotManifest extends SnapshotIdentity {
  tables: Record<string, { columns: SnapshotTable['columns']; rows: number }>;
}
export interface SnapshotChunk extends SnapshotIdentity {
  table: string;
  after: number;
  next: number;
  done: boolean;
  rows: SnapshotTable['rows'];
}
export interface ChunkLimits { maxRows?: number; maxBytes?: number }
export const CAPTURE_CHUNK_ROWS = 128;
export const CAPTURE_CHUNK_BYTES = 256 * 1024;
export const MATERIALIZE_BLOCKS = 256;
export type Output = Record<string, Record<string, unknown>[]>;
export interface CoordinatorConfig {
  db: Database;
  serialize<T>(fn: () => Promise<T>): Promise<T>;
  computations: Computation[];
  /** Retain a committed database image under the source serializer; retries must reuse the same image. */
  retainSnapshot?(identity: SnapshotIdentity): Promise<void>;
  machine: BatchMachine;
  execute?(snapshot: Snapshot): Promise<Output>;
  now?: () => number;
  retryDelayMs?: (attempt: number) => number;
}
export interface SnapshotCoordinator {
  claim(): Promise<SnapshotIdentity | null>;
  materialize(identity: SnapshotIdentity): Promise<boolean>;
  snapshot(identity: SnapshotIdentity): Promise<Snapshot>;
  manifest(identity: SnapshotIdentity): Promise<SnapshotManifest>;
  chunk(identity: SnapshotIdentity, table: string, after?: number, limits?: ChunkLimits): Promise<SnapshotChunk>;
  publish(snapshot: SnapshotIdentity, output: Output): Promise<void>;
  outputChunk(identity: SnapshotIdentity, attempt: string, sink: string, ordinal: number, rows: Record<string, unknown>[]): Promise<void>;
  sealOutput(identity: SnapshotIdentity, attempt: string, manifest: OutputSeal): Promise<void>;
  publishStaged(identity: SnapshotIdentity, attempt: string): Promise<void>;
  publication(identity: SnapshotIdentity): Promise<'pending' | 'published' | 'obsolete'>;
  reject(snapshot: SnapshotIdentity, error: string): Promise<void>;
  resume(): Promise<void>;
  wakeAt(): Promise<number | null>;
  stop(): Promise<void>;
}
export const NOTIFY_CHANNEL = 'compute_snapshot';
const PRIVATE = 'compute_snapshot_private';
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sqlString = (s: string) => `'${s.replaceAll("'", "''")}'`;
const table = (s: string) => `public.${q(s)}`;
function identifier(s: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`invalid compute identifier: ${s}`);
}
interface Stored { name: string; version: string; state: BatchState; failures: number; retry_at: number | null; error: string | null }
interface CaptureTable { source: string; relation: string; columns: SnapshotTable['columns']; rows: number }
interface CaptureProgress extends CaptureTable { source_oid: number; filenode: number; next_block: number; total_blocks: number }
const captured = (relation: string) => `${PRIVATE}.${q(relation)}`;
const transportSettings = `SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='iso_8601'; SET LOCAL bytea_output='hex';`;
function checkIdentity(identity: SnapshotIdentity) {
  if (!identity || typeof identity.id !== 'string' || !identity.id || typeof identity.name !== 'string' || !identity.name ||
    typeof identity.version !== 'string' || !identity.version || !Number.isSafeInteger(identity.revision) || identity.revision < 1) {
    throw new Error('invalid compute capture identity');
  }
}
interface Column { name: string; type: string; generated: boolean; required: boolean }
async function columns(tx: Queryable, name: string): Promise<Column[]> {
  const found = await tx.query<Column>(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    (a.attgenerated <> '' OR a.attidentity <> '') AS generated,
    (a.attnotnull AND NOT a.atthasdef AND a.attgenerated = '' AND a.attidentity = '') AS required
    FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table(name)]);
  if (!found.rows.length) throw new Error(`compute table ${name} has no columns`);
  return found.rows;
}
function ordered(specs: Computation[]) {
  const names = new Set<string>();
  const producers = new Map<string, Computation>();
  for (const spec of specs) {
    if (!spec.name || spec.name.length > 128 || names.has(spec.name)) throw new Error(`duplicate or invalid computation ${spec.name}`);
    names.add(spec.name);
    if (!spec.version || !spec.to.length) throw new Error(`computation ${spec.name} needs version and sinks`);
    validateSinkWrites(spec.to, spec.sinkWrites);
    if (!Number.isSafeInteger(spec.coalesceMs ?? 1000) || (spec.coalesceMs ?? 1000) < 0 ||
      !Number.isSafeInteger(spec.maxAttempts ?? 25) || (spec.maxAttempts ?? 25) < 1) throw new Error(`invalid scheduling for ${spec.name}`);
    for (const name of [...spec.reads, ...spec.to, ...(spec.onComplete ? [spec.onComplete] : [])]) identifier(name);
    if (new Set(spec.reads).size !== spec.reads.length) throw new Error(`duplicate reads: ${spec.name}`);
    for (const sink of spec.to) {
      if (producers.has(sink)) throw new Error(`multiple compute writers for ${sink}`);
      producers.set(sink, spec);
    }
  }
  const result: Computation[] = [];
  const visiting = new Set<string>();
  const visit = (spec: Computation) => {
    if (result.includes(spec)) return;
    if (visiting.has(spec.name)) throw new Error(`compute dependency cycle at ${spec.name}`);
    visiting.add(spec.name);
    for (const source of spec.reads) if (producers.has(source)) visit(producers.get(source)!);
    visiting.delete(spec.name);
    result.push(spec);
  };
  specs.forEach(visit);
  return { specs: result, producers };
}

export async function createSnapshotCoordinator(config: CoordinatorConfig): Promise<SnapshotCoordinator> {
  const { db, serialize, machine } = config;
  if (config.retainSnapshot && config.execute) throw new Error('external snapshots require an isolated executor');
  const { specs, producers } = ordered(config.computations);
  const now = config.now ?? Date.now;
  const retryDelay = config.retryDelayMs ?? ((attempt) => Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6)));
  const atomic = <T>(fn: (tx: Queryable) => Promise<T>) => serialize(() => db.transaction(fn));
  const context = () => ({ tier: 'mecha', actor: null, now: now() });
  async function reduce(state: BatchState, kind: string): Promise<BatchState> {
    const answer = await machine.execute({ state, event: { kind, payload: {} }, context: context(), viewers: [] });
    if (answer.kind !== 'accepted' || !answer.state) throw new Error(`compute ${kind} rejected: ${answer.reason}`);
    return answer.state;
  }
  async function save(tx: Queryable, item: Stored) {
    await tx.query(`UPDATE ${PRIVATE}.batches SET state=$2::jsonb, failures=$3, retry_at=$4, error=$5 WHERE name=$1`,
      [item.name, JSON.stringify(item.state), item.failures, item.retry_at, item.error]);
    await remember(tx, item.name, item.state.requested);
  }
  async function remember(tx: Queryable, name: string, revision: number) {
    await tx.query(`INSERT INTO ${PRIVATE}.revisions AS saved(name,revision) VALUES($1,$2)
      ON CONFLICT(name) DO UPDATE SET revision=EXCLUDED.revision WHERE saved.revision < EXCLUDED.revision`, [name, revision]);
  }
  async function load(tx: Queryable) {
    const { rows } = await tx.query<Stored>(`SELECT name,version,state,failures,retry_at::double precision,error FROM ${PRIVATE}.batches`);
    return new Map(rows.map(row => [row.name, row]));
  }
  async function releaseCaptures(tx: Queryable, condition: string, params: unknown[] = []) {
    const found = await tx.query<{ id: string }>(`SELECT id FROM ${PRIVATE}.captures WHERE ${condition}`, params);
    for (const { id } of found.rows) {
      const relations = await tx.query<{ relation: string }>(`SELECT relation FROM ${PRIVATE}.capture_tables WHERE capture_id=$1
        UNION SELECT relation FROM ${PRIVATE}.capture_progress WHERE capture_id=$1`, [id]);
      for (const { relation } of relations.rows) await tx.exec(`DROP TABLE ${captured(relation)}`);
      await tx.query(`DELETE FROM ${PRIVATE}.captures WHERE id=$1`, [id]);
    }
    await collectOutputs(tx);
  }
  async function retainTable(tx: Queryable, id: string, source: string, fields: SnapshotTable['columns'], select: string, params: unknown[] = []) {
    const relation = `capture_${crypto.randomUUID().replaceAll('-', '')}`;
    await tx.query(`CREATE TABLE ${captured(relation)} AS ${select}`, params);
    await tx.exec(`ALTER TABLE ${captured(relation)} ADD PRIMARY KEY (sequence)`);
    const count = (await tx.query<{ rows: number }>(`SELECT count(*)::double precision AS rows FROM ${captured(relation)}`)).rows[0].rows;
    if (!Number.isSafeInteger(count)) throw new Error('compute capture exceeds exact sequence range');
    await tx.query(`INSERT INTO ${PRIVATE}.capture_tables(capture_id,source,relation,columns,row_count) VALUES($1,$2,$3,$4::jsonb,$5)`,
      [id, source, relation, JSON.stringify(fields), count]);
  }
  await atomic(async tx => {
    const hadRevisions = (await tx.query<{ exists: boolean }>(`SELECT to_regclass('${PRIVATE}.revisions') IS NOT NULL AS exists`)).rows[0].exists;
    await tx.exec(`CREATE SCHEMA IF NOT EXISTS ${PRIVATE}; REVOKE ALL ON SCHEMA ${PRIVATE} FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.batches(name text PRIMARY KEY, version text NOT NULL, state jsonb NOT NULL,
        failures integer NOT NULL DEFAULT 0, retry_at bigint, error text);
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.inbox(table_name text PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.revisions(name text PRIMARY KEY, revision bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.captures(id text PRIMARY KEY, name text NOT NULL, version text NOT NULL, revision bigint NOT NULL, snapshot jsonb);
      ALTER TABLE ${PRIVATE}.captures ALTER COLUMN snapshot DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.capture_tables(capture_id text NOT NULL REFERENCES ${PRIVATE}.captures(id) ON DELETE CASCADE,
        source text NOT NULL, relation text NOT NULL UNIQUE, columns jsonb NOT NULL, row_count bigint NOT NULL,
        PRIMARY KEY(capture_id,source));
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.capture_progress(capture_id text NOT NULL REFERENCES ${PRIVATE}.captures(id) ON DELETE CASCADE,
        source text NOT NULL, relation text NOT NULL UNIQUE, columns jsonb NOT NULL,
        source_oid oid NOT NULL, filenode oid NOT NULL, next_block bigint NOT NULL DEFAULT 0,
        total_blocks bigint NOT NULL, row_count bigint NOT NULL DEFAULT 0,
        CHECK(next_block>=0 AND next_block<=total_blocks), CHECK(row_count>=0), PRIMARY KEY(capture_id,source));
      CREATE TABLE IF NOT EXISTS ${PRIVATE}.receipts(id text PRIMARY KEY, name text NOT NULL, version text NOT NULL, revision bigint NOT NULL, committed_at bigint NOT NULL);
      CREATE OR REPLACE FUNCTION ${PRIVATE}.changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          IF TG_OP <> 'TRUNCATE' THEN
            IF NOT EXISTS (SELECT 1 FROM changed_rows) THEN RETURN NULL; END IF;
          END IF;
          INSERT INTO ${PRIVATE}.inbox(table_name) VALUES (TG_TABLE_NAME) ON CONFLICT DO NOTHING;
          PERFORM pg_notify('${NOTIFY_CHANNEL}',TG_TABLE_NAME); RETURN NULL;
        END $$;
      REVOKE ALL ON FUNCTION ${PRIVATE}.changed() FROM PUBLIC;`);
    await initializeOutputs(tx);
    if (!hadRevisions) await tx.exec(`INSERT INTO ${PRIVATE}.revisions(name,revision)
      SELECT name,max(revision) FROM (
        SELECT name,(state->>'requested')::bigint AS revision FROM ${PRIVATE}.batches
        UNION ALL SELECT name,revision FROM ${PRIVATE}.captures
        UNION ALL SELECT name,revision FROM ${PRIVATE}.receipts
      ) prior GROUP BY name;`);
    const reads = [...new Set(specs.flatMap(s => s.reads))];
    const triggers = ['compute_snapshot_changed', 'compute_snapshot_inserted', 'compute_snapshot_updated', 'compute_snapshot_deleted', 'compute_snapshot_truncated'];
    const stale = await tx.query<{ name: string }>(`SELECT DISTINCT c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgname=ANY($1::text[])`, [triggers]);
    for (const name of new Set([...stale.rows.map(r => r.name), ...reads])) {
      await tx.exec(triggers.map(trigger => `DROP TRIGGER IF EXISTS ${q(trigger)} ON ${table(name)};`).join(''));
      if (reads.includes(name)) await tx.exec(`CREATE TRIGGER compute_snapshot_inserted AFTER INSERT ON ${table(name)}
        REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${PRIVATE}.changed();
        CREATE TRIGGER compute_snapshot_updated AFTER UPDATE ON ${table(name)}
        REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${PRIVATE}.changed();
        CREATE TRIGGER compute_snapshot_deleted AFTER DELETE ON ${table(name)}
        REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION ${PRIVATE}.changed();
        CREATE TRIGGER compute_snapshot_truncated AFTER TRUNCATE ON ${table(name)}
        FOR EACH STATEMENT EXECUTE FUNCTION ${PRIVATE}.changed();`);
    }
    const existing = await load(tx);
    const revisions = new Map((await tx.query<{ name: string; revision: number }>(`SELECT name,revision::double precision FROM ${PRIVATE}.revisions`)).rows.map(row => [row.name, row.revision]));
    await tx.query(`DELETE FROM ${PRIVATE}.batches WHERE NOT(name=ANY($1::text[]))`, [specs.map(s => s.name)]);
    for (const spec of specs) {
      const prior = existing.get(spec.name);
      if (prior?.version === spec.version) continue;
      const answer = await machine.execute({ initialize: true, payload: { name: spec.name, coalesce: spec.coalesceMs ?? 1000,
        attempts: spec.maxAttempts ?? 25, revision: Math.max(prior?.state.requested ?? 0, revisions.get(spec.name) ?? 0) }, context: context(), viewers: [] });
      if (!answer.state) throw new Error(`compute initialization failed: ${spec.name}`);
      const state = await reduce(answer.state, 'invalidate');
      await tx.query(`INSERT INTO ${PRIVATE}.batches(name,version,state) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(name) DO UPDATE SET version=EXCLUDED.version,state=EXCLUDED.state,failures=0,retry_at=NULL,error=NULL`,
        [spec.name, spec.version, JSON.stringify(state)]);
      await remember(tx, spec.name, state.requested);
    }
    await releaseCaptures(tx, `NOT EXISTS (
      SELECT 1 FROM ${PRIVATE}.batches batch WHERE batch.name=captures.name AND batch.version=captures.version
        AND (batch.state->>'claimed')::bigint=captures.revision AND (batch.state->>'completed')::bigint<captures.revision
    )`);
    const legacy = await tx.query<{ id: string; source: string; columns: SnapshotTable['columns'] }>(
      `SELECT c.id,t.key AS source,t.value->'columns' AS columns FROM ${PRIVATE}.captures c,
        LATERAL jsonb_each(c.snapshot->'tables') t WHERE c.snapshot IS NOT NULL`);
    for (const item of legacy.rows) {
      await retainTable(tx, item.id, item.source, item.columns, `SELECT ordinal::bigint AS sequence,
        ${item.columns.map((field, index) => `(value->>${sqlString(field.name)})::${field.type} AS c${index}`).join(',')}
        FROM ${PRIVATE}.captures c,LATERAL jsonb_array_elements(c.snapshot->'tables'->$2->'rows') WITH ORDINALITY AS r(value,ordinal)
        WHERE c.id=$1`, [item.id, item.source]);
    }
    await tx.exec(`UPDATE ${PRIVATE}.captures SET snapshot=NULL WHERE snapshot IS NOT NULL`);
  });
  async function reconcile(tx: Queryable) {
    const states = await load(tx);
    if (specs.some(spec => states.get(spec.name)?.version !== spec.version)) return states;
    const pending = await tx.query<{ table_name: string }>(`DELETE FROM ${PRIVATE}.inbox RETURNING table_name`);
    const changed = new Set(pending.rows.map(r => r.table_name));
    for (const spec of specs) {
      const item = states.get(spec.name)!;
      if (spec.reads.some(t => changed.has(t))) {
        item.state = await reduce(item.state, 'invalidate');
        await save(tx, item);
      }
    }
    return states;
  }
  function ready(spec: Computation, states: Map<string, Stored>) {
    return spec.reads.every(source => {
      const producer = producers.get(source);
      if (!producer) return true;
      const upstream = states.get(producer.name)!.state;
      return upstream.requested === upstream.completed;
    });
  }
  async function schedule(tx: Queryable, states: Map<string, Stored>) {
    for (const spec of specs) {
      const item = states.get(spec.name)!;
      if (item.failures >= item.state.attempts && item.state.requested > item.state.claimed) {
        await releaseCaptures(tx, 'name=$1 AND version=$2 AND revision=$3', [item.name, item.version, item.state.claimed]);
        item.state = await reduce(item.state, 'supersede');
        item.failures = 0; item.retry_at = null; item.error = null;
      }
      if (item.state.phase === 'idle' && item.state.requested > item.state.completed && ready(spec, states)) {
        item.state = await reduce(item.state, 'schedule');
      }
      await save(tx, item);
    }
  }
  async function next(): Promise<SnapshotIdentity | null> {
    return await serialize(async () => {
      const identity = await db.transaction(async tx => {
        const states = await reconcile(tx);
        if (specs.some(spec => states.get(spec.name)?.version !== spec.version)) return null;
        await schedule(tx, states);
        for (const spec of specs) {
          const item = states.get(spec.name)!;
          if (!ready(spec, states) || item.state.phase !== 'active') continue;
          if (item.failures >= item.state.attempts) continue;
          if ((item.retry_at ?? item.state.due) > now()) continue;
          if (!item.state.claimed) {
            item.state = await reduce(item.state, 'claim');
            await save(tx, item);
          }
          const id = JSON.stringify([spec.name, spec.version, item.state.claimed]);
          const identity = { id, name: spec.name, version: spec.version, revision: item.state.claimed };
          const saved = await tx.query(`SELECT id FROM ${PRIVATE}.captures WHERE id=$1`, [id]);
          if (saved.rows.length) return identity;
          await tx.query(`INSERT INTO ${PRIVATE}.captures(id,name,version,revision) VALUES($1,$2,$3,$4)`,
            [id, spec.name, spec.version, identity.revision]);
          for (const source of config.retainSnapshot ? [] : spec.reads) {
            const fields = (await columns(tx, source)).map(({ name, type }) => ({ name, type }));
            await retainTable(tx, id, source, fields, `SELECT row_number() OVER () AS sequence,
              ${fields.map((field, index) => `${q(field.name)} AS c${index}`).join(',')} FROM ${table(source)}`);
          }
          return identity;
        }
        return null;
      });
      if (identity && config.retainSnapshot) await config.retainSnapshot(identity);
      return identity;
    });
  }
  async function materialize(identity: SnapshotIdentity): Promise<boolean> {
    if (config.retainSnapshot) throw new Error('materialize requires an isolated retained database');
    return await atomic(async tx => {
      const retained = await captureTables(tx, identity);
      const spec = specs.find(spec => spec.name === identity.name && spec.version === identity.version);
      if (!spec) throw new Error('compute capture configuration differs');
      for (const source of spec.reads) {
        if (retained.some(item => item.source === source)) continue;
        const physical = (await tx.query<{ source_oid: number; filenode: number; total_blocks: number; ordinary: boolean }>(`SELECT c.oid AS source_oid,
          pg_relation_filenode(c.oid) AS filenode,
          (pg_relation_size(c.oid,'main')/current_setting('block_size')::bigint)::double precision AS total_blocks,
          (c.relkind='r' AND c.relpersistence='p' AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap')
            AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) AS ordinary
          FROM pg_class c WHERE c.oid=$1::regclass`, [table(source)])).rows[0];
        if (!physical?.ordinary) throw new Error(`compute materialize requires an ordinary logged heap table without inheritance: ${source}`);
        let progress = (await tx.query<CaptureProgress>(`SELECT source,relation,columns,source_oid,filenode,
          next_block::double precision,total_blocks::double precision,row_count::double precision AS rows
          FROM ${PRIVATE}.capture_progress WHERE capture_id=$1 AND source=$2`, [identity.id, source])).rows[0];
        if (!progress) {
          const fields = (await columns(tx, source)).map(({ name, type }) => ({ name, type }));
          const relation = `capture_${crypto.randomUUID().replaceAll('-', '')}`;
          await tx.exec(`CREATE TABLE ${captured(relation)} AS SELECT 0::bigint AS sequence,
            ${fields.map((field, index) => `${q(field.name)} AS c${index}`).join(',')} FROM ONLY ${table(source)} WITH NO DATA;
            ALTER TABLE ${captured(relation)} ADD PRIMARY KEY(sequence);`);
          await tx.query(`INSERT INTO ${PRIVATE}.capture_progress(capture_id,source,relation,columns,source_oid,filenode,total_blocks)
            VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`, [identity.id, source, relation, JSON.stringify(fields), physical.source_oid, physical.filenode, physical.total_blocks]);
          progress = { source, relation, columns: fields, rows: 0, next_block: 0, ...physical };
        }
        if (progress.source_oid !== physical.source_oid || progress.filenode !== physical.filenode || progress.total_blocks !== physical.total_blocks) {
          throw new Error(`compute materialize source changed: ${source}`);
        }
        const end = Math.min(progress.next_block + MATERIALIZE_BLOCKS, progress.total_blocks);
        const count = (await tx.query<{ rows: number }>(`WITH copied AS (
          INSERT INTO ${captured(progress.relation)} SELECT $1::bigint+row_number() OVER (ORDER BY source.ctid),
            ${progress.columns.map(field => `source.${q(field.name)}`).join(',')} FROM ONLY ${table(source)} AS source
          WHERE source.ctid >= $2::tid AND source.ctid < $3::tid RETURNING sequence
        ) SELECT count(*)::double precision AS rows FROM copied`, [progress.rows, `(${progress.next_block},0)`, `(${end},0)`])).rows[0].rows;
        const rows = progress.rows + count;
        if (!Number.isSafeInteger(rows)) throw new Error('compute capture exceeds exact sequence range');
        if (end === progress.total_blocks) {
          await tx.query(`INSERT INTO ${PRIVATE}.capture_tables(capture_id,source,relation,columns,row_count) VALUES($1,$2,$3,$4::jsonb,$5)`,
            [identity.id, source, progress.relation, JSON.stringify(progress.columns), rows]);
          await tx.query(`DELETE FROM ${PRIVATE}.capture_progress WHERE capture_id=$1 AND source=$2`, [identity.id, source]);
          return retained.length + 1 === spec.reads.length;
        }
        await tx.query(`UPDATE ${PRIVATE}.capture_progress SET next_block=$3,row_count=$4 WHERE capture_id=$1 AND source=$2`,
          [identity.id, source, end, rows]);
        return false;
      }
      return true;
    });
  }
  async function captureTables(tx: Queryable, identity: SnapshotIdentity): Promise<CaptureTable[]> {
    checkIdentity(identity);
    const saved = await tx.query(`SELECT id FROM ${PRIVATE}.captures WHERE id=$1 AND name=$2 AND version=$3 AND revision=$4`,
      [identity.id, identity.name, identity.version, identity.revision]);
    if (!saved.rows.length) throw new Error('compute capture is no longer available');
    return (await tx.query<CaptureTable>(`SELECT source,relation,columns,row_count::double precision AS rows
      FROM ${PRIVATE}.capture_tables WHERE capture_id=$1 ORDER BY source`, [identity.id])).rows;
  }
  async function readableTables(tx: Queryable, identity: SnapshotIdentity): Promise<CaptureTable[]> {
    const retained = await captureTables(tx, identity);
    const spec = specs.find(spec => spec.name === identity.name && spec.version === identity.version);
    if (!spec || spec.reads.length !== retained.length || spec.reads.some(source => !retained.some(item => item.source === source))) {
      throw new Error('compute capture must be materialized in its retained database');
    }
    return retained;
  }
  async function manifest(identity: SnapshotIdentity): Promise<SnapshotManifest> {
    return await atomic(async tx => ({ ...identity, tables: Object.fromEntries((await readableTables(tx, identity))
      .map(({ source, columns, rows }) => [source, { columns, rows }])) }));
  }
  async function readChunk(tx: Queryable, identity: SnapshotIdentity, source: string, after: number, limits: ChunkLimits): Promise<SnapshotChunk> {
    const maxRows = limits.maxRows ?? CAPTURE_CHUNK_ROWS;
    const maxBytes = limits.maxBytes ?? CAPTURE_CHUNK_BYTES;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > CAPTURE_CHUNK_ROWS ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > CAPTURE_CHUNK_BYTES) throw new Error('invalid compute chunk bounds');
    const metadata = (await readableTables(tx, identity)).find(item => item.source === source);
    if (!metadata) throw new Error(`compute capture has no table ${source}`);
    if (after > metadata.rows) throw new Error('compute chunk cursor exceeds captured rows');
    await tx.exec(transportSettings);
    const row = `(SELECT row_to_json(r) FROM (SELECT ${metadata.columns.map((field, index) => `c${index}::text AS ${q(field.name)}`).join(',')}) r)`;
    const sizes = await tx.query<{ sequence: number; bytes: number }>(`SELECT sequence::double precision AS sequence,
      octet_length(${row}::text) AS bytes FROM ${captured(metadata.relation)} AS retained
      WHERE retained.sequence>$1 ORDER BY retained.sequence LIMIT $2`, [after, maxRows]);
    let next = after, bytes = 2;
    for (const item of sizes.rows) {
      if (bytes + item.bytes + (next > after ? 1 : 0) > maxBytes) {
        if (next === after) throw new Error(`compute capture row ${source}:${item.sequence} exceeds chunk byte limit ${maxBytes}`);
        break;
      }
      bytes += item.bytes + (next > after ? 1 : 0);
      next = item.sequence;
    }
    const rows = next === after ? [] : (await tx.query<{ row: SnapshotTable['rows'][number] }>(
      `SELECT ${row} AS row FROM ${captured(metadata.relation)} WHERE sequence>$1 AND sequence<=$2 ORDER BY sequence`, [after, next])).rows.map(item => item.row);
    return { ...identity, table: source, after, next, done: next === metadata.rows, rows };
  }
  async function chunk(identity: SnapshotIdentity, source: string, after = 0, limits: ChunkLimits = {}): Promise<SnapshotChunk> {
    return await atomic(tx => readChunk(tx, identity, source, after, limits));
  }
  async function snapshot(identity: SnapshotIdentity): Promise<Snapshot> {
    return await atomic(async tx => {
      const result: Snapshot = { ...identity, tables: {} };
      const tables = await readableTables(tx, identity);
      await tx.exec(transportSettings);
      for (const metadata of tables) {
        const { rows } = await tx.query<SnapshotTable['rows'][number]>(`SELECT
          ${metadata.columns.map((field, index) => `c${index}::text AS ${q(field.name)}`).join(',')}
          FROM ${captured(metadata.relation)} AS retained ORDER BY retained.sequence`);
        result.tables[metadata.source] = { columns: metadata.columns, rows };
      }
      return result;
    });
  }
  async function commit(snapshot: SnapshotIdentity, apply: (tx: Queryable, spec: Computation) => Promise<void>) {
    checkIdentity(snapshot);
    return await atomic(async tx => {
      const states = await reconcile(tx);
      const item = states.get(snapshot.name);
      const receipt = await tx.query(`SELECT id FROM ${PRIVATE}.receipts WHERE id=$1`, [snapshot.id]);
      if (receipt.rows.length) return;
      if (!item || item.version !== snapshot.version || item.state.claimed !== snapshot.revision || item.state.completed >= snapshot.revision) return;
      const spec = specs.find(s => s.name === snapshot.name && s.version === snapshot.version);
      if (!spec) throw new Error('compute capture configuration differs');
      await captureTables(tx, snapshot);
      await apply(tx, spec);
      await tx.query(`INSERT INTO ${PRIVATE}.receipts(id,name,version,revision,committed_at) VALUES($1,$2,$3,$4,$5)`,
        [snapshot.id, snapshot.name, snapshot.version, snapshot.revision, now()]);
      item.state = await reduce(item.state, 'complete');
      item.failures = 0; item.retry_at = null; item.error = null;
      await save(tx, item);
      await releaseCaptures(tx, 'id=$1', [snapshot.id]);
    });
  }
  async function activeSpec(tx: Queryable, identity: SnapshotIdentity) {
    await captureTables(tx, identity);
    const item = (await load(tx)).get(identity.name);
    if (!item || item.version !== identity.version || item.state.claimed !== identity.revision || item.state.completed >= identity.revision) {
      throw new Error('compute capture is no longer active');
    }
    const spec = specs.find(spec => spec.name === identity.name && spec.version === identity.version);
    if (!spec) throw new Error('compute capture configuration differs');
    return spec;
  }
  async function reject(snapshot: SnapshotIdentity, error: string) {
    checkIdentity(snapshot);
    await atomic(async tx => {
      const item = (await load(tx)).get(snapshot.name);
      if (!item || item.version !== snapshot.version || item.state.claimed !== snapshot.revision || item.state.completed >= snapshot.revision) return;
      await captureTables(tx, snapshot);
      item.failures++;
      const delay = retryDelay(item.failures);
      if (!Number.isSafeInteger(delay) || delay < 1) throw new Error('compute retry delay must be a positive integer');
      item.retry_at = now() + delay;
      item.error = error;
      await save(tx, item);
    });
  }
  let stopped = false;
  let running: Promise<void> | null = null;
  async function run() {
    if (!config.execute) throw new Error('local compute execution is not configured');
    while (!stopped) {
      const identity = await next();
      if (!identity) return;
      try {
        const output = await config.execute(await snapshot(identity));
        await commit(identity, (tx, spec) => publish(tx, spec, output));
      } catch (error) {
        await reject(identity, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }
  return {
    publication(identity) {
      checkIdentity(identity);
      return atomic(async tx => {
        const values = [identity.id, identity.name, identity.version, identity.revision];
        if ((await tx.query(`SELECT id FROM ${PRIVATE}.receipts WHERE id=$1 AND name=$2 AND version=$3 AND revision=$4`, values)).rows.length) return 'published';
        if (!(await tx.query(`SELECT id FROM ${PRIVATE}.captures WHERE id=$1 AND name=$2 AND version=$3 AND revision=$4`, values)).rows.length) return 'obsolete';
        const item = (await load(tx)).get(identity.name);
        return item?.version === identity.version && item.state.claimed === identity.revision && item.state.completed < identity.revision
          ? 'pending' : 'obsolete';
      });
    },
    claim: next, materialize, snapshot, manifest, chunk, reject,
    publish(identity, output) { return commit(identity, (tx, spec) => publish(tx, spec, output)); },
    outputChunk(identity, attempt, sink, ordinal, rows) {
      return atomic(async tx => stageOutput(tx, identity, await activeSpec(tx, identity), attempt, sink, ordinal, rows));
    },
    sealOutput(identity, attempt, manifest) {
      return atomic(async tx => sealStagedOutput(tx, identity, await activeSpec(tx, identity), attempt, manifest));
    },
    publishStaged(identity, attempt) { return commit(identity, (tx, spec) => publishOutput(tx, identity, spec, attempt)); },
    resume() {
      if (stopped) return Promise.reject(new Error('compute coordinator is stopped'));
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    async wakeAt() {
      return await atomic(async tx => {
        const states = await reconcile(tx);
        if (specs.some(spec => states.get(spec.name)?.version !== spec.version)) return null;
        await schedule(tx, states);
        const due = specs.flatMap(spec => {
          const item = states.get(spec.name)!;
          return item.state.phase === 'active' && item.failures < item.state.attempts && ready(spec, states)
            ? [item.retry_at ?? item.state.due] : [];
        });
        return due.length ? Math.min(...due) : null;
      });
    },
    async stop() { stopped = true; if (running) await running; },
  };
}

function json(value: unknown): string {
  const visit = (v: unknown): void => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))) return;
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { Object.values(v).forEach(visit); return; }
    throw new Error('compute output requires finite lossless JSON values');
  };
  visit(value);
  return JSON.stringify(value);
}

async function publish(tx: Queryable, spec: Computation, output: Output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) ||
    JSON.stringify(Object.keys(output).sort()) !== JSON.stringify([...spec.to].sort())) throw new Error(`compute ${spec.name} returned different sinks`);
  const encoded = new Map<string, { rows: string; fields: string[] }>();
  for (const sink of spec.to) {
    const rows = output[sink];
    if (!Array.isArray(rows)) throw new Error(`compute ${sink} needs rows`);
    const physical = await columns(tx, sink);
    const allowed = new Set(physical.filter(c => !c.generated && c.name !== 'scope_id' && c.name !== 'txid').map(c => c.name));
    const fields = rows.length ? Object.keys(rows[0]).sort() : [];
    const ids = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || ids.has(row.id)) throw new Error(`compute ${sink} requires unique text ids`);
      ids.add(row.id);
      if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(fields)) throw new Error(`compute ${sink} rows differ in columns`);
      for (const field of fields) if (!allowed.has(field)) throw new Error(`compute cannot write ${sink}.${field}`);
      for (const field of physical) if (field.required && allowed.has(field.name) && !fields.includes(field.name)) throw new Error(`compute missing ${sink}.${field.name}`);
    }
    encoded.set(sink, { rows: json(rows), fields });
  }
  const previous = await tx.query<{ name: string; value: string | null }>(`SELECT name,current_setting(name,true) AS value FROM unnest(ARRAY['role','request.jwt.claims','app.scopes']) AS name`);
  await tx.exec(`SELECT set_config('request.jwt.claims','{"role":"service"}',true); SELECT set_config('app.scopes','',true); SET LOCAL ROLE service;`);
  for (const sink of spec.to) {
    const { rows, fields } = encoded.get(sink)!;
    if (fields.length) {
      const rest = fields.filter(f => f !== 'id');
      const conflicts = rest.length ? `DO UPDATE SET ${rest.map(f => `${q(f)}=EXCLUDED.${q(f)}`).join(',')}
        WHERE to_jsonb(ROW(${rest.map(f => `sink.${q(f)}`).join(',')})) IS DISTINCT FROM to_jsonb(ROW(${rest.map(f => `EXCLUDED.${q(f)}`).join(',')}))` : 'DO NOTHING';
      await tx.query(`INSERT INTO ${table(sink)} AS sink (${fields.map(q).join(',')})
        SELECT ${fields.map(q).join(',')} FROM json_populate_recordset(NULL::${table(sink)},$1::json)
        ON CONFLICT(id) ${conflicts}`, [rows]);
    }
  }
  for (const sink of spec.to) {
    if (spec.sinkWrites?.[sink] === 'upsert') continue;
    await tx.query(`DELETE FROM ${table(sink)} AS sink WHERE NOT EXISTS
      (SELECT 1 FROM json_populate_recordset(NULL::${table(sink)},$1::json) AS incoming WHERE incoming.id=sink.id)`, [encoded.get(sink)!.rows]);
  }
  if (spec.onComplete) await tx.query(`SELECT public.${q(spec.onComplete)}()`);
  for (const setting of previous.rows) await tx.query('SELECT set_config($1,$2,true)', [setting.name, setting.value ?? '']);
}
