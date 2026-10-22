// The ticker on the edge. A schedule — cron, or a machine's one-shot deadline
// (pronto's mecha-ports arm()) — is swept as the container tier's ticker
// sweeps it (services/ticker/sweep.ts), through crud as the service role.
// What differs is the clock, and that nothing is woken past the row: there
// is no change-capture unit here, the row is in the database the sweep wrote
// it to, where a machine's fire trigger answers it. Two clocks, as the ticker
// asks of every tier. The object's alarm stands at the next instant any
// schedule owes a runnable tick, so the object sleeps between occurrences: a
// daily schedule costs the free plan one wake a day, where a minutely poke
// would hold the object awake. The Worker's Cron Trigger pokes from outside
// the object on a coarse cadence, so a tick is never later than that where an
// alarm was lost, and the occurrences a lost span left behind are recorded
// on its pokes rather than chased one wake at a time. A tick records which
// clock minted it.
import type { PGlite } from '@electric-sql/pglite'
import type { EdgeEnv } from './object.ts'
import type { Crud } from '../../../services/ticker/crud.ts'
import { nextOwed, type Schedule } from '../../../services/ticker/due.ts'
import { type Report, sweep } from '../../../services/ticker/sweep.ts'
export type { Report } from '../../../services/ticker/sweep.ts'

export function serviceCrud(service: (req: Request) => Promise<Response>): Crud {
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

/** Whether the data directory holds schedules at all: the table is mecha's,
 * placed where the cluster declares a schedule or a machine a deadline. */
export async function hasSchedules(db: PGlite): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(`SELECT to_regclass('public.schedule') IS NOT NULL AS present`)
  return rows[0].present
}

export type SweepRetry = { through: Date; at: Date }

/** The next instant any unsuspended schedule owes a runnable tick, in ms,
 * or null with none: due.ts's nextOwed over the rows, so the alarm is by
 * construction what the sweep will act on. At or before now means owed now,
 * and the caller clamps. Every schedule owed through `retry.through` is
 * owed at `retry.at` instead, without delaying the ones after: what a sweep
 * at that instant left owed — a Forbid hold, a failed schedule, a backlog
 * past its cap — is not owed again until then. A row nextOwed refuses (a
 * cron that is not five fields) arms nothing: the sweep reports it by name,
 * as the ticker's does, and the object serves on. */
export async function nextDue(db: PGlite, now: Date, retry?: SweepRetry): Promise<number | null> {
  const { rows } = await db.query<Schedule>('SELECT name, cron, due_at, time_zone, max_lateness_seconds, last_tick_at FROM public.schedule WHERE NOT suspended')
  let next: number | null = null
  for (const s of rows) {
    let at: Date | null
    try {
      at = nextOwed(s, now)
    } catch (error) {
      console.error(`schedule ${s.name} arms no alarm: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (at === null) continue
    const due = retry && at <= retry.through ? retry.at.getTime() : at.getTime()
    if (next === null || due < next) next = due
  }
  return next
}

/** The poke, from the Worker that holds the object: its Cron Trigger's
 * `scheduled`, the clock outside the object. Here rather than in object.ts
 * so a Worker needs nothing of the object's runtime to send it. */
export async function pokeCluster(env: EdgeEnv): Promise<void> {
  const res = await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(new Request('https://cluster/poke?caller=cron-trigger', { method: 'POST' }))
  const text = await res.text()
  if (!res.ok) throw new Error(`poke answered ${res.status}: ${text}`)
}

/** Nothing to wake: the row is in the database it was written to. */
const nothing = async () => {}

/** One pass of the ticker as `caller`. */
export function sweepDue(crud: Crud, now: Date, caller: string | null): Promise<Report> {
  return sweep(now, caller, crud, nothing)
}
