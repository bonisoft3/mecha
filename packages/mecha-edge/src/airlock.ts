// The airlock on the edge: runs unsettled rows in airlock.external_effect_ledger
// inside the Durable Object, routing AI calls through tsbifrost (target:
// "cloudflare", backed by Workers AI binding or REST API) and origin calls
// through fetch, then recording the outcome and moving the machine in PGlite.
import type { PGlite } from '@electric-sql/pglite'
import {
  type AiCapabilitiesConfig,
  TSBIFROST_PORT,
  type CloudflareAiBinding,
  createTsBifrost,
} from '../../../services/airlock/tsbifrost.ts'
import { type Answer, CALL_TIMEOUT_MS, type Effect, outcome, type Outcome, sinkHeaders, step } from '../../../services/airlock/reentry.ts'
import { type BlobStore, stowed } from '../../../services/airlock/blobs.ts'
import { Logger, runOnce } from 'graphile-worker'
import type { EventEmitter } from 'node:events'
import { GraphilePool } from './graphile-pool.ts'

export interface EdgeSink {
  key: string
  fetch(path: unknown, init?: unknown): Promise<{ status: number; body: unknown }>
}

export interface EdgeEffect {
  declaration: Effect
  target: { kind: 'tsbifrost' | 'origin'; url?: string }
  issue(input: unknown, sink: EdgeSink, secrets: Record<string, string>): Promise<unknown> | unknown
  reconcile?(input: unknown, sink: EdgeSink, secrets: Record<string, string>): Promise<unknown> | unknown
}

export type EdgeEffects = Record<string, EdgeEffect>

export interface EdgeAirlockConfig {
  db: PGlite
  serialize: <T>(fn: () => Promise<T>, priority?: 'high' | 'low') => Promise<T>
  effects: EdgeEffects
  ai?: AiCapabilitiesConfig
  env?: Record<string, unknown>
  fetcher?: typeof fetch
  log?: (line: string) => void
  retry?: () => void
  callTimeoutMs?: number
  handlerTimeoutMs?: number
  /** The blob plane an answer's bytes go to; absent without one. */
  blobs?: BlobStore
}

export interface EdgeAirlock {
  drain(): Promise<number>
  retryAt(): number | null
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])

// A call that never answers held its key in flight for as long as the object
// lived, so every drain skipped it without a word and its row never moved:
// each call and each handler run is bounded, as the container airlock bounds
// them (services/airlock/handler.ts): Graphile holds a job that never returns
// locked for hours, and a run past its bound is a failed attempt it retries.
// Effects of one drain run side by side, as the drain ran them before Graphile:
// a deck's twenty illustrations do not wait on one another.
const CONCURRENCY = 8
const HOUSEKEEPING_MS = 60_000
const HANDLER_TIMEOUT_MS = 90_000
async function within<T>(ms: number, what: string, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([run, timeout])
  } finally {
    clearTimeout(timer)
  }
}
const q = (name: string) => `"${name.replaceAll('"', '""')}"`

function extractEnv(raw: Record<string, unknown> = {}): {
  strings: Record<string, string | undefined>
  aiBinding?: CloudflareAiBinding
} {
  const strings: Record<string, string | undefined> = {}
  let aiBinding: CloudflareAiBinding | undefined
  const directAi = raw && typeof raw === 'object' ? (raw as { AI?: unknown }).AI : undefined
  if (directAi !== null && typeof directAi === 'object' && typeof (directAi as CloudflareAiBinding).run === 'function') {
    aiBinding = directAi as CloudflareAiBinding
  }
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') strings[k] = v
    else if (!aiBinding && k === 'AI' && v !== null && typeof v === 'object' && typeof (v as CloudflareAiBinding).run === 'function') {
      aiBinding = v as CloudflareAiBinding
    }
  }
  return { strings, aiBinding }
}

function checkAnswer(call: 'issue' | 'reconcile', result: unknown): Answer {
  const keys = typeof result === 'object' && result !== null && !Array.isArray(result) ? Object.keys(result) : []
  if (keys.length !== 1) {
    throw new TypeError(`${call} must return {done}, {failed}${call === 'reconcile' ? ', {absent: true}' : ''} or {retry}, got ${JSON.stringify(result)}`)
  }
  const [k] = keys
  const v = (result as Record<string, unknown>)[k]
  if (k === 'retry') {
    if (typeof v !== 'string' || v === '') throw new TypeError(`${call} {retry} must be a non-empty string`)
    throw new Error(`the sink asked for a retry: ${v}`)
  }
  if (k === 'absent') {
    if (call !== 'reconcile' || v !== true) throw new TypeError('{absent: true} is only an answer from reconcile')
    return { absent: true }
  }
  if (k !== 'done' && k !== 'failed') throw new TypeError(`${call} returned unknown key ${k}`)
  let text: string | undefined
  try {
    text = JSON.stringify(v)
  } catch {
    text = undefined
  }
  if (text === undefined) throw new TypeError(`${call} {${k}} is not JSON`)
  return { [k]: JSON.parse(text) } as Answer
}

export function createEdgeAirlock(cfg: EdgeAirlockConfig): EdgeAirlock {
  const { db, serialize, effects, ai, fetcher = fetch, log = console.error, retry } = cfg
  const { callTimeoutMs = CALL_TIMEOUT_MS, handlerTimeoutMs = HANDLER_TIMEOUT_MS } = cfg
  const pool = new GraphilePool(db, serialize)
  const failed = (e: unknown) => log(`graphile's pool: ${e instanceof Error ? e.message : String(e)}`)
  pool.on('error', failed)
  pool.on('connect', (client: EventEmitter) => client.on('error', failed))
  const logger = new Logger(() => (level, message) => {
    if (level === 'error' || level === 'warning') log(`graphile: ${message}`)
  })
  // The run_at of the earliest job Graphile holds for later, read after each
  // drain: the alarm stands at it.
  let due: number | null = null
  const retryAt = (): number | null => due

  function makeSink(spec: EdgeEffect, key: string): EdgeSink {
    const { strings, aiBinding } = extractEnv(cfg.env)
    const tsbifrost = createTsBifrost({
      target: 'cloudflare',
      config: ai,
      env: strings,
      aiBinding,
      fetcher,
    })
    const credHeader: Record<string, string> = {}
    if (spec.declaration.credential) {
      const { header, scheme, secret } = spec.declaration.credential
      const val = strings[secret]
      if (val) credHeader[header] = scheme ? `${scheme} ${val}` : val
    }

    return {
      key,
      async fetch(path: unknown, init: unknown = {}): Promise<{ status: number; body: unknown }> {
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
          throw new Error(`sink.fetch path must begin with one '/', got ${JSON.stringify(path)}`)
        }
        const { method = 'GET', body, headers: asked } = (init ?? {}) as { method?: unknown; body?: unknown; headers?: unknown }
        if (typeof method !== 'string' || !METHODS.has(method)) {
          throw new Error(`sink.fetch method must be GET, POST, PUT or DELETE, got ${JSON.stringify(method)}`)
        }
        let payload: string | undefined
        if (body !== undefined) {
          if (method === 'GET' || method === 'DELETE') throw new Error(`sink.fetch ${method} takes no body`)
          payload = typeof body === 'string' ? body : JSON.stringify(body)
        }
        const headers = new Headers({
          ...sinkHeaders(asked, spec.declaration.credential ? [spec.declaration.credential.header] : []),
          'content-type': 'application/json',
          'Idempotency-Key': encodeURIComponent(key),
          ...credHeader,
        })
        const answered = await within(callTimeoutMs, `${key}: ${method} ${path}`, (async () => {
          let res: Response
          if (spec.target.kind === 'tsbifrost') {
            res = await tsbifrost(
              new Request(`http://tsbifrost:${TSBIFROST_PORT}${path}`, {
                method,
                headers,
                ...(payload !== undefined ? { body: payload } : {}),
              }),
            )
          } else {
            const url = new URL(path, spec.target.url)
            res = await fetcher(url.href, {
              method,
              headers,
              ...(payload !== undefined ? { body: payload } : {}),
            })
          }
          return { status: res.status, text: await res.text() }
        })())
        let parsed: unknown = answered.text
        try {
          parsed = JSON.parse(answered.text)
        } catch {
          // Non-JSON body stays as text.
        }
        return { status: answered.status, body: parsed }
      },
    }
  }

  function readSecrets(spec: EdgeEffect): Record<string, string> {
    const { strings } = extractEnv(cfg.env)
    const out: Record<string, string> = {}
    for (const name of spec.declaration.secrets ?? []) {
      out[name] = strings[name] ?? ''
    }
    return out
  }

  async function perform(spec: EdgeEffect, key: string, input: unknown, entered: number): Promise<Outcome> {
    const effect = spec.declaration
    if (entered > effect.attempts) return outcome(effect, 'unknown', false)
    const next = step(effect, entered)
    if (next === 'unknown') return outcome(effect, 'unknown', false)
    const sink = makeSink(spec, key)
    const secrets = readSecrets(spec)
    try {
      if (next === 'reconcile') {
        if (!spec.reconcile) throw new TypeError(`effect ${effect.handler} exports no reconcile function`)
        const known = checkAnswer('reconcile', await within(handlerTimeoutMs, `effect ${effect.handler}: reconcile`, Promise.resolve(spec.reconcile(input, sink, secrets))))
        if (!('absent' in known)) return outcome(effect, await stowed(known, key, cfg.blobs), true)
      }
      const ans = checkAnswer('issue', await within(handlerTimeoutMs, `effect ${effect.handler}: issue`, Promise.resolve(spec.issue(input, sink, secrets))))
      if ('failed' in ans) {
        log(`airlock effect ${key} returned failed on attempt ${entered}: ${JSON.stringify(ans.failed)}`)
      }
      return outcome(effect, await stowed(ans, key, cfg.blobs), false)
    } catch (e) {
      if (entered < effect.attempts) throw e
      log(`${key}: no answer after ${entered} runs, so unknown: ${e instanceof Error ? e.message : String(e)}`)
      return outcome(effect, 'unknown', false)
    }
  }

  async function settle(key: string, rowKey: Record<string, unknown>, effect: Effect, settled: Outcome): Promise<void> {
    await serialize(async () => {
      await db.query(
        'UPDATE airlock.external_effect_ledger SET outcome = $2::jsonb, settled_at = clock_timestamp() WHERE key = $1 AND outcome IS NULL',
        [key, JSON.stringify(settled)],
      )
      const match = effect.row.map((c, i) => `${q(c)}::text = $${i + 3}`).join(' AND ')
      const args = [settled.target, effect.state, ...effect.row.map((c) => String(rowKey[c]))]
      const moved = await db.query(
        `UPDATE ${q(effect.table)} SET ${q(effect.field)} = $1 WHERE ${q(effect.field)} = $2 AND ${match}`,
        args,
      )
      if ((moved.affectedRows ?? 0) !== 1) {
        const where = effect.row.map((c, i) => `${q(c)}::text = $${i + 1}`).join(' AND ')
        const { rows: [row] } = await db.query<{ at: string }>(
          `SELECT ${q(effect.field)} AS at FROM ${q(effect.table)} WHERE ${where}`,
          args.slice(2),
        )
        if (row?.at === effect.state) {
          throw new Error(`${key}: ${effect.table} ${JSON.stringify(rowKey)} stays in ${effect.state}: its move to ${settled.target} was refused`)
        }
      }
    })
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
  // queue's last error as its data; with one, moved again. Graphile's row stays
  // as the record, so this is housekeeping at most once a minute, not every
  // drain; each row is its own attempt, since one bad row is no reason to run
  // no effect at all.
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
        const spec = effects[r.effect] ?? die(`${r.key}: effect ${r.effect} is not in effects.json`)
        if (r.outcome === null) log(`${r.key}: the queue gave up with no outcome, so unknown: ${r.last_error}`)
        await settle(r.key, r.row, spec.declaration, r.outcome ?? { ...outcome(spec.declaration, 'unknown', false), data: { dead: r.last_error } })
        settled++
      } catch (e) {
        log(`${r.key}: not settled at this sweep: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return settled
  }

  // Every write and every enqueue asks for a drain, a deck's fan-out twenty at
  // once: one pass runs, and one more follows it if anything asked meanwhile.
  let running: Promise<number> | null = null
  let again = false
  function drain(): Promise<number> {
    if (running !== null) {
      again = true
      return running
    }
    // Cleared in the same turn as the last check of `again`: a later finally
    // would leave a gap where a request joins a pass that is already over.
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

  // One run of what Graphile holds due, as the container's task runs it: the
  // ledger's count before the call, the outcome, then the move. A throw is a
  // failed attempt Graphile records and schedules again.
  async function pass(): Promise<number> {
    if (Object.keys(effects).length === 0) return 0
    const present = await serialize(async () => {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT to_regclass('airlock.external_effect_ledger') IS NOT NULL AS ok`)
      return rows[0]?.ok ?? false
    }, 'low')
    if (!present) return 0
    await unlockEvicted()
    let settled = 0
    await runOnce({
      pgPool: pool as unknown as Parameters<typeof runOnce>[0]['pgPool'],
      logger,
      noHandleSignals: true,
      concurrency: CONCURRENCY,
      taskList: {
        external_effect: async (payload) => {
          const { key } = payload as { key: string }
          const { rows: [l] } = await serialize(() =>
            db.query<{ effect: string; row: Record<string, unknown>; input: unknown; outcome: Outcome | null }>(
              'SELECT effect, row, input, outcome FROM airlock.external_effect_ledger WHERE key = $1',
              [key],
            ), 'low')
          if (l === undefined) throw new Error(`airlock.external_effect_ledger holds no ${key}`)
          const spec = effects[l.effect] ?? die(`${key}: effect ${l.effect} is not in effects.json`)
          let answer = l.outcome
          if (answer === null) {
            const { rows: [c] } = await serialize(() =>
              db.query<{ entered: number }>(
                'UPDATE airlock.external_effect_ledger SET entered = entered + 1 WHERE key = $1 RETURNING entered',
                [key],
              ), 'low')
            answer = await perform(spec, key, l.input, c.entered)
          }
          await settle(key, l.row, spec.declaration, answer)
          settled++
        },
      },
    })
    settled += await settleDead()
    const { rows: [next] } = await serialize(() =>
      db.query<{ at: Date | null }>(`SELECT min(run_at) AS at FROM graphile_worker._private_jobs
                                      WHERE locked_at IS NULL AND attempts < max_attempts`), 'low')
    due = next.at === null ? null : new Date(next.at).getTime()
    if (due !== null) retry?.()
    return settled
  }

  return { drain, retryAt }
}

function die(message: string): never {
  throw new Error(message)
}
