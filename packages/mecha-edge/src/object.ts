// mecha's edge tier: the cluster in one Durable Object over PGlite (pglite-workerd).
// The object boots on the first request that needs the database, over the data
// directory a release loaded through /import/* (pglite-workerd's load.ts), and
// answers the cluster's routes (cluster.ts); worker.ts is the Worker in front.
// An app's machines step here (machines.ts), its drains are called as their
// tables change (mecha-browser's drains.ts), and its schedules — a machine's
// deadlines, the cluster's cron — are the ticker's sweep on the object's
// alarm and under the Worker's Cron Trigger (clock.ts). The alarm also stands
// at a failed drain's retry, which an evicted isolate's timer would not keep.
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
import { type EdgeMachines, installEngines, installHostStep } from './machines.ts'
import { applyScripts, ChangedScript, NoLedger, type Script, UnrunnableScript } from '../../pglite-workerd/scripts.ts'
import type { PublicSnapshot } from './public-snapshot.ts'

export interface EdgeEnv {
  CLUSTER: DurableObjectNamespace
  JWT_SECRET: string
  IMPORT_TOKEN: string
  CF_VERSION_METADATA: { id: string }
  ASSETS?: Fetcher
}

export interface EdgeOptions {
  assets: Assets
  /** Server tables that carry shapes, and the shell's schema (shell.json). */
  tables: string[]
  schema?: EdgeClusterConfig['schema']
  storageFormat?: StorageFormat
  /** The app's machines by name, each the step its migration declares. */
  machines?: EdgeMachines
  /** A frozen archive retains its schedules and runs none. */
  clock?: 'ticker' | 'disabled'
  drains?: Drain[]
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/
export class DataDirectoryLoading extends Error {
  constructor() { super('the data directory is loading') }
}

export function edgeObject({ assets, tables, schema, storageFormat, machines = {}, clock: clockMode = 'ticker', drains = [] }: EdgeOptions) {
  // pgl_step reaches the step through the isolate: one set of machines per Worker.
  installHostStep(machines)
  return class Cluster extends DurableObject<EdgeEnv> {
    readonly #dir = new DataDirectory(this.ctx.storage, storageFormat)
    #cluster: Promise<{ db: PGlite; cluster: EdgeCluster; clock: Clock; ticks: boolean }> | null = null

    #boot() {
      return this.#cluster ??= (async () => {
        const db = await this.#dir.open(assets)
        // A machine's steps run read committed, ordered by the locks they hold
        // on their players (its serial() refuses any other level): the
        // container tier's default, which this one connection states for
        // every request.
        await db.exec(`SET default_transaction_isolation TO 'read committed'`)
        await installEngines(db, Object.keys(machines))
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
        // The alarm, at what the schedules owe and a failed drain's retry. A
        // frozen archive's stands at the retry alone.
        const clock = createClock({
          db, read: (fn) => fn(), crud: serviceCrud(cluster.service), ticks,
          also: () => cluster.installed()?.retryAt() ?? null,
          timer: {
            get: () => this.ctx.storage.getAlarm(),
            set: (at) => this.ctx.storage.setAlarm(at),
            clear: () => this.ctx.storage.deleteAlarm(),
          },
        })
        await clock.arm()
        return { db, cluster, clock, ticks }
      })().catch((e) => {
        // A boot that failed leaves nothing to answer with; the next request
        // meets a fresh object.
        this.ctx.abort(e)
        throw e
      })
    }

    override async alarm(): Promise<void> {
      if (!this.#dir.complete) return
      // A frozen archive with no drains owes nothing an alarm could stand at:
      // one left standing is cleared without booting the directory.
      if (clockMode === 'disabled' && drains.length === 0) return this.ctx.storage.deleteAlarm()
      const { cluster, clock, ticks } = await this.#boot()
      // A failed drain's retry is called within the alarm, not on a timer an
      // eviction would drop.
      await (await cluster.drains()).retryDue()
      if (!ticks) {
        await clock.arm()
        return
      }
      const { report, failed } = await clock.sweep('alarm')
      if (failed) console.error(`edge sweep failed: ${JSON.stringify(report.schedules.filter((s) => s.error !== undefined))}`)
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
      if (path.startsWith('/import/')) {
        const expected = req.headers.get('x-expected-version')
        const running = this.env.CF_VERSION_METADATA?.id
        if (expected && running && expected !== running) {
          setTimeout(() => this.ctx.abort(`outdated version ${running}; restarting on ${expected}`), 0)
          return json({ outdated: true, running, expected }, 503)
        }
      }
      // The Worker checked the import's token: an object keeps the version,
      // and so the secrets, it started on while requests keep it awake.
      if (path === '/import/reset') await this.ctx.storage.deleteAlarm()
      if (path === '/import/reset' && this.#cluster) {
        // A release replacing live data: the directory goes now, the object
        // and its PGlite once this answer is out.
        this.#dir.reset()
        setTimeout(() => this.ctx.abort('the data directory was reset'), 0)
        return json({ reset: true })
      }
      // A release's migrations over a directory kept: what the ledger lacks
      // is applied while nothing else runs, and the object ends once the
      // answer is out, so the next request boots on the new schema, under
      // new shape handles, as after a reset.
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
        if (applied.length) setTimeout(() => this.ctx.abort('the data directory was migrated'), 0)
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
      // While a load is under way there is nothing to boot over.
      if ((CLUSTER_ROUTES.test(path) || path === '/poke') && !this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
      // The poke: contentless, from the Worker's Cron Trigger or a publish,
      // answered with the ticker's report (services/ticker/README.md).
      if (path === '/poke') {
        if (req.method !== 'POST') return json({ error: 'poke is a POST' }, 405)
        if (clockMode === 'disabled') return json({ error: 'the clock is disabled' }, 409)
        const { cluster, clock, ticks } = await this.#boot()
        if (!ticks) return json({ error: 'the data directory holds no schedule table' }, 409)
        // The poke stands in for an alarm the platform lost, a drain's included.
        await (await cluster.drains()).retryDue()
        const { report, failed } = await clock.sweep(new URL(req.url).searchParams.get('caller'))
        return json(report, failed ? 500 : 200)
      }
      if (CLUSTER_ROUTES.test(path)) {
        const { cluster, clock, ticks } = await this.#boot()
        const res = await cluster.handle(req)
        // A write may have armed a deadline (a machine's settle).
        if (ticks && res.ok && /^\/crud(\/|$)/.test(path) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) await clock.arm()
        return res
      }
      return json({ error: `no route for ${path}` }, 404)
    }
  }
}
