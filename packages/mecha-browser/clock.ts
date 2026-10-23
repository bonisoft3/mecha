// The ticker in the clusters that run no ticker service: the page's
// (cluster.ts) and the Durable Object's (mecha-edge). A schedule — cron, or a
// machine's one-shot deadline (pronto's mecha-ports arm()) — is swept as the
// container tier's ticker sweeps it (services/ticker/sweep.ts), through crud as
// the service role. What differs is the clock, and that nothing is woken past
// the row: there is no change-capture unit here, the row is in the database the
// sweep wrote it to, where a drain's trigger (drains.ts) or a machine's fire
// trigger answers it. Each host keeps one timer at the next instant any
// schedule owes a runnable tick, driven by createClock: the object's alarm,
// the page's own timeout.
import type { PGlite } from '@electric-sql/pglite'
import type { Crud } from '../../services/ticker/crud.ts'
import { nextOwed, type Schedule } from '../../services/ticker/due.ts'
import { type Report, sweep } from '../../services/ticker/sweep.ts'
export type { Report } from '../../services/ticker/sweep.ts'

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

/** Whether the database holds schedules at all: the table is mecha's,
 * placed where the cluster declares a schedule or a machine a deadline. */
export async function hasSchedules(db: PGlite): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(`SELECT to_regclass('public.schedule') IS NOT NULL AS present`)
  return rows[0].present
}

/** What a pass left owed at its own instant, owed again at `at`: the schedules
 * `only` names, or every one where it names none. */
export type SweepRetry = { through: Date; at: Date; only?: Set<string> }

/** The next instant any unsuspended schedule owes a runnable tick, in ms,
 * or null with none: due.ts's nextOwed over the rows, so the timer is by
 * construction what the sweep will act on. At or before now means owed now,
 * and the caller clamps. Every schedule owed through `retry.through` is
 * owed at `retry.at` instead, without delaying the ones after: what a sweep
 * at that instant left owed — a Forbid hold, a failed schedule, a backlog
 * past its cap — is not owed again until then. A row nextOwed refuses (a
 * cron that is not five fields) arms nothing: the sweep reports it by name,
 * as the ticker's does, and the cluster serves on. */
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
    const due = retry && at <= retry.through && (retry.only === undefined || retry.only.has(s.name)) ? retry.at.getTime() : at.getTime()
    if (next === null || due < next) next = due
  }
  return next
}

/** Nothing to wake: the row is in the database it was written to. */
const nothing = async () => {}

/** One pass of the ticker as `caller`. */
export function sweepDue(crud: Crud, now: Date, caller: string | null): Promise<Report> {
  return sweep(now, caller, crud, nothing)
}

/** How long what was left owed at its own instant waits after the `n`th pass
 * in a row that left it so: 30 s, doubling, up to an hour. An immediate
 * retry would sweep, decline and re-arm in a loop on a Forbid hold, and call
 * a failing drain as fast as it fails. It is the whole retry: at the edge an
 * alarm() that threw would be run six more times within a minute on top. */
export const backoff = (n: number) => Math.min(30_000 * 2 ** Math.max(n - 1, 0), 3_600_000)

/** The host's one timer: an instant in ms, or none. */
export interface Timer {
  get: () => Promise<number | null>
  set: (at: number) => Promise<void>
  clear: () => Promise<void>
}

export interface ClockConfig {
  db: PGlite
  /** How the host reaches `db` for a read: its chain, where it has one. */
  read: <T>(fn: () => Promise<T>) => Promise<T>
  /** crud as the service role (serviceCrud). */
  crud: Crud
  /** Whether schedules are swept at all: the table exists and the clock runs. */
  ticks: boolean
  /** Another instant the timer must also stand at: a failed drain's retry. */
  also?: () => number | null
  timer: Timer
}

export interface Clock {
  /** The timer at the earliest instant owed, moved only earlier; what the
   * last pass left owed still waits its backoff. */
  arm: () => Promise<void>
  /** One pass of the ticker as `caller`, and the timer re-read from what it
   * left: what is still owed at the pass's own instant waits the backoff, each
   * pass in a row that leaves it so doubling it, while an earlier future
   * deadline keeps its own instant. */
  sweep: (caller: string | null) => Promise<{ report: Report; failed: boolean }>
  /** Resolves when no arm or pass is under way. */
  settled: () => Promise<void>
}

export function createClock(cfg: ClockConfig): Clock {
  const { db, read, timer } = cfg
  /** Passes in a row that left something owed at their own instant. */
  let stuck = 0
  /** What the last pass left owed, by name, and when it is owed again: a
   * write's arm reads through it, or a held schedule would be swept again at
   * once. A schedule it does not name keeps its own instant, so one a write
   * makes owed is swept at once and one failing delays no other. */
  let held: SweepRetry | undefined
  // An arm and a pass never overlap: an arm read before a pass and set after
  // it would start a second pass beside the first.
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }
  async function arm(retry?: SweepRetry) {
    const ticks = cfg.ticks ? await read(() => nextDue(db, new Date(), retry ?? held)) : null
    const also = cfg.also?.() ?? null
    const due = ticks === null ? also : also === null ? ticks : Math.min(ticks, also)
    // Nothing owed: a timer a cancelled deadline left would wake to nothing.
    if (due === null) return timer.clear()
    const standing = await timer.get()
    if (retry || standing === null || due < standing) await timer.set(Math.max(due, Date.now()))
  }
  return {
    arm: () => queued(() => arm()),
    sweep: (caller) => queued(async () => {
      const now = new Date()
      const report = await sweepDue(cfg.crud, now, caller)
      const owed = report.schedules.filter((s) => s.error !== undefined || s.held > 0 || s.behind).map((s) => s.schedule)
      stuck = owed.length ? stuck + 1 : 0
      const at = new Date(Date.now() + backoff(stuck))
      held = owed.length ? { through: now, at, only: new Set(owed) } : undefined
      // The pass's own re-read holds everything owed through its instant: an
      // instant it could not act on and did not report (a zone's skipped hour)
      // would otherwise arm the timer at once, again and again.
      await arm({ through: now, at })
      return { report, failed: report.schedules.some((s) => s.error !== undefined) }
    }),
    settled: () => queued(() => Promise.resolve()),
  }
}
