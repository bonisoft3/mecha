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

/**
 * Upserts each staged relation into its sink, then deletes what a replacing sink
 * no longer holds, then runs the completion hook. A staged row equal to the
 * stored one is not written at all, so no lock, trigger or new row version
 * follows from republishing it; a sink's triggers see only rows that changed.
 * A sink with no staged fields received no rows.
 */
export async function applyPublication(tx: PublicationClient, spec: { to: readonly string[]; sinkWrites?: SinkWrites; onComplete?: string },
  staged: Record<string, PublishedSink>): Promise<PublicationSummary> {
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
    const result = await tx.query(`INSERT INTO ${target(sink)} AS sink (${fields.map(q).join(',')})
      SELECT ${fields.map(f => `incoming.${q(f)}`).join(',')} FROM ${relation} incoming
      WHERE NOT EXISTS (SELECT 1 FROM ${target(sink)} existing WHERE existing.id=incoming.id ${unchanged})
      ON CONFLICT(id) ${conflict}`)
    summary[sink].upserted = result.affectedRows ?? 0
  }
  for (const sink of spec.to) {
    if (spec.sinkWrites?.[sink] === 'upsert') continue
    const result = await tx.query(`DELETE FROM ${target(sink)} AS sink WHERE NOT EXISTS
      (SELECT 1 FROM ${staged[sink].relation} incoming WHERE incoming.id=sink.id)`)
    summary[sink].deleted = result.affectedRows ?? 0
  }
  if (spec.onComplete) await tx.query(`SELECT public.${q(spec.onComplete)}()`)
  return summary
}
