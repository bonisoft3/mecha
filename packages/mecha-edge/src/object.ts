// mecha's edge tier: the cluster in one Durable Object over PGlite (pglite-workerd).
// The object boots on the first request that needs the database, over the data
// directory a release loaded through /import/* (pglite-workerd's load.ts), and
// answers the cluster's routes (cluster.ts); worker.ts is the Worker in front.
// An app's machines step here (machines.ts), and its schedules — a machine's
// deadlines, the cluster's cron — are the ticker's sweep on the object's
// alarm and under the Worker's Cron Trigger (clock.ts).
// The environment: CLUSTER, the object's namespace; JWT_SECRET, the tokens'
// secret; IMPORT_TOKEN, the bearer /import/* takes; CF_VERSION_METADATA, the
// Worker's version; ASSETS, the static files, where it has any.
import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { type Assets, DataDirectory } from '../../pglite-workerd/src/data-directory.ts'
import type { StorageFormat } from '../../pglite-workerd/src/storage-block.ts'
import { createEdgeCluster, type EdgeCluster, type EdgeClusterConfig } from './cluster.ts'
import { hasSchedules, nextDue, type Report, serviceCrud, sweepDue, type SweepRetry } from './clock.ts'
import { type EdgeMachines, installEngines, installHostStep } from './machines.ts'
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
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/
/** What a sweep left owed at its own instant — a Forbid hold, a failed
 * schedule, a backlog past the sweep's cap — is owed again this much later,
 * not at once: an alarm at the same instant would sweep, decline and re-arm
 * in a loop. Each sweep in a row that leaves it owed doubles the wait, up to
 * the Cron Trigger's hour: at the edge nothing answers a tick until the
 * outbox exists, so a Forbid hold can last. It is the whole retry: an
 * alarm() that threw would be run six more times by the platform within a
 * minute, each a boot and a sweep, on top of it. */
const RETRY_MS = 30_000
const RETRY_CAP_MS = 3_600_000

export class DataDirectoryLoading extends Error {
  constructor() { super('the data directory is loading') }
}

export function edgeObject({ assets, tables, schema, storageFormat, machines = {}, clock: clockMode = 'ticker' }: EdgeOptions) {
  // pgl_step reaches the step through the isolate: one set of machines per Worker.
  installHostStep(machines)
  return class Cluster extends DurableObject<EdgeEnv> {
    readonly #dir = new DataDirectory(this.ctx.storage, storageFormat)
    #cluster: Promise<{ db: PGlite; cluster: EdgeCluster; clock: boolean }> | null = null
    /** Sweeps in a row that left something owed at their own instant. */
    #stuck = 0

    #boot() {
      return this.#cluster ??= (async () => {
        const db = await this.#dir.open(assets)
        // A machine's steps run serializable (its serial() refuses any other
        // level): what the roles that drive a step default to on the
        // container tier, this one connection defaults to for every request.
        await db.exec(`SET default_transaction_isolation TO 'serializable'`)
        await installEngines(db, Object.keys(machines))
        const cluster = await createEdgeCluster({
          db, tables, schema, secret: this.env.JWT_SECRET, log: console.error,
          // A hole in a shape log is answered by a fresh object: a new log,
          // under new handles every client refetches from.
          fail: (e) => this.ctx.abort(String(e)),
        })
        const clock = clockMode === 'ticker' && await hasSchedules(db)
        if (clock) await this.#arm(db)
        else if (clockMode === 'disabled') await this.ctx.storage.deleteAlarm()
        return { db, cluster, clock }
      })().catch((e) => {
        // A boot that failed leaves nothing to answer with; the next request
        // meets a fresh object.
        this.ctx.abort(e)
        throw e
      })
    }

    /** A retry replaces any earlier alarm left by the failed pass. */
    async #arm(db: PGlite, retry?: SweepRetry) {
      if (clockMode === 'disabled') {
        await this.ctx.storage.deleteAlarm()
        return
      }
      const due = await nextDue(db, new Date(), retry)
      // Nothing owed: an alarm a cancelled deadline left would boot the
      // object to sweep nothing.
      if (due === null) {
        await this.ctx.storage.deleteAlarm()
        return
      }
      const standing = await this.ctx.storage.getAlarm()
      if (retry || standing === null || due < standing) await this.ctx.storage.setAlarm(Math.max(due, Date.now()))
    }

    /** One pass of the ticker as `caller`, and the alarm re-read from what
     * it left, through the retry rule, without eclipsing an earlier future
     * deadline or spinning on an immediate alarm left by boot. */
    async #sweep(db: PGlite, cluster: EdgeCluster, caller: string | null): Promise<{ report: Report; failed: boolean }> {
      const now = new Date()
      const report = await sweepDue(serviceCrud(cluster.service), now, caller)
      const failed = report.schedules.some((s) => s.error !== undefined)
      this.#stuck = report.schedules.some((s) => s.error !== undefined || s.held > 0 || s.behind) ? this.#stuck + 1 : 0
      await this.#arm(db, { through: now, at: new Date(Date.now() + Math.min(RETRY_MS * 2 ** Math.max(this.#stuck - 1, 0), RETRY_CAP_MS)) })
      return { report, failed }
    }

    override async alarm(): Promise<void> {
      if (clockMode === 'disabled') {
        await this.ctx.storage.deleteAlarm()
        return
      }
      if (!this.#dir.complete) return
      const { db, cluster, clock } = await this.#boot()
      if (!clock) return
      const { report, failed } = await this.#sweep(db, cluster, 'alarm')
      if (failed) console.error(`edge sweep failed: ${JSON.stringify(report.schedules.filter((s) => s.error !== undefined))}`)
    }

    /** The database once booted, and the alarm re-read from it, for a
     * subclass that writes outside the cluster's routes (a test's). */
    protected async booted(): Promise<PGlite> { return (await this.#boot()).db }
    protected async rearm(): Promise<void> { await this.#arm(await this.booted()) }

    protected async readPublic<T>(use: (snapshot: PublicSnapshot) => Promise<T>): Promise<T> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      const { cluster } = await this.#boot()
      return cluster.publicSnapshot(this.#dir.generation, use)
    }

    override async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
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
        const { db, cluster, clock } = await this.#boot()
        if (!clock) return json({ error: 'the data directory holds no schedule table' }, 409)
        const { report, failed } = await this.#sweep(db, cluster, new URL(req.url).searchParams.get('caller'))
        return json(report, failed ? 500 : 200)
      }
      if (CLUSTER_ROUTES.test(path)) {
        const { db, cluster, clock } = await this.#boot()
        const res = await cluster.handle(req)
        // A write may have armed a deadline (a machine's settle).
        if (clock && res.ok && /^\/crud(\/|$)/.test(path) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) await this.#arm(db)
        return res
      }
      return json({ error: `no route for ${path}` }, 404)
    }
  }
}
