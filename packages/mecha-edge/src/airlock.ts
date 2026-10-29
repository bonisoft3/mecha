// The airlock on the edge: runs unsettled rows in airlock.external_effect_ledger
// inside the Durable Object, routing AI calls through bifrost (target:
// "cloudflare", backed by Workers AI binding or REST API) and origin calls
// through fetch, then recording the outcome and moving the machine in PGlite.
import type { PGlite } from '@electric-sql/pglite'
import {
  type AiCapabilitiesConfig,
  BIFROST_PORT,
  type CloudflareAiBinding,
  createBifrost,
} from '../../../services/airlock/bifrost.ts'
import { type Answer, type Effect, outcome, type Outcome, step } from '../../../services/airlock/reentry.ts'
import { backoff } from '../../mecha-browser/clock.ts'

export interface EdgeSink {
  key: string
  fetch(path: unknown, init?: unknown): Promise<{ status: number; body: unknown }>
}

export interface EdgeEffect {
  declaration: Effect
  target: { kind: 'bifrost' | 'origin'; url?: string }
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
}

export interface EdgeAirlock {
  drain(): Promise<number>
  retryAt(): number | null
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
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
  const inFlight = new Set<string>()
  const retries = new Map<string, number>()

  const retryAt = (): number | null => {
    let earliest: number | null = null
    for (const at of retries.values()) {
      if (earliest === null || at < earliest) earliest = at
    }
    return earliest
  }

  function makeSink(spec: EdgeEffect, key: string): EdgeSink {
    const { strings, aiBinding } = extractEnv(cfg.env)
    const bifrost = createBifrost({
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
        const { method = 'GET', body } = (init ?? {}) as { method?: unknown; body?: unknown }
        if (typeof method !== 'string' || !METHODS.has(method)) {
          throw new Error(`sink.fetch method must be GET, POST, PUT or DELETE, got ${JSON.stringify(method)}`)
        }
        let payload: string | undefined
        if (body !== undefined) {
          if (method === 'GET' || method === 'DELETE') throw new Error(`sink.fetch ${method} takes no body`)
          payload = typeof body === 'string' ? body : JSON.stringify(body)
        }
        const headers = new Headers({
          'content-type': 'application/json',
          'Idempotency-Key': encodeURIComponent(key),
          ...credHeader,
        })
        let res: Response
        if (spec.target.kind === 'bifrost') {
          res = await bifrost(
            new Request(`http://bifrost:${BIFROST_PORT}${path}`, {
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
        const text = await res.text()
        let parsed: unknown = text
        try {
          parsed = JSON.parse(text)
        } catch {
          // Non-JSON body stays as text.
        }
        return { status: res.status, body: parsed }
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
        const known = checkAnswer('reconcile', await spec.reconcile(input, sink, secrets))
        if (!('absent' in known)) return outcome(effect, known, true)
      }
      const ans = checkAnswer('issue', await spec.issue(input, sink, secrets))
      if ('failed' in ans) {
        log(`airlock effect ${key} returned failed on attempt ${entered}: ${JSON.stringify(ans.failed)}`)
      }
      return outcome(effect, ans, false)
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

  async function drain(): Promise<number> {
    if (Object.keys(effects).length === 0) return 0
    const present = await serialize(async () => {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT to_regclass('airlock.external_effect_ledger') IS NOT NULL AS ok`)
      return rows[0]?.ok ?? false
    }, 'low')
    if (!present) return 0

    const now = Date.now()
    const { rows } = await serialize(
      () =>
        db.query<{
          key: string
          effect: string
          row: Record<string, unknown>
          input: unknown
          entered: number
          outcome: Outcome | null
        }>(
          `SELECT key, effect, row, input, entered, outcome
             FROM airlock.external_effect_ledger
            WHERE outcome IS NULL
            ORDER BY enqueued_at ASC`,
        ),
      'low',
    )

    let settledCount = 0
    await Promise.all(
      rows.map(async (r) => {
        if (inFlight.has(r.key)) return
        const dueAt = retries.get(r.key)
        if (dueAt !== undefined && dueAt > now) return
        const spec = effects[r.effect]
        if (!spec) {
          log(`${r.key}: effect ${r.effect} is not in effects.json`)
          return
        }
        inFlight.add(r.key)
        let entered = r.entered
        try {
          let settled = r.outcome
          if (settled === null) {
            const { rows: [c] } = await serialize(
              () =>
                db.query<{ entered: number }>(
                  'UPDATE airlock.external_effect_ledger SET entered = entered + 1 WHERE key = $1 RETURNING entered',
                  [r.key],
                ),
              'low',
            )
            entered = c.entered
            settled = await perform(spec, r.key, r.input, entered)
          }
          await settle(r.key, r.row, spec.declaration, settled)
          retries.delete(r.key)
          settledCount++
        } catch (e) {
          log(`airlock effect ${r.key} failed on attempt ${entered}: ${e instanceof Error ? e.message : String(e)}`)
          retries.set(r.key, Date.now() + backoff(Math.max(entered, 1)))
          retry?.()
        } finally {
          inFlight.delete(r.key)
        }
      }),
    )
    return settledCount
  }

  return { drain, retryAt }
}
