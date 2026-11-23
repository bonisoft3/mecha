import { strictJson } from './json.ts'
import type { SinkWrites } from './sink-writes.ts'

/**
 * Publication of staged output pages into an app's sinks: the column contract a
 * page must meet and the statements that apply it, the same on every host. A
 * host owns where pages are staged and under which authority they apply.
 */

export interface PublicationClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>
}
export interface PublishedSink { relation: string; fields: readonly string[] }
export type PublicationSummary = Record<string, { upserted: number; deleted: number }>

type Row = Record<string, unknown>
const BATCH = 500
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
const target = (name: string) => `public.${q(name)}`

/** A sink's rows name `id`, only columns the app lets a computation write, and every required one. */
export async function checkSinkColumns(tx: PublicationClient, sink: string, fields: readonly string[]) {
  const physical = (await tx.query<{ name: string; generated: boolean; required: boolean }>(`SELECT attname AS name,
    (attgenerated<>'' OR attidentity<>'') AS generated,
    (attnotnull AND NOT atthasdef AND attgenerated='' AND attidentity='') AS required
    FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`, [target(sink)])).rows
  const allowed = new Set(physical.filter(c => !c.generated && !['scope_id', 'txid'].includes(c.name)).map(c => c.name))
  if (!fields.includes('id') || fields.some(f => !allowed.has(f)) ||
    physical.some(c => c.required && allowed.has(c.name) && !fields.includes(c.name))) {
    throw new Error(`${sink}: invalid output columns`)
  }
}

async function stageRelation(tx: PublicationClient, sink: string, fields: readonly string[], rows: readonly Row[]) {
  const name = `publication_${crypto.randomUUID().replaceAll('-', '')}`
  const relation = `pg_temp.${q(name)}`
  await tx.query(`CREATE TEMP TABLE ${q(name)} ON COMMIT DROP AS SELECT ${fields.map(q).join(',')} FROM ${target(sink)} WITH NO DATA`)
  await tx.query(`GRANT SELECT ON TABLE ${relation} TO PUBLIC`)
  for (let i = 0; i < rows.length; i += BATCH) {
    await tx.query(`INSERT INTO ${relation} SELECT ${fields.map(q).join(',')} FROM json_populate_recordset(NULL::${target(sink)},$1::json)`,
      [strictJson(rows.slice(i, i + BATCH))])
  }
  return relation
}

/**
 * Stages an output a host holds whole, and the ids a delta removes, in
 * transaction-scoped relations for applyPublication. PostgreSQL accepts
 * different spellings of one key (a UUID's case), so a key can repeat only once
 * typed, across upserts and removals alike.
 */
export async function stageWhole(tx: PublicationClient, spec: { to: readonly string[] }, output: Record<string, readonly Row[]>,
  deletions?: Record<string, readonly string[]>) {
  const staged: Record<string, PublishedSink> = {}
  const removed: Record<string, string> = {}
  for (const sink of spec.to) {
    const rows = output[sink]
    const fields = rows.length ? Object.keys(rows[0]).sort() : []
    if (fields.length) await checkSinkColumns(tx, sink, fields)
    staged[sink] = { relation: await stageRelation(tx, sink, fields.length ? fields : ['id'], rows), fields }
    const keys = [`SELECT id FROM ${staged[sink].relation}`]
    if (deletions?.[sink].length) {
      removed[sink] = await stageRelation(tx, sink, ['id'], deletions[sink].map(id => ({ id })))
      keys.push(`SELECT id FROM ${removed[sink]}`)
    }
    if ((await tx.query(`SELECT 1 FROM (${keys.join(' UNION ALL ')}) k GROUP BY id HAVING count(*)>1 OR id IS NULL LIMIT 1`)).rows.length) {
      throw new Error(`${sink} publication contains repeated PostgreSQL keys`)
    }
    for (const relation of [staged[sink].relation, removed[sink]]) {
      if (relation) await tx.query(`CREATE UNIQUE INDEX ON ${relation} (id)`)
    }
  }
  return { staged, deletions: deletions ? removed : undefined }
}

// The service role's statement timeout bounds each write, so a sink's rows apply in id-ordered batches.
async function batched(tx: PublicationClient, relation: string, write: (where: string, params: string[]) => Promise<number>) {
  let after: string | undefined, total = 0
  for (;;) {
    const params = after === undefined ? [] : [after]
    const lower = after === undefined ? 'true' : 'incoming.id>$1'
    const bound = (await tx.query<{ id: string }>(`SELECT incoming.id::text AS id FROM ${relation} incoming
      WHERE ${lower} ORDER BY incoming.id OFFSET ${BATCH - 1} LIMIT 1`, params)).rows[0]?.id
    total += bound === undefined ? await write(lower, params) : await write(`${lower} AND incoming.id<=$${params.length + 1}`, [...params, bound])
    if (bound === undefined) return total
    after = bound
  }
}

/**
 * Upserts each staged relation into its sink, then deletes what a replacing sink
 * no longer holds, then runs the completion hook. A staged row equal to the
 * stored one is not written at all, so no lock, trigger or new row version
 * follows from republishing it; a sink's triggers see only rows that changed.
 * A sink with no staged fields received no rows. With `deletions`, a delta
 * removes exactly those staged ids instead, and a sink absent from them none.
 */
export async function applyPublication(tx: PublicationClient, spec: { to: readonly string[]; sinkWrites?: SinkWrites; onComplete?: string },
  staged: Record<string, PublishedSink>, deletions?: Record<string, string>): Promise<PublicationSummary> {
  const summary: PublicationSummary = Object.fromEntries(spec.to.map(sink => [sink, { upserted: 0, deleted: 0 }]))
  for (const sink of spec.to) {
    const { relation, fields } = staged[sink]
    if (!fields.length) continue
    const rest = fields.filter(field => field !== 'id')
    const row = (alias: string) => `to_jsonb(ROW(${rest.map(f => `${alias}.${q(f)}`).join(',')}))`
    const conflict = rest.length
      ? `DO UPDATE SET ${rest.map(f => `${q(f)}=EXCLUDED.${q(f)}`).join(',')} WHERE ${row('sink')} IS DISTINCT FROM ${row('EXCLUDED')}`
      : 'DO NOTHING'
    const unchanged = rest.length ? `AND ${row('existing')} IS NOT DISTINCT FROM ${row('incoming')}` : ''
    summary[sink].upserted = await batched(tx, relation, async (where, params) =>
      (await tx.query(`INSERT INTO ${target(sink)} AS sink (${fields.map(q).join(',')})
        SELECT ${fields.map(f => `incoming.${q(f)}`).join(',')} FROM ${relation} incoming
        WHERE ${where} AND NOT EXISTS (SELECT 1 FROM ${target(sink)} existing WHERE existing.id=incoming.id ${unchanged})
        ON CONFLICT(id) ${conflict}`, params)).affectedRows ?? 0)
  }
  for (const sink of spec.to) {
    if (spec.sinkWrites?.[sink] === 'upsert') continue
    if (deletions) {
      if (deletions[sink]) {
        summary[sink].deleted = await batched(tx, deletions[sink], async (where, params) =>
          (await tx.query(`DELETE FROM ${target(sink)} AS sink USING ${deletions[sink]} incoming
            WHERE sink.id=incoming.id AND ${where}`, params)).affectedRows ?? 0)
      }
      continue
    }
    summary[sink].deleted = (await tx.query(`DELETE FROM ${target(sink)} AS sink WHERE NOT EXISTS
      (SELECT 1 FROM ${staged[sink].relation} incoming WHERE incoming.id=sink.id)`)).affectedRows ?? 0
  }
  if (spec.onComplete) await tx.query(`SELECT public.${q(spec.onComplete)}()`)
  return summary
}
