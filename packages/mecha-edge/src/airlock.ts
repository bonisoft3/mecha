// The airlock on the edge, the object's half: it claims unsettled rows in
// airlock.external_effect_ledger through Graphile, settles what needs no
// network (an outcome already recorded, a bridge not deployed here, a run the
// reentry policy settles unknown), and hands every other run to the
// dispatcher Worker (dispatch.ts) under a lease. A run is counted when the
// dispatcher claims it, not when it is sent, so a send that never arrives
// spends no attempt. The dispatcher's answer settles the ledger and moves the
// machine here, in the object's database
// ([[../../../docs/archive/2026-11-06-edge-airlock-dispatcher]]).
import type { PGlite } from '@electric-sql/pglite'
import { type Effect, ledgerKeySql, outcome, type Outcome, step, undeployed } from '../../../services/airlock/reentry.ts'
import { Logger, runOnce } from 'graphile-worker'
import type { EventEmitter } from 'node:events'
import { GraphilePool } from './graphile-pool.ts'
import { type ClaimedRun, die, type DispatchedRun, type EdgeEffect, HANDLER_TIMEOUT_MS, runBoundMs, type RunAnswer } from './dispatch.ts'

export { die } from './dispatch.ts'
export type { EdgeEffect, EdgeEffects, EdgeSink } from './dispatch.ts'

/** What the object knows of an effect: its declaration and target, never its
 * handler, which only the dispatcher Worker loads. */
export type EdgeEffectDeclarations = Record<string, Pick<EdgeEffect, 'declaration' | 'target'>>

export interface EdgeAirlockConfig {
  db: PGlite
  serialize: <T>(fn: () => Promise<T>, priority?: 'high' | 'low') => Promise<T>
  effects: EdgeEffectDeclarations
  /** Hands one run to the dispatcher; resolves once the run is enqueued, never
   * once it ran. Called after the commit that leased it, never inside one. */
  dispatch: (run: DispatchedRun) => Promise<void>
  log?: (line: string) => void
  retry?: () => void
  /** How long a sent run first waits to be claimed before the object sends it
   * again: the queue's delivery. Each resend of an unclaimed run waits twice
   * as long, up to leaseCapMs, so a backlog is waited out rather than fed. A
   * claim renews the lease for the run's own bound (dispatch.ts runBoundMs). */
  leaseMs?: number
  leaseCapMs?: number
  /** The dispatcher's bound on one handler call, which a claimed run's lease
   * is derived from. */
  handlerTimeoutMs?: number
}

export interface EdgeAirlock {
  drain(): Promise<number>
  retryAt(): number | null
  /** The dispatcher's claim on a run it was sent: the run counted, with its
   * effect, frozen input and number, while the token is the key's current
   * dispatch and the key unsettled; else null, and nothing counted. The same
   * claimant asking again for the same dispatch gets the same run, counted
   * once; any other claimant of it, as a second delivery of the message,
   * gets null. */
  claim(key: string, token: string, claimant: string): Promise<ClaimedRun | null>
  /** The dispatcher's answer for a run: an outcome settles the key, whichever
   * run produced it, once; an error of the current run schedules the next
   * run, or settles unknown on the effect's last attempt. */
  answer(key: string, entered: number, answer: RunAnswer): Promise<void>
}

const CONCURRENCY = 8
const HOUSEKEEPING_MS = 60_000
const LEASE_MS = HANDLER_TIMEOUT_MS + 60_000
const LEASE_CAP_MS = 60 * 60_000
// What a claimed run's lease adds to its bound: the answer's way back.
const ANSWER_MARGIN_MS = 60_000
const q = (name: string) => `"${name.replaceAll('"', '""')}"`
// Graphile's own backoff, which a run's error would have met in its queue.
const backoffSeconds = (entered: number) => Math.round(Math.exp(Math.min(entered, 10)))

export function createEdgeAirlock(cfg: EdgeAirlockConfig): EdgeAirlock {
  const { db, serialize, effects, dispatch, log = console.error, retry, leaseMs = LEASE_MS, leaseCapMs = LEASE_CAP_MS, handlerTimeoutMs = HANDLER_TIMEOUT_MS } = cfg
  const pool = new GraphilePool(db, serialize)
  const failed = (e: unknown) => log(`graphile's pool: ${e instanceof Error ? e.message : String(e)}`)
  pool.on('error', failed)
  pool.on('connect', (client: EventEmitter) => client.on('error', failed))
  const logger = new Logger(() => (level, message) => {
    if (level === 'error' || level === 'warning') log(`graphile: ${message}`)
  })
  // The run_at of the earliest job Graphile holds for later, a lease's expiry
  // included: the alarm stands at it.
  let due: number | null = null
  const retryAt = (): number | null => due
  const spec = (key: string, name: string) => effects[name] ?? die(`${key}: effect ${name} is not in effects.json`)
  // The key's one Graphile job, at a delay: a lease, a retry's backoff. A job
  // that is running keeps its run and gives up the key to this one. Graphile
  // bumps a job's revision each time its key is scheduled again, so the job's
  // id and revision name one dispatch: the token a run is sent under, which a
  // later lease, renewal or backoff makes stale. Its payload carries what the
  // lease is for: how many times an unclaimed run was sent, or the dispatch a
  // claim redeemed and the run it counted.
  type Lease = { sends?: number; claimed?: string; claimant?: string; entered?: number }
  const schedule = async (key: string, ms: number, lease: Lease = {}, on: Pick<PGlite, 'query'> = db): Promise<{ token: string; until: number }> => {
    const { rows: [j] } = await on.query<{ id: string; revision: number; run_at: Date }>(
      `SELECT id, revision, run_at FROM graphile_worker.add_job('external_effect', (jsonb_build_object('key', $1::text) || $3::jsonb)::json, run_at => now() + make_interval(secs => $2), job_key => $1)`,
      [key, ms / 1000, JSON.stringify(lease)])
    return { token: `${j.id}:${j.revision}`, until: new Date(j.run_at).getTime() }
  }

  // The outcome is recorded once; the move follows the recorded one, so an
  // answer delivered again, or a later run's, moves nothing differently.
  async function settle(key: string, rowKey: Record<string, unknown>, effect: Effect, settled: Outcome): Promise<void> {
    await db.query(
      'UPDATE airlock.external_effect_ledger SET outcome = $2::jsonb, settled_at = clock_timestamp() WHERE key = $1 AND outcome IS NULL',
      [key, JSON.stringify(settled)],
    )
    const { rows: [{ outcome: recorded }] } = await db.query<{ outcome: Outcome }>('SELECT outcome FROM airlock.external_effect_ledger WHERE key = $1', [key])
    // Only the invocation the ledger key names moves: a row back in the state
    // for another invocation is that one's, and a late answer leaves it there.
    const match = effect.row.map((c, i) => `${q(c)}::text = $${i + 4}`).join(' AND ')
    const keyed = ledgerKeySql(key.slice(0, key.indexOf(':')), effect)
    const args = [recorded.target, effect.state, key, ...effect.row.map((c) => String(rowKey[c]))]
    const moved = await db.query(`UPDATE ${q(effect.table)} SET ${q(effect.field)} = $1 WHERE ${q(effect.field)} = $2 AND ${keyed} = $3 AND ${match}`, args)
    if ((moved.affectedRows ?? 0) !== 1) {
      const where = effect.row.map((c, i) => `${q(c)}::text = $${i + 2}`).join(' AND ')
      const { rows: [row] } = await db.query<{ at: string; ours: boolean }>(
        `SELECT ${q(effect.field)} AS at, ${keyed} = $1 AS ours FROM ${q(effect.table)} WHERE ${where}`, [key, ...args.slice(3)])
      if (row?.at === effect.state && row.ours) {
        throw new Error(`${key}: ${effect.table} ${JSON.stringify(rowKey)} stays in ${effect.state}: its move to ${recorded.target} was refused`)
      }
    }
  }

  async function readDue(): Promise<void> {
    const { rows: [next] } = await db.query<{ at: Date | null }>(`SELECT min(run_at) AS at FROM graphile_worker._private_jobs
                                                                    WHERE locked_at IS NULL AND attempts < max_attempts`)
    due = next.at === null ? null : new Date(next.at).getTime()
  }

  // An object holds the only worker, so a job locked when it boots was locked
  // by an instance the platform evicted mid-run: Graphile frees it, and its
  // next run reads the ledger's count as any rerun does.
  let unlocked: Promise<void> | null = null
  const unlockEvicted = () =>
    (unlocked ??= serialize(async () => {
      await db.query(`SELECT graphile_worker.force_unlock_workers(array_agg(DISTINCT locked_by))
                        FROM graphile_worker._private_jobs WHERE locked_by IS NOT NULL HAVING count(*) > 0`)
    }, 'low'))

  // The jobs Graphile gave up on, as the container airlock settles them
  // (services/airlock/airlock.ts settleDead): with no outcome, unknown, the
  // queue's last error as its data; with one, moved again.
  let housekept = -Infinity
  async function settleDead(): Promise<number> {
    if (Date.now() - housekept < HOUSEKEEPING_MS) return 0
    housekept = Date.now()
    const { rows } = await serialize(() =>
      db.query<{ key: string; last_error: string | null; effect: string; row: Record<string, unknown>; outcome: Outcome | null }>(`
        SELECT j.key, j.last_error, l.effect, l.row, l.outcome
          FROM graphile_worker._private_jobs j
          JOIN graphile_worker._private_tasks t ON t.id = j.task_id
          JOIN airlock.external_effect_ledger l ON l.key = j.key
         WHERE t.identifier = 'external_effect' AND j.attempts >= j.max_attempts AND j.locked_at IS NULL`), 'low')
    let settled = 0
    for (const r of rows) {
      try {
        const declaration = spec(r.key, r.effect).declaration
        if (r.outcome === null) log(`${r.key}: the queue gave up with no outcome, so unknown: ${r.last_error}`)
        await serialize(() => settle(r.key, r.row, declaration, r.outcome ?? { ...outcome(declaration, 'unknown', false), data: { dead: r.last_error } }), 'low')
        settled++
      } catch (e) {
        log(`${r.key}: not settled at this sweep: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return settled
  }

  let running: Promise<number> | null = null
  let again = false
  function drain(): Promise<number> {
    if (running !== null) {
      again = true
      return running
    }
    running = (async () => {
      let settled = 0
      try {
        do {
          again = false
          settled += await pass()
        } while (again)
      } finally {
        running = null
      }
      return settled
    })()
    return running
  }

  // One run of what Graphile holds due. What needs no network settles here,
  // the reentry policy's verdict on the next run included; anything else is
  // leased in one commit and sent after it, and counted only when the
  // dispatcher claims it. A send that fails, or never happens because the
  // object was evicted after the commit, leaves the lease to send it again.
  async function pass(): Promise<number> {
    if (Object.keys(effects).length === 0) return 0
    const present = await serialize(async () => {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT to_regclass('airlock.external_effect_ledger') IS NOT NULL AS ok`)
      return rows[0]?.ok ?? false
    }, 'low')
    if (!present) return 0
    await unlockEvicted()
    // Graphile announces every insert, a lease's and a backoff's included, so
    // most wakes find nothing due: they settle the dead and stand the alarm.
    const ready = await serialize(async () => {
      const { rows } = await db.query<{ ready: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE t.identifier = 'external_effect' AND j.run_at <= now() AND j.locked_at IS NULL AND j.attempts < j.max_attempts) AS ready`)
      return rows[0].ready
    }, 'low')
    let settled = 0
    if (ready) await runOnce({
      pgPool: pool as unknown as Parameters<typeof runOnce>[0]['pgPool'],
      logger,
      noHandleSignals: true,
      concurrency: CONCURRENCY,
      taskList: {
        external_effect: async (payload) => {
          const { key, sends = 0 } = payload as { key: string } & Lease
          const { rows: [l] } = await serialize(() =>
            db.query<{ effect: string; row: Record<string, unknown>; entered: number; outcome: Outcome | null }>(
              'SELECT effect, row, entered, outcome FROM airlock.external_effect_ledger WHERE key = $1', [key]), 'low')
          if (l === undefined) throw new Error(`airlock.external_effect_ledger holds no ${key}`)
          const declaration = spec(key, l.effect).declaration
          const known = l.outcome ?? undeployed(declaration, 'cloudflare') ?? beyond(declaration, l.entered + 1)
          if (known !== null) {
            await serialize(() => settle(key, l.row, declaration, known), 'low')
            settled++
            return
          }
          // A lease a claim renewed while this job was being taken belongs to a
          // run that may still be calling: this job sends nothing. Otherwise the
          // lease is committed before the message, so no answer can precede it.
          const leased = await serialize(() => db.transaction(async (tx) => {
            const { rows: [held] } = await tx.query<{ held: boolean }>(
              'SELECT EXISTS (SELECT 1 FROM graphile_worker._private_jobs WHERE key = $1 AND run_at > now()) AS held', [key])
            return held.held ? null : await schedule(key, Math.min(leaseMs * 2 ** sends, leaseCapMs), { sends: sends + 1 }, tx)
          }), 'low')
          if (leased === null) return
          // The lease is committed and owns the retry, so this job ends here
          // whatever the send does: a job left failed would outlive its key.
          try {
            await dispatch({ key, token: leased.token })
          } catch (e) {
            log(`${key}: the dispatcher's queue refused run ${sends + 1}, sent again when its lease ends: ${e instanceof Error ? e.message : String(e)}`)
          }
        },
      },
    })
    settled += await settleDead()
    const before = due
    await serialize(readDue, 'low')
    // A settle may have armed a machine's deadline, and a lease or retry may
    // have moved or ended: either re-reads the clock, and a wake that changed
    // neither leaves it standing.
    if (settled > 0 || due !== before) retry?.()
    return settled
  }

  // What the reentry policy settles without a run, as the container's task
  // does when the ledger counts a run past what its effect allows.
  const beyond = (declaration: Effect, entered: number): Outcome | null =>
    entered > declaration.attempts || step(declaration, entered) === 'unknown' ? outcome(declaration, 'unknown', false) : null

  // A claim redeems the dispatch it was sent under: it counts the run and
  // renews its lease for as long as the run can still call its sink, which
  // also makes the token stale, so a second delivery of the same message
  // claims nothing. A key the ledger no longer holds, as after a reset, is no
  // run's. Whether the run may happen is decided again here, on the number the
  // claim produces, since the ledger is the one that counts.
  async function claim(key: string, token: string, claimant: string): Promise<ClaimedRun | null> {
    const claimed = await serialize(() => db.transaction(async (tx) => {
      const { rows: [current] } = await tx.query<{ token: string; payload: Lease; run_at: Date }>(
        `SELECT id || ':' || revision AS token, payload, run_at FROM graphile_worker._private_jobs WHERE key = $1 AND locked_at IS NULL`, [key])
      if (current === undefined) return null
      // The same dispatch asked again, as after a reply lost on the way back:
      // the run it counted, counted once.
      if (current.token !== token) {
        if (current.payload.claimed !== token || current.payload.claimant !== claimant) return null
        const { rows: [l] } = await tx.query<{ effect: string; input: unknown }>(
          'SELECT effect, input FROM airlock.external_effect_ledger WHERE key = $1 AND outcome IS NULL AND entered = $2', [key, current.payload.entered])
        if (l === undefined) return null
        return { kind: 'run' as const, run: { effect: l.effect, input: l.input, entered: current.payload.entered!, until: new Date(current.run_at).getTime() } }
      }
      const { rows: [l] } = await tx.query<{ effect: string; input: unknown; row: Record<string, unknown>; entered: number }>(
        `UPDATE airlock.external_effect_ledger SET entered = entered + 1 WHERE key = $1 AND outcome IS NULL
         RETURNING effect, input, row, entered`, [key])
      if (l === undefined) return null
      const declaration = spec(key, l.effect).declaration
      const settles = beyond(declaration, l.entered)
      if (settles !== null) return { kind: 'settles' as const, settles, row: l.row, declaration }
      const { until } = await schedule(key, runBoundMs(declaration, l.entered, handlerTimeoutMs) + ANSWER_MARGIN_MS, { claimed: token, claimant, entered: l.entered }, tx)
      return { kind: 'run' as const, run: { effect: l.effect, input: l.input, entered: l.entered, until } }
    }), 'low')
    if (claimed === null) return null
    if (claimed.kind === 'run') return claimed.run
    await serialize(async () => {
      await settle(key, claimed.row, claimed.declaration, claimed.settles)
      await db.query('SELECT graphile_worker.remove_job($1)', [key])
    }, 'low')
    // A settle may arm a machine's deadline; the removal's own wake would
    // find nothing changed.
    await serialize(readDue, 'low')
    retry?.()
    return null
  }

  async function answer(key: string, entered: number, given: RunAnswer): Promise<void> {
    // Answers, drains and settles share the object's one serialized
    // connection, so a read here holds until this answer is applied.
    const settled = await serialize(async () => {
      const { rows: [l] } = await db.query<{ effect: string; row: Record<string, unknown>; entered: number; outcome: Outcome | null }>(
        'SELECT effect, row, entered, outcome FROM airlock.external_effect_ledger WHERE key = $1', [key])
      if (l === undefined) throw new Error(`airlock.external_effect_ledger holds no ${key}`)
      const declaration = spec(key, l.effect).declaration
      if ('outcome' in given) {
        await settle(key, l.row, declaration, given.outcome)
        await db.query('SELECT graphile_worker.remove_job($1)', [key])
        return true
      }
      // An error from a run the object has moved past, or after the key
      // settled, changes nothing: the current run's own answer decides.
      if (l.outcome !== null || l.entered !== entered) return false
      if (entered >= declaration.attempts) {
        log(`${key}: no answer after ${entered} runs, so unknown: ${given.error}`)
        await settle(key, l.row, declaration, outcome(declaration, 'unknown', false))
        await db.query('SELECT graphile_worker.remove_job($1)', [key])
        return true
      }
      log(`${key}: run ${entered} failed: ${given.error}`)
      await schedule(key, backoffSeconds(entered) * 1000)
      return false
    }, 'low')
    // A settle may arm a machine's deadline; a backoff's own wake re-reads
    // the clock when the retry moves it.
    if (!settled) return
    await serialize(readDue, 'low')
    retry?.()
  }

  return { drain, retryAt, claim, answer }
}
