import type { Computation, Queryable, SnapshotIdentity } from './index.ts';

const schema = 'compute_snapshot_private';
const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
const target = (name: string) => `public.${q(name)}`;
export const OUTPUT_CHUNK_BYTES = 256 * 1024;
export interface OutputSeal { [sink: string]: { chunks: number; rows: number } }
interface Stage { sink: string; relation: string; fields: string[]; sealed: boolean }

export async function initializeOutputs(tx: Queryable) {
  await tx.exec(`CREATE TABLE IF NOT EXISTS ${schema}.outputs(
    capture text NOT NULL REFERENCES ${schema}.captures(id) ON DELETE CASCADE,
    attempt text NOT NULL, sink text NOT NULL, relation text NOT NULL UNIQUE,
    fields jsonb NOT NULL, sealed boolean NOT NULL DEFAULT false,
    PRIMARY KEY(capture,attempt,sink));
    CREATE TABLE IF NOT EXISTS ${schema}.output_chunks(
      capture text NOT NULL, attempt text NOT NULL, sink text NOT NULL, ordinal integer NOT NULL,
      digest text NOT NULL, rows integer NOT NULL,
      PRIMARY KEY(capture,attempt,sink,ordinal),
      FOREIGN KEY(capture,attempt,sink) REFERENCES ${schema}.outputs ON DELETE CASCADE);`);
}

async function stages(tx: Queryable, identity: SnapshotIdentity, attempt: string) {
  return (await tx.query<Stage>(`SELECT sink,relation,fields,sealed FROM ${schema}.outputs
    WHERE capture=$1 AND attempt=$2`, [identity.id, attempt])).rows;
}

export async function collectOutputs(tx: Queryable) {
  const orphaned = await tx.query<{ name: string }>(`SELECT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind='r'
    AND c.relname LIKE 'output\\_%' ESCAPE '\\' AND c.relname<>'output_chunks'
    AND NOT EXISTS(SELECT 1 FROM ${schema}.outputs o WHERE o.relation=c.relname)`);
  for (const row of orphaned.rows) await tx.exec(`DROP TABLE ${schema}.${q(row.name)}`);
}

export async function stageOutput(tx: Queryable, identity: SnapshotIdentity, spec: Computation,
  attempt: string, sink: string, ordinal: number, rows: Record<string, unknown>[]) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(attempt) || !spec.to.includes(sink) ||
    !Number.isSafeInteger(ordinal) || ordinal < 0 || !Array.isArray(rows) || !rows.length || rows.length > 128) {
    throw new Error('invalid output chunk');
  }
  const body = JSON.stringify(rows, (_key, value) => {
    if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' ||
      typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error('output chunk requires finite lossless JSON');
    }
    return value;
  });
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > OUTPUT_CHUNK_BYTES) throw new Error('output chunk exceeds byte limit');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const prior = await tx.query<{ digest: string }>(`SELECT digest FROM ${schema}.output_chunks
    WHERE capture=$1 AND attempt=$2 AND sink=$3 AND ordinal=$4`, [identity.id, attempt, sink, ordinal]);
  if (prior.rows.length) {
    if (prior.rows[0].digest !== digest) throw new Error('output chunk replay differs');
    return;
  }
  const fields = Object.keys(rows[0]).sort();
  const physical = (await tx.query<{ name: string; generated: boolean; required: boolean }>(`SELECT attname AS name,
    (attgenerated<>'' OR attidentity<>'') AS generated,
    (attnotnull AND NOT atthasdef AND attgenerated='' AND attidentity='') AS required
    FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`, [target(sink)])).rows;
  const allowed = new Set(physical.filter(c => !c.generated && !['scope_id', 'txid'].includes(c.name)).map(c => c.name));
  if (!fields.includes('id') || fields.some(f => !allowed.has(f)) ||
    physical.some(c => c.required && allowed.has(c.name) && !fields.includes(c.name))) throw new Error('invalid output columns');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' ||
      JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(fields)) throw new Error('invalid output row');
  }
  let stage = (await stages(tx, identity, attempt)).find(row => row.sink === sink);
  if (!stage) {
    if (ordinal !== 0) throw new Error('output chunks must be consecutive');
    const relation = `output_${crypto.randomUUID().replaceAll('-', '')}`;
    await tx.exec(`CREATE TABLE ${schema}.${q(relation)} AS SELECT ${fields.map(q).join(',')} FROM ${target(sink)} WITH NO DATA;
      ALTER TABLE ${schema}.${q(relation)} ADD PRIMARY KEY(id);
      GRANT SELECT ON ${schema}.${q(relation)} TO service;`);
    await tx.query(`INSERT INTO ${schema}.outputs(capture,attempt,sink,relation,fields) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [identity.id, attempt, sink, relation, JSON.stringify(fields)]);
    stage = { sink, relation, fields, sealed: false };
  }
  if (stage.sealed || JSON.stringify(stage.fields) !== JSON.stringify(fields)) throw new Error('output is sealed or columns changed');
  const count = (await tx.query<{ count: number }>(`SELECT COALESCE(max(ordinal),-1)+1 AS count FROM ${schema}.output_chunks
    WHERE capture=$1 AND attempt=$2 AND sink=$3`, [identity.id, attempt, sink])).rows[0].count;
  if (count !== ordinal) throw new Error('output chunks must be consecutive');
  await tx.query(`INSERT INTO ${schema}.${q(stage.relation)} SELECT ${fields.map(q).join(',')}
    FROM json_populate_recordset(NULL::${target(sink)},$1::json)`, [body]);
  await tx.query(`INSERT INTO ${schema}.output_chunks VALUES($1,$2,$3,$4,$5,$6)`,
    [identity.id, attempt, sink, ordinal, digest, rows.length]);
}

export async function sealOutput(tx: Queryable, identity: SnapshotIdentity, spec: Computation, attempt: string, manifest: OutputSeal) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(attempt) || !manifest ||
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify([...spec.to].sort())) throw new Error('invalid output seal');
  const saved = await stages(tx, identity, attempt);
  for (const sink of spec.to) {
    const expected = manifest[sink];
    if (!expected || !Number.isSafeInteger(expected.chunks) || expected.chunks < 0 ||
      !Number.isSafeInteger(expected.rows) || expected.rows < 0) throw new Error('invalid output counts');
    const actual = (await tx.query<{ chunks: number; rows: number }>(`SELECT count(*)::integer AS chunks,
      COALESCE(sum(rows),0)::double precision AS rows FROM ${schema}.output_chunks
      WHERE capture=$1 AND attempt=$2 AND sink=$3`, [identity.id, attempt, sink])).rows[0];
    if (actual.chunks !== expected.chunks || actual.rows !== expected.rows) throw new Error('incomplete output');
    if (!saved.some(row => row.sink === sink)) {
      const relation = `output_${crypto.randomUUID().replaceAll('-', '')}`;
      await tx.exec(`CREATE TABLE ${schema}.${q(relation)} AS SELECT id FROM ${target(sink)} WITH NO DATA;
        GRANT SELECT ON ${schema}.${q(relation)} TO service;`);
      await tx.query(`INSERT INTO ${schema}.outputs(capture,attempt,sink,relation,fields) VALUES($1,$2,$3,$4,'[]')`,
        [identity.id, attempt, sink, relation]);
    }
  }
  await tx.query(`UPDATE ${schema}.outputs SET sealed=true WHERE capture=$1 AND attempt=$2`, [identity.id, attempt]);
}

export async function publishOutput(tx: Queryable, identity: SnapshotIdentity, spec: Computation, attempt: string) {
  const saved = await stages(tx, identity, attempt);
  if (saved.length !== spec.to.length || spec.to.some(sink => !saved.some(row => row.sink === sink && row.sealed))) {
    throw new Error('output is not sealed');
  }
  const previous = (await tx.query<{ name: string; value: string | null }>(`SELECT name,current_setting(name,true) AS value
    FROM unnest(ARRAY['role','request.jwt.claims','app.scopes']) AS name`)).rows;
  await tx.exec(`GRANT USAGE ON SCHEMA ${schema} TO service;
    SELECT set_config('request.jwt.claims','{"role":"service"}',true); SELECT set_config('app.scopes','',true); SET LOCAL ROLE service;`);
  for (const sink of spec.to) {
    const stage = saved.find(row => row.sink === sink)!;
    if (!stage.fields.length) continue;
    const rest = stage.fields.filter(field => field !== 'id');
    const conflict = rest.length ? `DO UPDATE SET ${rest.map(f => `${q(f)}=EXCLUDED.${q(f)}`).join(',')}
      WHERE to_jsonb(ROW(${rest.map(f => `sink.${q(f)}`).join(',')})) IS DISTINCT FROM to_jsonb(ROW(${rest.map(f => `EXCLUDED.${q(f)}`).join(',')}))` : 'DO NOTHING';
    const unchanged = rest.length ? `AND to_jsonb(ROW(${rest.map(f => `existing.${q(f)}`).join(',')}))
      IS NOT DISTINCT FROM to_jsonb(ROW(${rest.map(f => `incoming.${q(f)}`).join(',')}))` : '';
    await tx.exec(`INSERT INTO ${target(sink)} AS sink (${stage.fields.map(q).join(',')})
      SELECT ${stage.fields.map(f => `incoming.${q(f)}`).join(',')} FROM ${schema}.${q(stage.relation)} incoming
      WHERE NOT EXISTS (SELECT 1 FROM ${target(sink)} existing WHERE existing.id=incoming.id ${unchanged})
      ON CONFLICT(id) ${conflict}`);
  }
  for (const sink of spec.to) {
    const stage = saved.find(row => row.sink === sink)!;
    if (spec.sinkWrites?.[sink] === 'upsert') continue;
    await tx.exec(`DELETE FROM ${target(sink)} AS sink WHERE NOT EXISTS
      (SELECT 1 FROM ${schema}.${q(stage.relation)} incoming WHERE incoming.id=sink.id)`);
  }
  if (spec.onComplete) await tx.query(`SELECT public.${q(spec.onComplete)}()`);
  for (const setting of previous) await tx.query('SELECT set_config($1,$2,true)', [setting.name, setting.value ?? '']);
}
