// The edge airlock's dispatcher: the Worker that runs an effect's handler
// against its sink, apart from the database's Durable Object
// ([[../../../docs/archive/2026-11-06-edge-airlock-dispatcher]]). The object
// claims and settles (airlock.ts); this module performs one run of a claimed
// effect and answers the object with its outcome or its error.
import {
  type AiCapabilitiesConfig,
  TSBIFROST_PORT,
  type CloudflareAiBinding,
  createTsBifrost,
} from '../../../services/airlock/tsbifrost.ts'
import { type Answer, CALL_TIMEOUT_MS, type Effect, encodedBody, ORIGIN, outcome, type Outcome, sinkHeaders, step } from '../../../services/airlock/reentry.ts'
import { type BlobStore, contentBlob, stowed } from '../../../services/airlock/blobs.ts'
import { openFields, type SealKeys, sealKeys } from '../../../services/airlock/seal.ts'

export interface EdgeSink {
  key: string
  fetch(path: unknown, init?: unknown): Promise<{ status: number; body: unknown }>
  /** A content-addressed blob, checked against its key (blobs.ts contentBlob). */
  blob(key: unknown): Promise<Uint8Array>
  /** The deployment's origin, for a sink that calls or links back. */
  readonly origin: string
}

/** A bridge's container on cloudflare: a Durable Object namespace of this
 * Worker whose stub (bridge.ts) starts the container and proxies to its
 * port, and rejects what the infrastructure fails at. */
export interface ContainerBinding {
  getByName(name: string): { fetch(request: Request): Promise<Response> }
}

/** An isolate hatch's Worker, as the dispatcher's service binding holds it. */
export interface IsolateBinding {
  fetch(request: Request): Promise<Response>
}

export interface EdgeEffect {
  declaration: Effect
  /** A `container` is a bridge deployed here, called through its binding; an
   * `isolate` is one deployed here as a Worker of its own, called through its
   * service binding; a `bridge` is one deployed elsewhere, whose effect the
   * object settles failed without dispatching it. An `origin` named by
   * `secret` is this deployment's, read from the dispatcher's environment at
   * each run. */
  target:
    | { kind: 'tsbifrost'; url?: string }
    | { kind: 'origin'; url: string }
    | { kind: 'origin'; secret: string }
    | { kind: 'bridge'; bridge: string }
    | { kind: 'container'; bridge: string; binding: string }
    | { kind: 'isolate'; bridge: string; binding: string }
  issue(input: unknown, sink: EdgeSink, secrets: Record<string, string>): Promise<unknown> | unknown
  reconcile?(input: unknown, sink: EdgeSink, secrets: Record<string, string>): Promise<unknown> | unknown
}

export type EdgeEffects = Record<string, EdgeEffect>

/** One run as the object hands it to the dispatcher: the ledger key and the
 * dispatch it was sent under, which only one claim can redeem. */
export interface DispatchedRun {
  key: string
  token: string
}

/** A run the object counted when the dispatcher claimed it: its effect,
 * frozen input, and number, which the object fences answers by, and the
 * instant its lease ends, past which the object may run it again. */
export interface ClaimedRun {
  effect: string
  input: unknown
  /** The invoking row's primary key, as the ledger names it. */
  row: Record<string, unknown>
  entered: number
  until: number
  /** The row's secret fields, sealed, from the object's memory: what the
   * dispatcher opens for the handler, absent where none was held. */
  sealed?: Record<string, string>
}

/** What a dispatcher answers the object for one run. */
export type RunAnswer = { outcome: Outcome } | { error: string }

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])
export const HANDLER_TIMEOUT_MS = 90_000

/** The longest a claimed run can still be calling its sink: reconcile where
 * the reentry policy asks for it, issue, and stowing the answer's bytes, each
 * bounded by the handler's bound. The object leases a claimed run for this,
 * so it never dispatches the next run while this one can still issue. */
export function runBoundMs(effect: Effect, entered: number, handlerTimeoutMs = HANDLER_TIMEOUT_MS): number {
  return (step(effect, entered) === 'reconcile' ? 3 : 2) * handlerTimeoutMs
}

// Each call and each handler run is bounded, as the container airlock bounds
// them (services/airlock/handler.ts): a run past its bound is an error the
// object schedules again.
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

function extractEnv(raw: Record<string, unknown> = {}): {
  strings: Record<string, string | undefined>
  aiBinding?: CloudflareAiBinding
} {
  const strings: Record<string, string | undefined> = {}
  let aiBinding: CloudflareAiBinding | undefined
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') strings[k] = v
    else if (k === 'AI' && v !== null && typeof v === 'object' && typeof (v as CloudflareAiBinding).run === 'function') {
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
  return { [k]: v } as Answer
}

// Stowing replaces any {$blob: {bytes: Uint8Array, type}} with its served URL
// first; a JSON round-trip before stowing would turn Uint8Array into a plain
// object that stowed() then refuses.
function jsonAnswer(call: 'issue' | 'reconcile', answer: Answer): Answer {
  if ('absent' in answer) return answer
  const k = 'done' in answer ? 'done' : 'failed'
  const v = 'done' in answer ? answer.done : answer.failed
  let text: string | undefined
  try {
    text = JSON.stringify(v)
  } catch {
    text = undefined
  }
  if (text === undefined) throw new TypeError(`${call} {${k}} is not JSON`)
  return { [k]: JSON.parse(text) } as Answer
}

export interface PerformConfig {
  ai?: AiCapabilitiesConfig
  env?: Record<string, unknown>
  fetcher?: typeof fetch
  log?: (line: string) => void
  callTimeoutMs?: number
  handlerTimeoutMs?: number
  /** The blob plane an answer's bytes go to and a handler's content keys are
   * read from; absent without one. */
  blobs?: BlobStore
  /** The release's origin: sink.origin. */
  origin?: string
}

function containerStub(env: Record<string, unknown> | undefined, binding: string, bridge: string) {
  const namespace = env?.[binding] as ContainerBinding | undefined
  if (typeof namespace?.getByName !== 'function') {
    throw new Error(`${binding} is not a Durable Object binding of this dispatcher: the bridge ${bridge} is on cloudflare and its container is not bound`)
  }
  return namespace.getByName(bridge)
}

function isolateService(env: Record<string, unknown> | undefined, binding: string, bridge: string): IsolateBinding {
  const service = env?.[binding] as IsolateBinding | undefined
  if (typeof service?.fetch !== 'function') {
    throw new Error(`${binding} is not a service binding of this dispatcher: the bridge ${bridge} is an isolate on cloudflare and its Worker is not bound`)
  }
  return service
}

// Read before the handler runs, so a deployment missing its origin, or holding
// something else there, fails the run without calling anywhere. The value is
// never echoed: a key put in the wrong secret would land in the log.
function sinkOrigin(target: { url: string } | { secret: string }, strings: Record<string, string | undefined>, handler: string): string {
  if ('url' in target) return target.url
  const value = strings[target.secret] || die(`effect ${handler}: origin secret ${target.secret} is not set on this deployment`)
  if (!ORIGIN.test(value)) throw new Error(`effect ${handler}: origin secret ${target.secret} is not an https origin without a path`)
  return value
}

function makeSink(spec: EdgeEffect, key: string, cfg: PerformConfig, { strings, aiBinding }: ReturnType<typeof extractEnv>): EdgeSink {
  const { fetcher = fetch, callTimeoutMs = CALL_TIMEOUT_MS } = cfg
  const tsbifrost = createTsBifrost({ target: 'cloudflare', config: cfg.ai, env: strings, aiBinding, fetcher })
  const credHeader: Record<string, string> = {}
  if (spec.declaration.credential) {
    const { header, scheme, secret } = spec.declaration.credential
    const val = strings[secret]
    // Fails the run instead of calling the sink unauthenticated.
    if (!val) throw new Error(`effect ${spec.declaration.handler}: secret ${secret} is not set on this deployment`)
    credHeader[header] = scheme ? `${scheme} ${val}` : val
  }
  const base = spec.target.kind === 'origin' ? sinkOrigin(spec.target, strings, spec.declaration.handler) : undefined
  return {
    key,
    blob: (blobKey: unknown) => contentBlob(cfg.blobs, blobKey),
    get origin(): string {
      return cfg.origin ?? die(`${key}: this release names no origin: give it a domain`)
    },
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
        payload = encodedBody(spec.declaration.contentType, body)
      }
      const headers = new Headers({
        ...sinkHeaders(asked, spec.declaration.credential ? [spec.declaration.credential.header] : []),
        'content-type': spec.declaration.contentType ?? 'application/json',
        'Idempotency-Key': encodeURIComponent(key),
        ...credHeader,
      })
      const request = { method, headers, ...(payload !== undefined ? { body: payload } : {}) }
      const answered = await within(callTimeoutMs, `${key}: ${method} ${path}`, (async () => {
        let res: Response
        if (spec.target.kind === 'tsbifrost') {
          res = await tsbifrost(new Request(`http://tsbifrost:${TSBIFROST_PORT}${path}`, request))
        } else if (spec.target.kind === 'origin') {
          res = await fetcher(new URL(path, base).href, request)
        } else if (spec.target.kind === 'container' || spec.target.kind === 'isolate') {
          // A container's stub dials the class's own port, and an isolate's
          // service binding its Worker, so the URL names only the bridge. What
          // either answers is the sink's answer; what the infrastructure fails
          // at (no instance while a first deploy provisions, a port never
          // ready, a connection lost mid-flight, an isolate that threw) the
          // binding rejects, and the run errs as on an origin's transport.
          const { bridge, binding } = spec.target
          const bound = spec.target.kind === 'container' ? containerStub(cfg.env, binding, bridge) : isolateService(cfg.env, binding, bridge)
          res = await bound.fetch(new Request(`http://${bridge}${path}`, request))
        } else {
          throw new Error(`${key}: bridge ${spec.target.bridge} is not deployed on cloudflare and has no sink here`)
        }
        return { status: res.status, text: await res.text() }
      })())
      let parsed: unknown = answered.text
      try {
        parsed = JSON.parse(answered.text)
      } catch {
        // A body that is not JSON stays text, as the container's sink answers it.
      }
      return { status: answered.status, body: parsed }
    },
  }
}

/** One run of a claimed effect: reconcile where its reentry policy asks, then
 * issue. A throw is the run's error, which the object retries or settles
 * `unknown` on the effect's last attempt. */
export async function performEffect(spec: EdgeEffect, run: { key: string; entered: number; row?: Record<string, unknown>; sealed?: Record<string, string> }, input: unknown, cfg: PerformConfig = {}): Promise<Outcome> {
  const { log = console.error, handlerTimeoutMs = HANDLER_TIMEOUT_MS } = cfg
  const effect = spec.declaration
  const { key, entered } = run
  const env = extractEnv(cfg.env)
  const sink = makeSink(spec, key, cfg, env)
  const { strings } = env
  const typed: Record<string, string> = {}
  if (effect.secretFields?.length) {
    // The object held the sealed values in memory; this Worker alone holds
    // the key that opens them. One the object lost, as to an eviction, is a
    // value never written: the first run fails, a later one is unknown.
    const keys = await sealKeysOf(strings)
    const opened = await openFields(keys, effect.table, String(run.row?.[effect.row[0]]), effect.secretFields, run.sealed ?? {})
    if (opened.missing) return entered > 1 ? outcome(effect, 'unknown', false) : outcome(effect, { failed: opened.missing }, false)
    Object.assign(typed, opened.values)
  }
  const secrets = { ...Object.fromEntries((effect.secrets ?? []).map(name => [name, strings[name] || die(`effect ${effect.handler}: secret ${name} is not set on this deployment`)])), ...typed }
  const stow = async (call: 'issue' | 'reconcile', answer: Answer) =>
    jsonAnswer(call, await within(handlerTimeoutMs, `${key}: storing the answer's bytes`, stowed(answer, key, cfg.blobs)))
  if (step(effect, entered) === 'reconcile') {
    if (!spec.reconcile) throw new TypeError(`effect ${effect.handler} exports no reconcile function`)
    const known = checkAnswer('reconcile', await within(handlerTimeoutMs, `effect ${effect.handler}: reconcile`, Promise.resolve(spec.reconcile(input, sink, secrets))))
    if (!('absent' in known)) return outcome(effect, await stow('reconcile', known), true)
  }
  const ans = await stow('issue', checkAnswer('issue', await within(handlerTimeoutMs, `effect ${effect.handler}: issue`, Promise.resolve(spec.issue(input, sink, secrets)))))
  if ('failed' in ans) log(`airlock effect ${key} returned failed on attempt ${entered}: ${JSON.stringify(ans.failed)}`)
  return outcome(effect, ans, false)
}

// The dispatcher's seal key and the one a rotation replaced, imported once
// per isolate for as long as the deployment's secrets stay the same.
let sealed: { from: string; keys: Promise<SealKeys> } | undefined
function sealKeysOf(strings: Record<string, string | undefined>): Promise<SealKeys> {
  const current = strings.AIRLOCK_SEAL_KEY || die('an effect reads a secret field, and AIRLOCK_SEAL_KEY is not set on this deployment')
  const previous = strings.AIRLOCK_SEAL_KEY_PREVIOUS || undefined
  const from = `${current}\n${previous ?? ''}`
  if (sealed?.from !== from) sealed = { from, keys: sealKeys(current, previous) }
  return sealed.keys
}

/** The cluster object's side of the protocol, as the dispatcher reaches it. */
export interface ClusterRuns {
  effectClaim(key: string, token: string, claimant: string): Promise<ClaimedRun | null>
  effectAnswer(key: string, entered: number, answer: RunAnswer): Promise<void>
}

// The object's two calls are retried a few times on what Cloudflare marks
// retryable (an object reset, a connection lost on the way), never on a
// refusal: a lost answer would wait out the lease, and an effect that
// settles unknown on a second run would be settled unknown for nothing. A
// claim may be asked again for the same dispatch, so a lost reply costs
// nothing. An answer the object refuses while its directory loads is held
// until the run's lease would end, then fails loudly: past that the object
// may already be running it again.
const RPC_ATTEMPTS = 4
const RPC_BACKOFF_MS = 200
const LOADING = 'the data directory is loading'
const loading = (e: unknown) => e instanceof Error && e.message.includes(LOADING)
async function reaching<T>(call: () => Promise<T>, backoffMs: number, until = -Infinity, now = Date.now): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      const retryable = typeof e === 'object' && e !== null && (e as { retryable?: unknown }).retryable === true && (e as { overloaded?: unknown }).overloaded !== true
      const wait = backoffMs * 2 ** Math.min(attempt - 1, 10)
      if (loading(e) && now() + wait < until) {
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      if (!retryable || attempt >= RPC_ATTEMPTS) throw e
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** Runs one dispatched run end to end: a claim the object still holds, the
 * handler, the answer. A run the object has moved past is skipped unrun; an
 * effect this dispatcher does not know, as while a publish deploys the
 * object before it, is the run's error. */
export async function dispatchRun(cluster: ClusterRuns, effects: EdgeEffects, run: DispatchedRun, cfg: PerformConfig & { rpcBackoffMs?: number; now?: () => number } = {}): Promise<'answered' | 'superseded'> {
  const backoff = cfg.rpcBackoffMs ?? RPC_BACKOFF_MS
  // This delivery's own name: asked again after a lost reply, the claim it
  // made comes back; a second delivery of the same message claims nothing.
  const claimant = crypto.randomUUID()
  const claimed = await reaching(() => cluster.effectClaim(run.key, run.token, claimant), backoff)
  if (claimed === null) return 'superseded'
  const { entered } = claimed
  let answer: RunAnswer
  try {
    const spec = effects[claimed.effect] ?? die(`${run.key}: effect ${claimed.effect} is not in this dispatcher's effects.json`)
    answer = { outcome: await performEffect(spec, { key: run.key, entered, row: claimed.row, sealed: claimed.sealed }, claimed.input, cfg) }
  } catch (e) {
    answer = { error: e instanceof Error ? e.message : String(e) }
  }
  await reaching(() => cluster.effectAnswer(run.key, entered, answer), backoff, claimed.until, cfg.now)
  return 'answered'
}

export function die(message: string): never {
  throw new Error(message)
}

export interface DispatcherEnv {
  CLUSTER: DurableObjectNamespace
  AI?: unknown
  BLOB_OBJECTS?: { put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>; head(key: string): Promise<unknown>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }
  BLOB_URL?: string
  /** The release's origin, from its domain: a handler's sink.origin, the same
   * on every run of that release. */
  ORIGIN?: string
  /** A bridge's container, BRIDGE_<NAME> (pronto's edge-bridges.ts). */
  [binding: `BRIDGE_${string}`]: ContainerBinding | undefined
}

/** Where an answer's bytes go: the bucket every other object is in, served by
 * the same route. */
export function imagePlane(env: DispatcherEnv): BlobStore | undefined {
  const bucket = env.BLOB_OBJECTS
  if (bucket === undefined || env.BLOB_URL === undefined) return undefined
  return {
    put: async (key, bytes, type) => { await bucket.put(key, bytes, { httpMetadata: { contentType: type } }) },
    get: async (key) => {
      const object = await bucket.get(key)
      if (object === null) throw new Error(`blob ${key} is not in the plane`)
      return new Uint8Array(await object.arrayBuffer())
    },
    url: (key) => `${env.BLOB_URL}${key}`,
  }
}

/** The dispatcher Worker: the airlock queue's consumer. Each message is one
 * run; the queue never redelivers (max_retries 0), since the object's lease
 * on the run is what dispatches it again. */
export function edgeDispatcher({ effects, ai }: { effects: EdgeEffects; ai?: AiCapabilitiesConfig }) {
  return {
    async queue(batch: { messages: { body: unknown; ack(): void }[] }, env: DispatcherEnv): Promise<void> {
      const cluster = env.CLUSTER.get(env.CLUSTER.idFromName('cluster')) as unknown as ClusterRuns
      await Promise.all(batch.messages.map(async (message) => {
        const run = message.body as DispatchedRun
        try {
          await dispatchRun(cluster, effects, run, { ai, env: env as unknown as Record<string, unknown>, blobs: imagePlane(env), origin: env.ORIGIN })
        } finally {
          message.ack()
        }
      }))
    },
  }
}
