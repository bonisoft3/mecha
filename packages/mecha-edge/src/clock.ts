// The ticker on the edge: the object's alarm. A machine's deadline is a
// one-shot `schedule` row (pronto's mecha-ports arm()), swept on the container
// tier by the ticker (services/ticker); here the alarm is set at the earliest
// due_at, and the sweep writes the tick rows the machines' fire triggers
// answer, through crud as the service role, as the ticker writes them. A cron
// schedule needs the ticker's reader and is refused: the edge clock serves
// deadlines alone.
import type { PGlite } from '@electric-sql/pglite'
import { tickId } from '../../../services/ticker/tick-id.ts'
import { ABSORB, type Crud as ServiceCrud } from '../../../services/ticker/crud.ts'
export type { Crud as ServiceCrud } from '../../../services/ticker/crud.ts'

export function serviceCrud(service: (req: Request) => Promise<Response>): ServiceCrud {
  return async (method, path, opts = {}) => {
    const res = await service(new Request(`https://cluster/crud${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.prefer === undefined ? {} : { prefer: opts.prefer }) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }))
    const text = await res.text()
    if (!res.ok) throw new Error(`crud ${method} ${path}: ${res.status} ${text}`)
    return text === '' ? [] : JSON.parse(text)
  }
}

/** Whether the data directory holds schedules at all: the table is a
 * machine migration's, where a machine has a deadline. */
export async function hasSchedules(db: PGlite): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(`SELECT to_regclass('public.schedule') IS NOT NULL AS present`)
  if (!rows[0].present) return false
  const cron = await db.query<{ name: string }>(`SELECT name FROM public.schedule WHERE cron IS NOT NULL LIMIT 1`)
  if (cron.rows.length) throw new Error(`the edge clock serves deadlines alone; schedule ${cron.rows[0].name} is cron`)
  return true
}

export type DeadlineRetry = { through: Date; at: Date }

/** The next wake in ms; failed deadlines retry without delaying future ones. */
export async function nextDue(db: PGlite, retry?: DeadlineRetry): Promise<number | null> {
  const deadline = retry ? 'CASE WHEN due_at <= $1::timestamptz THEN $2::timestamptz ELSE due_at END' : 'due_at'
  const { rows } = await db.query<{ due: string | null }>(
    `SELECT (extract(epoch FROM min(${deadline})) * 1000)::text AS due FROM public.schedule WHERE NOT suspended AND due_at IS NOT NULL AND (last_tick_at IS NULL OR date_trunc('milliseconds', last_tick_at) < date_trunc('milliseconds', due_at))`,
    retry ? [retry.through.toISOString(), retry.at.toISOString()] : [],
  )
  return rows[0].due === null ? null : Math.ceil(Number(rows[0].due))
}

/** Resolved ticks advance their watermark even when their trigger keeps the
 * schedule. Failures stay due while the remaining schedules still run. */
export async function sweepDue(crud: ServiceCrud, now: Date): Promise<number> {
  const due = await crud('GET', `/schedule?suspended=is.false&due_at=lte.${encodeURIComponent(now.toISOString())}&select=name,due_at,last_tick_at,emits_entity,emits_values&order=due_at.asc`)
  const errors: Error[] = []
  let emitted = 0
  for (const s of due) {
    try {
      const tickAt = new Date(s.due_at as string).toISOString()
      if (s.last_tick_at !== null && new Date(s.last_tick_at as string) >= new Date(tickAt)) continue
      await crud('POST', `/${s.emits_entity as string}`, {
        body: { ...(s.emits_values as Record<string, unknown>), id: await tickId(s.name as string, tickAt), schedule: s.name, tick_at: tickAt, late: false, caller: 'edge' },
        prefer: ABSORB,
      })
      emitted++
      const previous = s.last_tick_at === null ? 'is.null' : `eq.${encodeURIComponent(s.last_tick_at as string)}`
      await crud('PATCH', `/schedule?name=eq.${encodeURIComponent(s.name as string)}&due_at=eq.${encodeURIComponent(s.due_at as string)}&last_tick_at=${previous}`, {
        body: { last_tick_at: s.due_at },
      })
    } catch (cause) {
      errors.push(new Error(`deadline ${s.name} failed`, { cause }))
    }
  }
  if (errors.length) throw new AggregateError(errors, 'edge deadline sweep failed')
  return emitted
}
