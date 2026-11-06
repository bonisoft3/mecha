// mecha's edge tier: the cluster in one Durable Object over PGlite (pglite-workerd).
// The object boots on the first request that needs the database, over the data
// directory a release loaded through /import/* (pglite-workerd's load.ts), and
// answers the cluster's routes (cluster.ts); worker.ts is the Worker in front.
// An app's machines step here (machines.ts), its drains are called as their
// tables change (mecha-browser's drains.ts), and its schedules — a machine's
// deadlines, the cluster's cron — are the ticker's sweep on the object's
// alarm and under the Worker's Cron Trigger (clock.ts). The alarm also stands
// at a failed drain's retry, which an evicted isolate's timer would not keep.
// A hatch's sweep runs on the poke, whatever an alarm does.
// The environment: CLUSTER, the object's namespace; JWT_SECRET, the tokens'
// secret; IMPORT_TOKEN, the bearer /import/* takes; CF_VERSION_METADATA, the
// Worker's version; ASSETS, the static files, where it has any.
import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { type Assets, DataDirectory } from '../../pglite-workerd/src/data-directory.ts'
import type { StorageFormat } from '../../pglite-workerd/src/storage-block.ts'
import { createEdgeCluster, type EdgeCluster, type EdgeClusterConfig } from './cluster.ts'
import { type Clock, createClock, hasSchedules, serviceCrud } from './clock.ts'
import type { Drain } from '../../mecha-browser/drains.ts'
import { type EdgeFunctions, type EdgeMachines, installEngines, installHostStep } from './machines.ts'
import { createEdgeAirlock, type EdgeAirlock, type EdgeEffects } from './airlock.ts'
import { hatchAt, type EdgeHatch } from './hatches.ts'
import type { AiCapabilitiesConfig } from '../../../services/airlock/tsbifrost.ts'
import type { BlobStore } from '../../../services/airlock/blobs.ts'
import { applyScripts, ChangedScript, NoLedger, type Script, UnrunnableScript } from '../../pglite-workerd/scripts.ts'
import type { PublicSnapshot } from './public-snapshot.ts'

export interface EdgeEnv {
  CLUSTER: DurableObjectNamespace
  JWT_SECRET: string
  IMPORT_TOKEN: string
  CF_VERSION_METADATA: { id: string }
  ASSETS?: Fetcher
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }
  /** The edge's blob storage, and the URL a stored key is served at (the same
   * variable a container cluster's airlock reads). */
  BLOB_OBJECTS?: { put(key: string, bytes: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>; head(key: string): Promise<unknown> }
  BLOB_URL?: string
}

export interface EdgeOptions {
  assets: Assets
  /** Server tables that carry shapes, and the shell's schema (shell.json). */
  tables: string[]
  schema?: EdgeClusterConfig['schema']
  storageFormat?: StorageFormat
  /** The app's machines by name, each the step its migration declares. */
  machines?: EdgeMachines
  /** The app's database functions by name, each the module its migration declares. */
  functions?: EdgeFunctions
  /** The app's external effects by name, each bound to its handler and target. */
  effects?: EdgeEffects
  /** The app's AI tier and model configuration (shell.json). */
  ai?: AiCapabilitiesConfig
  /** A frozen archive retains its schedules and runs none. */
  clock?: 'ticker' | 'disabled'
  drains?: Drain[]
  hatches?: EdgeHatch[]
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/
export class DataDirectoryLoading extends Error {
  constructor() { super('the data directory is loading') }
}

const earliest = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b)

export function edgeObject({ assets, tables, schema, storageFormat, machines = {}, functions = {}, effects = {}, ai, clock: clockMode = 'ticker', drains = [], hatches = [] }: EdgeOptions) {
  // pgl_step reaches the step through the isolate: one set of machines per Worker.
  installHostStep(machines, functions)
  const hasAirlock = Object.keys(effects).length > 0
  return class Cluster extends DurableObject<EdgeEnv> {
    readonly #dir = new DataDirectory(this.ctx.storage, storageFormat)
    #cluster: Promise<{ db: PGlite; cluster: EdgeCluster; clock: Clock; airlock: EdgeAirlock; ticks: boolean }> | null = null

    // One instance per hatch for this object's life, so what it remembers between
    // requests, such as a rate limit, holds. One that fails to create is not kept.
    readonly #hatches = new Map<EdgeHatch, ReturnType<EdgeHatch['create']>>()

    #boot() {
      return this.#cluster ??= (async () => {
        const db = await this.#dir.open(assets)
        // A machine's steps run read committed, ordered by the locks they hold
        // on their players (its serial() refuses any other level): the
        // container tier's default, which this one connection states for
        // every request.
        await db.exec(`SET default_transaction_isolation TO 'read committed'`)
        await installEngines(db, Object.keys(machines), Object.keys(functions))
        const ticks = clockMode === 'ticker' && await hasSchedules(db)
        const cluster = await createEdgeCluster({
          db, tables, schema, secret: this.env.JWT_SECRET, log: console.error, drains,
          // A hole in a shape log is answered by a fresh object: a new log,
          // under new handles every client refetches from.
          fail: (e) => this.ctx.abort(String(e)),
          // An alarm that could not be set leaves a failed drain to the next
          // boot; a fresh object is that boot.
          retry: () => { clock.arm().catch((e) => this.ctx.abort(String(e))) },
        })
        const airlock = createEdgeAirlock({
          db,
          serialize: (fn, priority) => cluster.serialize(fn, priority),
          effects,
          ai,
          env: this.env as unknown as Record<string, unknown>,
          log: console.error,
          retry: () => { clock.arm().catch((e) => this.ctx.abort(String(e))) },
          blobs: imagePlane(this.env),
        })
        // The alarm, at what the schedules owe and a failed drain's or effect's retry.
        // A frozen archive's stands at the retry alone.
        const clock = createClock({
          db, read: (fn) => cluster.serialize(fn, 'low'), crud: serviceCrud(cluster.service), ticks,
          also: () => earliest(cluster.installed()?.retryAt() ?? null, airlock.retryAt()),
          timer: {
            get: () => this.ctx.storage.getAlarm(),
            set: (at) => this.ctx.storage.setAlarm(at),
            clear: () => this.ctx.storage.deleteAlarm(),
          },
        })
        // A job a drain or a settle enqueued, with no write after it, waited for
        // the next write or the hourly cron: a deck's text sat queued for minutes.
        // Graphile's add_job announces each insert, as its own workers hear it.
        if (hasAirlock) await db.listen('"jobs:insert"', () => this.ctx.waitUntil(airlock.drain()))
        await clock.arm()
        return { db, cluster, clock, airlock, ticks }
      })().catch((e) => {
        // A boot that failed leaves nothing to answer with; the next request
        // meets a fresh object.
        this.ctx.abort(e)
        throw e
      })
    }

    #served(hatch: EdgeHatch) {
      let served = this.#hatches.get(hatch)
      if (!served) {
        const database = {
          query: async <T>(sql: string, params?: unknown[]) => {
            const { db, cluster } = await this.#boot()
            return cluster.serialize(() => db.query<T>(sql, params))
          },
          transaction: async <T>(fn: (tx: import('./hatches.ts').HatchQuery) => Promise<T>) => {
            const { db, cluster } = await this.#boot()
            return cluster.serialize(() => db.transaction(fn))
          },
        }
        served = hatch.create({ database, env: this.env as unknown as Record<string, unknown> })
        this.#hatches.set(hatch, served)
      }
      return served
    }

    /** What each hatch's sweep said, every hatch asked whatever another answers. */
    async #sweepHatches(): Promise<string[]> {
      const errors: string[] = []
      for (const hatch of hatches) {
        try {
          await this.#served(hatch).sweep?.()
        } catch (error) {
          errors.push(`${hatch.route}: ${error instanceof AggregateError ? `${error.message}: ${error.errors.join('; ')}` : error}`)
        }
      }
      return errors
    }

    override async alarm(): Promise<void> {
      if (!this.#dir.complete) return
      // A frozen archive with no drains or effects owes nothing an alarm could
      // stand at: one left standing is cleared without booting the directory.
      if (clockMode === 'disabled' && drains.length === 0 && !hasAirlock) return this.ctx.storage.deleteAlarm()
      const { cluster, clock, airlock, ticks } = await this.#boot()
      // A failed drain's retry is called within the alarm, not on a timer an
      // eviction would drop.
      await (await cluster.drains()).retryDue()
      if (hasAirlock) await airlock.drain()
      if (!ticks) {
        await clock.arm()
        return
      }
      const { report, failed } = await clock.sweep('alarm')
      if (failed) console.error(`edge sweep failed: ${JSON.stringify(report.schedules.filter((s) => s.error !== undefined))}`)
      if (hasAirlock) await airlock.drain()
    }

    /** The database once booted, and the alarm re-read from it, for a
     * subclass that writes outside the cluster's routes (a test's). */
    protected async booted(): Promise<PGlite> { return (await this.#boot()).db }
    protected async rearm(): Promise<void> {
      await (await this.#boot()).clock.arm()
    }

    protected async readPublic<T>(use: (snapshot: PublicSnapshot) => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      const { cluster } = await this.#boot()
      return cluster.publicSnapshot(this.#dir.generation, use, priority)
    }

    override async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
      // Asked by the Worker once it holds an answer that ends this object. Ended from in here, on a
      // timer, the answer could be lost: a migration that landed once read as refused.
      if (path === '/import/restart') this.ctx.abort('asked by the Worker')
      if (path.startsWith('/import/')) {
        const expected = req.headers.get('x-expected-version')
        const running = this.env.CF_VERSION_METADATA?.id
        if (expected && running && expected !== running) {
          return json({ outdated: true, running, expected }, 503)
        }
      }
      // The Worker checked the import's token: an object keeps the version,
      // and so the secrets, it started on while requests keep it awake.
      if (path === '/import/reset') await this.ctx.storage.deleteAlarm()
      if (path === '/import/reset' && this.#cluster) {
        // A release replacing live data: the directory goes now, the object
        // and its PGlite once the Worker holds this answer.
        this.#dir.reset()
        return json({ reset: true })
      }
      // A release's migrations over a directory kept: what the ledger lacks
      // is applied while nothing else runs, and the Worker ends the object
      // once it holds the answer, so the next request boots on the new schema,
      // under new shape handles, as after a reset.
      if (path === '/import/migrate') {
        if (req.method !== 'POST') return json({ error: 'migrate is a POST' }, 405)
        if (!this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
        const scripts = await req.json() as Script[]
        const { db, cluster } = await this.#boot()
        let applied: string[] | NoLedger | ChangedScript | UnrunnableScript
        try {
          applied = await cluster.serialize(async () => {
            const names = await applyScripts(db, scripts)
            if (names.length) await db.exec('CHECKPOINT')
            return names
          })
        } catch (error) {
          if (error instanceof NoLedger || error instanceof ChangedScript || error instanceof UnrunnableScript) applied = error
          else throw error
        }
        if (applied instanceof Error) return json({ error: applied.message }, 409)
        return json({ applied })
      }
      if (path.startsWith('/import/')) {
        if (req.headers.get('content-encoding') === 'gzip') {
          if (!req.body) throw new Error('missing compressed import body')
          const headers = new Headers(req.headers)
          headers.delete('content-encoding')
          headers.delete('content-length')
          req = new Request(req, { headers, body: req.body.pipeThrough(new DecompressionStream('gzip')) })
        }
        return this.#dir.importing(path.slice('/import/'.length), req)
      }
      const hatch = hatchAt(hatches, path)
      if (hatch) {
        if (!this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
        await this.#boot()
        return this.#served(hatch).fetch(req)
      }
      // While a load is under way there is nothing to boot over.
      if ((CLUSTER_ROUTES.test(path) || path === '/poke') && !this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
      // The poke: contentless, from the Worker's Cron Trigger or a publish,
      // answered with the ticker's report (services/ticker/README.md).
      if (path === '/poke') {
        if (req.method !== 'POST') return json({ error: 'poke is a POST' }, 405)
        if (clockMode === 'disabled') return json({ error: 'the clock is disabled' }, 409)
        const { db, cluster, clock, airlock, ticks } = await this.#boot()
        if (!ticks && hatches.length === 0) return json({ error: 'the data directory holds no schedule table' }, 409)
        const caller = new URL(req.url).searchParams.get('caller')
        // The poke stands in for an alarm the platform lost, a drain's included.
        await (await cluster.drains()).retryDue()
        const { report, failed } = ticks ? await clock.sweep(caller) : { report: {}, failed: false }
        if (hasAirlock) await airlock.drain()
        // A publish's poke may come before a first deploy's hatch secrets exist.
        const hatchErrors = caller === 'publish' ? [] : await this.#sweepHatches()
        // A standalone Postgres has no checkpointer: without this, every byte ever
        // written stays in pg_wal.
        await cluster.serialize(() => db.exec('CHECKPOINT'))
        return json({ ...report, hatchErrors }, failed || hatchErrors.length ? 500 : 200)
      }
      if (CLUSTER_ROUTES.test(path)) {
        const { cluster, clock, airlock, ticks } = await this.#boot()
        const res = await cluster.handle(req)
        // A write may have armed a deadline (a machine's settle) or enqueued an effect.
        if (res.ok && /^\/crud(\/|$)/.test(path) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          if (ticks) await clock.arm()
          if (hasAirlock) this.ctx.waitUntil(airlock.drain())
        }
        return res
      }
      return json({ error: `no route for ${path}` }, 404)
    }
  }
}

// An answer's bytes go where every other object is, served by the same route.
function imagePlane(env: EdgeEnv): BlobStore | undefined {
  const bucket = env.BLOB_OBJECTS
  if (bucket === undefined || env.BLOB_URL === undefined) return undefined
  return {
    put: async (key, bytes, type) => { await bucket.put(key, bytes, { httpMetadata: { contentType: type } }) },
    url: (key) => `${env.BLOB_URL}${key}`,
  }
}
