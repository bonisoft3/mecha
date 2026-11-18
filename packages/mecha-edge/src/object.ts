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
// Worker's version; ASSETS, the static files, where it has any; AIRLOCK_QUEUE,
// the queue an effect's run is handed to the dispatcher Worker on (dispatch.ts);
// AIRLOCK_SEAL_PUBLIC, where an effect reads a secret field, the public half
// of the dispatcher's seal key, `{kid, key}`, which the object publishes for
// the screen to seal to.
import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { type Assets, DataDirectory } from '../../pglite-workerd/src/data-directory.ts'
import type { StorageFormat } from '../../pglite-workerd/src/storage-block.ts'
import { createEdgeCluster, type EdgeCluster, type EdgeClusterConfig } from './cluster.ts'
import { type Clock, createClock, hasSchedules, serviceCrud } from './clock.ts'
import type { Drain } from '../../mecha-browser/drains.ts'
import { type EdgeFunctions, type EdgeMachines, installEngines, installHostStep } from './machines.ts'
import { createEdgeAirlock, die, type EdgeAirlock, type EdgeEffectDeclarations } from './airlock.ts'
import { SealedValues } from './sealed.ts'
import type { ClaimedRun, DispatchedRun, RunAnswer } from './dispatch.ts'
import { hatchAt, type EdgeHatch } from './hatches.ts'
import { verifyJwt } from '../../../services/auth/jwt.ts'
import { providersFrom } from '../../../services/auth/oidc.ts'
import { blobKeyOf, SIGNAL_MAX_BYTES } from './door.ts'
import { applyScripts, ChangedScript, NoLedger, OutOfOrderScript, type Script, UnrunnableScript } from '../../pglite-workerd/scripts.ts'
import { snapshotAdmission, type PublicSnapshot } from './public-snapshot.ts'
import type { BatchMachine, Computation, Output } from '../../compute-snapshot/src/index.ts'
import type { ComputeCapture } from './compute-coordinator.ts'
import { physicalSnapshotId, readerName, type computeReader } from './compute-reader.ts'
import { ComputeReaderOwners } from './compute-reader-owners.ts'
import { SEAL_TTL_SECONDS, SEALED, sealKid } from '../../../services/airlock/seal.ts'
import { PUBLISH_SEAL_SQL, SEAL_TABLES_SQL } from '../../../services/airlock/seal-tables.ts'

export interface EdgeEnv {
  CLUSTER: DurableObjectNamespace
  JWT_SECRET: string
  IMPORT_TOKEN: string
  CF_VERSION_METADATA: { id: string }
  ASSETS?: Fetcher
  COMPUTE_READER?: DurableObjectNamespace<InstanceType<ReturnType<typeof computeReader>>>
  COMPUTE_COORDINATOR?: DurableObjectNamespace<import('./compute-coordinator.ts').ComputeCoordinator>
  /** The edge's blob storage, and the URL a stored key is served at (the same
   * variable a container cluster's airlock reads). */
  BLOB_OBJECTS?: { put(key: string, bytes: Uint8Array | ReadableStream, options: { httpMetadata: { contentType: string } }): Promise<unknown>; head(key: string): Promise<unknown>; get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> }
  BLOB_URL?: string
  AIRLOCK_QUEUE?: { send(body: DispatchedRun): Promise<unknown> }
  AIRLOCK_SEAL_PUBLIC?: string
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
  /** The app's external effects by name: each declaration and target, the handlers being the dispatcher Worker's. */
  effects?: EdgeEffectDeclarations
  /** A frozen archive retains its schedules and runs none. */
  clock?: 'ticker' | 'disabled'
  drains?: Drain[]
  compute?: { computations: Computation[]; machine: BatchMachine; physicalSnapshots?: boolean; reader?: string }
  hatches?: EdgeHatch[]
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/
export class DataDirectoryLoading extends Error {
  constructor() { super('the data directory is loading') }
}

// A key as a uuid column would spell it back, lowercase: what tells two
// offers of one row apart however they spelled it. A sealed value is kept
// under the key as the database answered it (seal.ts sealLabel binds it so),
// which for a text key is exactly what the write named.
const canonicalKey = (v: unknown) => {
  const text = String(v)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : text
}

const earliest = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b)

export function edgeObject({ assets, tables, schema, storageFormat, machines = {}, functions = {}, effects = {}, clock: clockMode = 'ticker', drains = [], hatches = [], compute }: EdgeOptions) {
  if (compute?.physicalSnapshots && !compute.reader) throw new Error('physical snapshots require an immutable reader owner')
  // pgl_step reaches the step through the isolate: one set of machines per Worker.
  installHostStep(machines, functions)
  const hasAirlock = Object.keys(effects).length > 0
  // The tables whose writes carry a secret field (pronto's #Field.secret), by
  // the fields and the key a sealed value is bound by.
  const secretTables = new Map<string, { pk: string; fields: Set<string> }>()
  for (const { declaration: d } of Object.values(effects)) {
    if (!d.secretFields?.length) continue
    const t = secretTables.get(d.table) ?? { pk: d.row[0], fields: new Set<string>() }
    for (const f of d.secretFields) t.fields.add(f)
    secretTables.set(d.table, t)
  }
  return class Cluster extends DurableObject<EdgeEnv> {
    // A secret field's sealed value, from the write that named it until the
    // last effect naming it on its row settles or five minutes pass: in this
    // instance's memory and nowhere else, never its storage, the queue or the
    // database, so an eviction loses it, which its effect meets as a value
    // never written (sealed.ts).
    readonly #sealed = new SealedValues(SEAL_TTL_SECONDS * 1000)
    readonly #dir = new DataDirectory(this.ctx.storage, storageFormat, error => { this.ctx.abort(error instanceof Error ? error.message : String(error)); throw error })
    readonly #readers = new ComputeReaderOwners(this.ctx.storage.sql)
    #resetting = false
    readonly #snapshotAdmission = snapshotAdmission()
    #cluster: Promise<{ db: PGlite; cluster: EdgeCluster; clock: Clock; airlock: EdgeAirlock; ticks: boolean }> | null = null

    // One instance per hatch for this object's life, so what it remembers between
    // requests, such as a rate limit, holds. One that fails to create is not kept.
    readonly #hatches = new Map<EdgeHatch, ReturnType<EdgeHatch['create']>>()

    #boot() {
      if (this.#resetting || !this.#dir.storageReady) throw new DataDirectoryLoading()
      return this.#cluster ??= (async () => {
        const db = await this.#dir.open(assets)
        // A machine's steps run read committed, ordered by the locks they hold
        // on their players (its serial() refuses any other level): the
        // container tier's default, which this one connection states for
        // every request.
        await db.exec(`SET default_transaction_isolation TO 'read committed'`)
        // The one connection serves requests and the service's own lanes, the
        // airlock's moves among them. A request sets its claims LOCAL, and a
        // setting once set LOCAL reads back as '' after its transaction, not
        // NULL, which ''::json refuses wherever a policy or trigger reads the
        // role: between requests the session holds the service's claims, as
        // the drains state theirs.
        await db.exec(`SELECT set_config('request.jwt.claims', '{"role":"service"}', false)`)
        await installEngines(db, Object.keys(machines), Object.keys(functions))
        const ticks = clockMode === 'ticker' && await hasSchedules(db)
        const env = (name: string) => {
          const v = (this.env as unknown as Record<string, unknown>)[name]
          return typeof v === 'string' ? v : undefined
        }
        const configuredProviders = (env('OIDC_PROVIDERS') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((name) => name !== '' && Boolean(env(`OIDC_${name.toUpperCase()}_CLIENT_ID`) || env(`OIDC_${name.toUpperCase()}_ISSUER`)))
          .join(',')
        const providers = providersFrom((name) => {
          if (name === 'OIDC_PROVIDERS') return configuredProviders
          if (/^OIDC_[A-Z0-9]+_CLIENT_ID$/.test(name)) return env(name) ?? (env(name.replace(/_CLIENT_ID$/, '_ISSUER')) ? 'origin' : undefined)
          if (/^OIDC_[A-Z0-9]+_AUTHORIZE_PARAMS$/.test(name)) {
            const p = name.slice('OIDC_'.length, -'_AUTHORIZE_PARAMS'.length).toLowerCase()
            return env(name) ?? (env(name.replace(/_AUTHORIZE_PARAMS$/, '_ISSUER')) && !env(name.replace(/_AUTHORIZE_PARAMS$/, '_CLIENT_ID')) ? `provider=${p}` : undefined)
          }
          return env(name)
        })
        const cluster = await createEdgeCluster({
          db, tables, schema, secret: this.env.JWT_SECRET, log: console.error, drains, providers,
          ...(compute ? { compute: {
            ...compute,
            ...(compute.physicalSnapshots ? { retainSnapshot: async identity => {
              if (this.#resetting) throw new DataDirectoryLoading()
              await this.#dir.freeze(physicalSnapshotId({ generation: this.#dir.generation, identity }))
            } } : {}),
            changed: () => this.#signalCompute(),
          } } : {}),
          // A hole in a shape log is answered by a fresh object: a new log,
          // under new handles every client refetches from.
          fail: (e) => this.ctx.abort(String(e)),
          // An alarm that could not be set leaves a failed drain to the next
          // boot; a fresh object is that boot.
          retry: () => { clock.arm().catch((e) => this.ctx.abort(String(e))) },
        })
        // Effects with no queue to the dispatcher would never run: the object
        // refuses to boot rather than hold them.
        const queue = hasAirlock ? this.env.AIRLOCK_QUEUE ?? die('effects need AIRLOCK_QUEUE, the dispatcher Worker\'s queue') : undefined
        const airlock = createEdgeAirlock({
          db,
          serialize: (fn, priority) => cluster.serialize(fn, priority),
          effects,
          // The object never waits on an effect's network: a run is enqueued
          // for the dispatcher Worker, and its answer arrives as effectAnswer.
          dispatch: async (run) => { await queue!.send(run) },
          log: console.error,
          retry: () => { clock.arm().catch((e) => this.ctx.abort(String(e))) },
        })
        // The alarm, at what the schedules owe and a failed drain's or effect's retry.
        // A frozen archive's stands at the retry alone.
        const clock = createClock({
          db, read: (fn) => cluster.read(fn), crud: serviceCrud(cluster.service), ticks,
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
        if (secretTables.size > 0) {
          const published = JSON.parse(this.env.AIRLOCK_SEAL_PUBLIC ?? die('an effect reads a secret field, and AIRLOCK_SEAL_PUBLIC, its seal key\'s public half, is not set')) as { kid: string; key: JsonWebKey }
          if (await sealKid(published.key) !== published.kid) die('AIRLOCK_SEAL_PUBLIC names a key its id is not')
          await cluster.serialize(() => db.transaction(async (tx) => {
            await tx.exec(SEAL_TABLES_SQL)
            await tx.query(PUBLISH_SEAL_SQL, [published.kid, JSON.stringify(published.key)])
          }))
        }
        if (hasAirlock) await db.listen('"jobs:insert"', () => this.ctx.waitUntil(airlock.drain()))
        await clock.arm()
        this.#signalCompute()
        return { db, cluster, clock, airlock, ticks }
      })().catch((e) => {
        // A boot that failed leaves nothing to answer with; the next request
        // meets a fresh object.
        this.ctx.abort(e)
        throw e
      })
    }

    #signalCompute() {
      if (!compute || !this.#dir.storageReady) return
      this.ctx.waitUntil((async () => {
        if (!this.env.COMPUTE_COORDINATOR) throw new Error('computation requires COMPUTE_COORDINATOR')
        await this.env.COMPUTE_COORDINATOR.get(this.env.COMPUTE_COORDINATOR.idFromName('compute')).wake()
      })())
    }

    async computeClaim(): Promise<ComputeCapture | null> {
      if (!this.#dir.complete || !this.#dir.storageReady) return null
      const generation = this.#dir.generation
      const coordinator = await (await this.#boot()).cluster.compute()
      if (compute?.physicalSnapshots && coordinator) {
        for (const snapshot of this.#dir.snapshots()) {
          const capture = { generation: snapshot.sourceGeneration, identity: JSON.parse(snapshot.id) }
          if (await coordinator.publication(capture.identity) === 'pending') continue
          await this.#releaseCapture(capture)
        }
      }
      if (compute?.physicalSnapshots && coordinator) {
        for (const { owner, capture } of this.#readers.list()) {
          if (owner !== compute.reader) continue
          if (capture.generation === generation && await coordinator.publication(capture.identity) === 'pending') continue
          await this.#releaseCapture(capture)
        }
      }
      if (this.#resetting) throw new DataDirectoryLoading()
      const identity = await coordinator?.claim()
      return identity ? { generation, identity } : null
    }

    #reader(capture: ComputeCapture) {
      if (!compute?.physicalSnapshots || !this.env.COMPUTE_READER) throw new Error('physical snapshots require COMPUTE_READER')
      return this.env.COMPUTE_READER.get(this.env.COMPUTE_READER.idFromName(readerName(capture)))
    }

    async #releaseCapture(capture: ComputeCapture) {
      if (compute?.physicalSnapshots) await this.#readers.release(compute.reader!, capture, async () => {
        const base = await this.#reader(capture).release(capture)
        if (base === physicalSnapshotId(capture)) {
          const old = this.#readers.base(compute.reader!, capture)
          this.#readers.promote(compute.reader!, capture)
          if (old && !this.#readers.pinned(old)) this.#dir.releaseSnapshot(physicalSnapshotId(old))
        }
      })
      if (!this.#readers.pinned(capture)) this.#dir.releaseSnapshot(physicalSnapshotId(capture))
    }

    computeReaders() { return this.#readers.list() }

    async computePrepare(capture: ComputeCapture): Promise<boolean> {
      const coordinator = await this.#captureCoordinator(capture)
      if (!compute?.physicalSnapshots) {
        if (await coordinator.publication(capture.identity) !== 'pending') throw new Error('compute capture is no longer pending')
        return true
      }
      this.#readers.retain(compute.reader!, capture)
      const reader = this.#reader(capture)
      const state = await reader.status(capture)
      const status = state.transfer
      if (!status && !state.restoring && await coordinator.publication(capture.identity) !== 'pending') throw new Error('compute capture is no longer pending')
      if (this.#resetting || !this.#dir.complete) throw new DataDirectoryLoading()
      if (capture.generation !== this.#dir.generation) throw new Error('the data directory was replaced')
      const manifest = this.#dir.snapshotManifest(physicalSnapshotId(capture))
      if (!manifest) throw new Error('physical snapshot is no longer available')
      if (state.restoring) return false
      if (!status) return await reader.advance(capture, { kind: 'manifest', value: manifest })
      if (!status.nodesDone) return await reader.advance(capture, { kind: 'nodes', value: await this.computePhysicalNodes(capture, status.nodesAfter, status.baseId ?? undefined) })
      if (status.preparing) return await reader.advance(capture)
      if (status.nextFile) return await reader.advance(capture, { kind: 'blocks', value: await this.computePhysicalBlocks(capture, status.nextFile.path, status.nextFile.after, status.baseId ?? undefined) })
      if (status.complete) {
        const old = this.#readers.base(compute.reader!, capture)
        this.#readers.promote(compute.reader!, capture)
        if (old && !this.#readers.pinned(old)) this.#dir.releaseSnapshot(physicalSnapshotId(old))
      }
      return await reader.advance(capture)
    }

    async computePhysicalManifest(capture: ComputeCapture) {
      await this.#captureCoordinator(capture)
      const snapshot = this.#dir.snapshotManifest(physicalSnapshotId(capture))
      if (!snapshot) throw new Error('physical snapshot is no longer available')
      return snapshot
    }

    async computePhysicalNodes(capture: ComputeCapture, after: string, baseId?: string) {
      await this.computePhysicalManifest(capture)
      return this.#dir.snapshotNodes(physicalSnapshotId(capture), after, baseId)
    }

    async computePhysicalBlocks(capture: ComputeCapture, path: string, after: number, baseId?: string) {
      await this.computePhysicalManifest(capture)
      return this.#dir.snapshotBlocks(physicalSnapshotId(capture), path, after, baseId)
    }

    async computeSnapshot(capture: ComputeCapture): Promise<Response> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      if (capture.generation !== this.#dir.generation) return json({ error: 'the data directory was replaced' }, 409)
      const coordinator = await (await this.#boot()).cluster.compute()
      if (!coordinator) throw new Error('computation is not configured')
      if (compute?.physicalSnapshots) return await this.#reader(capture).snapshot(capture)
      return json(await coordinator.snapshot(capture.identity))
    }

    async #captureCoordinator(capture: ComputeCapture) {
      if (this.#resetting) throw new DataDirectoryLoading()
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      if (capture.generation !== this.#dir.generation) throw new Error('the data directory was replaced')
      const coordinator = await (await this.#boot()).cluster.compute()
      if (!coordinator) throw new Error('computation is not configured')
      if (capture.generation !== this.#dir.generation) throw new Error('the data directory was replaced')
      return coordinator
    }

    async computeManifest(capture: ComputeCapture) {
      const coordinator = await this.#captureCoordinator(capture)
      return compute?.physicalSnapshots ? await this.#reader(capture).manifest(capture) : await coordinator.manifest(capture.identity)
    }

    async computeReaderName(capture: ComputeCapture) {
      await this.#captureCoordinator(capture)
      return compute?.physicalSnapshots ? readerName(capture) : null
    }

    async computeChunk(capture: ComputeCapture, source: string, after: number) {
      const coordinator = await this.#captureCoordinator(capture)
      return compute?.physicalSnapshots ? await this.#reader(capture).chunk(capture, source, after) : await coordinator.chunk(capture.identity, source, after)
    }

    async computeWal(capture: ComputeCapture, source: string, afterLsn: number) {
      const coordinator = await this.#captureCoordinator(capture)
      if (compute?.physicalSnapshots) return await this.#reader(capture).tableWal(capture, source, afterLsn)
      return coordinator.tableWal ? await coordinator.tableWal(capture.identity, source, afterLsn) : null
    }

    async computeOutputChunk(capture: ComputeCapture, attempt: string, sink: string, ordinal: number, rows: Record<string, unknown>[]) {
      await (await this.#captureCoordinator(capture)).outputChunk(capture.identity, attempt, sink, ordinal, rows)
    }

    async computeSealOutput(capture: ComputeCapture, attempt: string, manifest: Record<string, { chunks: number; rows: number }>) {
      await (await this.#captureCoordinator(capture)).sealOutput(capture.identity, attempt, manifest)
    }

    async computePublishStaged(capture: ComputeCapture, attempt: string) {
      const coordinator = await this.#captureCoordinator(capture)
      await coordinator.publishStaged(capture.identity, attempt)
      if (compute?.physicalSnapshots && await coordinator.publication(capture.identity) !== 'pending') await this.#releaseCapture(capture)
    }

    async computePublication(capture: ComputeCapture) {
      if (capture.generation !== this.#dir.generation) return 'obsolete' as const
      return await (await this.#captureCoordinator(capture)).publication(capture.identity)
    }

    async computePublish(capture: ComputeCapture, response: Response): Promise<void> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      if (capture.generation !== this.#dir.generation) { await response.body?.cancel(); return }
      const output = await response.json() as Output
      if (capture.generation !== this.#dir.generation) return
      const coordinator = await (await this.#boot()).cluster.compute()
      if (!coordinator) throw new Error('computation is not configured')
      await coordinator.publish(capture.identity, output)
      if (compute?.physicalSnapshots && await coordinator.publication(capture.identity) !== 'pending') await this.#releaseCapture(capture)
    }

    async computeReject(capture: ComputeCapture, error: string): Promise<void> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      if (capture.generation !== this.#dir.generation) return
      const coordinator = await (await this.#boot()).cluster.compute()
      if (!coordinator) throw new Error('computation is not configured')
      await coordinator.reject(capture.identity, error)
    }

    async computeWakeAt(): Promise<number | null> {
      if (!this.#dir.complete || !this.#dir.storageReady) return null
      return await (await (await this.#boot()).cluster.compute())?.wakeAt() ?? null
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

    /** The object as the dispatcher reaches it: booted with the drains and
     * computations installed, since a claim or an answer settles rows, and the
     * pass a job's notice wakes may settle others, as on every path that
     * writes. The drains settle on a timer after the call returns, so the
     * object stays until they have. */
    async #effects<T>(use: (airlock: EdgeAirlock) => Promise<T>): Promise<T> {
      const { cluster, clock, airlock, ticks } = await this.#boot()
      await cluster.compute()
      const drains = await cluster.drains()
      try {
        return await use(airlock)
      } finally {
        if (ticks) await clock.arm()
        this.ctx.waitUntil(drains.idle().then(() => ticks ? clock.arm() : undefined))
      }
    }

    /** The dispatcher's claim on a run it was handed (dispatch.ts). While a
     * directory loads no run is the ledger's: the run is skipped, and the
     * loaded directory's own lease dispatches what it still owes. */
    async effectClaim(key: string, token: string, claimant: string): Promise<ClaimedRun | null> {
      if (this.#resetting || !this.#dir.complete || !this.#dir.storageReady) return null
      const run = await this.#effects((airlock) => airlock.claim(key, token, claimant))
      const d = run && effects[run.effect]?.declaration
      if (!run || !d?.secretFields?.length) return run
      // The sealed values travel with the claim alone, to the one Worker that
      // can open them, and leave memory once the key's outcome lands.
      const sealed: Record<string, string> = {}
      for (const f of d.secretFields) {
        const held = await this.#sealed.take(this.#secretKey(d.table, String(run.row[d.row[0]]), f))
        if (held) {
          held.keys.add(key)
          sealed[f] = held.value
        }
      }
      return { ...run, sealed }
    }

    #secretKey = (table: string, pk: string, field: string) => JSON.stringify([table, pk, field])

    // Whether a table's key column is a uuid, which the database spells back
    // in lowercase however a write named it.
    readonly #uuidKeys = new Map<string, Promise<boolean>>()
    #uuidKey(table: string, column: string): Promise<boolean> {
      const k = `${table}.${column}`
      let known = this.#uuidKeys.get(k)
      if (known === undefined) {
        known = this.#boot().then(async ({ db }) => (await db.query<{ uuid: boolean }>(
          `SELECT atttypid = 'uuid'::regtype AS uuid FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2`, [`public.${JSON.stringify(table)}`, column])).rows[0]?.uuid === true)
        known.catch(() => this.#uuidKeys.delete(k))
        this.#uuidKeys.set(k, known)
      }
      return known
    }

    /** A write naming a secret field: the sealed values taken out of its body,
     * which reaches the database without them, and kept here for the rows the
     * write landed on, held from every claim until it settles. What is not
     * sealed is refused, and not repeated. A PATCH names its one row by its
     * key, the row a seal binds to. */
    async #withoutSecrets(req: Request, write: (req: Request) => Promise<Response>): Promise<Response> {
      const url = new URL(req.url)
      // The table as crud's router reads it (cluster.ts): the first segment past /crud.
      const table = /^\/crud(\/|$)/.test(url.pathname) ? url.pathname.replace(/^\/crud/, '').split('/').filter(Boolean)[0] : undefined
      const spec = table === undefined ? undefined : secretTables.get(table)
      if (!spec || !['POST', 'PATCH', 'PUT'].includes(req.method)) return await write(req)
      // Only a JSON body is read for its secret fields; crud's other bodies
      // (a form, CSV) would carry one past this to the database.
      if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json({ error: `a write to ${table} is JSON, which its secret fields are read from` }, 415)
      const text = await req.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        return json({ error: `a write to ${table} is JSON, which its secret fields are read from` }, 400)
      }
      const rows = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[]
      const patched = req.method === 'PATCH' ? /^eq\.(.+)$/.exec(url.searchParams.get(spec.pk) ?? '')?.[1] : undefined
      const taken: { pk: string; field: string; value: string }[] = []
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        for (const field of spec.fields) {
          if (!(field in row)) continue
          const value = row[field]
          delete row[field]
          if (value === null) continue
          if (typeof value !== 'string' || !SEALED.test(value)) return json({ error: `${table}.${field} takes a value sealed to the airlock's key, and this one is not` }, 400)
          const pk = req.method === 'PATCH' ? patched : row[spec.pk] === undefined ? undefined : String(row[spec.pk])
          if (pk === undefined) return json({ error: `${table}.${field} is written to one row named by its ${spec.pk}` }, 400)
          if (req.method === 'PATCH' && Object.keys(row).length === 0) row[spec.pk] = pk
          taken.push({ pk, field, value })
        }
      }
      if (taken.length === 0) return await write(new Request(req, { body: text }))
      // A row offered twice in one write, a value or not, would keep one
      // offer's value for the other's row once a conflict turns one away.
      const offered = rows.flatMap((r) => r !== null && typeof r === 'object' && r[spec.pk] !== undefined ? [canonicalKey(r[spec.pk])] : [])
      if (new Set(offered).size !== offered.length) return json({ error: `${table} is offered one row twice in one write, which a secret field cannot tell apart` }, 400)
      // Each key as the write named it and as a uuid column spells it back:
      // the one the database answers is the one a run's row names.
      const spellings = (pk: string) => [...new Set([pk, canonicalKey(pk)])]
      const settle = this.#sealed.writing(taken.map(({ pk, field, value }) => ({ at: spellings(pk).map((k) => this.#secretKey(table!, k, field)), value })))
      const landed = new Set<string>()
      // The transaction the write committed in (crud's x-txid), which orders
      // two writes to one row however their answers came back.
      let committed: number | undefined
      try {
        // Asked before the write, so nothing after its commit can fail it: a
        // uuid key is spelled back in lowercase, a text key as named.
        const uuid = patched !== undefined && canonicalKey(patched) !== patched && await this.#uuidKey(table!, spec.pk)
        const headers = new Headers(req.headers)
        headers.delete('content-length')
        // A POST names its rows in its body, and one turned away by a
        // conflict is not among them: the representation tells which landed,
        // and the edge's crud answers every POST with it anyway.
        const shown = (headers.get('prefer') ?? '').split(',').some((p) => p.trim() === 'return=representation')
        if (req.method === 'POST' && !shown) headers.set('prefer', [...(headers.get('prefer') ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '' && !p.startsWith('return=')), 'return=representation'].join(','))
        const res = await write(new Request(req.url, { method: req.method, headers, body: JSON.stringify(body) }))
        if (!res.ok) return res
        const txid = Number(res.headers.get('x-txid'))
        if (Number.isSafeInteger(txid)) committed = txid
        // The rows the write landed on, which the caller may write, are the
        // ones a value is kept for; a filter that matched none keeps none.
        // A representation names them, whichever form it came in; a minimal
        // answer to a PATCH, which names its one row by its key, counts them
        // (Content-Range), so the caller needs no SELECT.
        const answered = await res.text()
        const counted = /^(?:\d+-(\d+)|\*)\/(?:\d+|\*)$/.exec(res.headers.get('content-range') ?? '')
        if (answered === '' && req.method === 'PATCH' && counted) {
          if (counted[1] !== undefined) landed.add(uuid ? canonicalKey(patched) : patched!)
        } else if (answered !== '') {
          try {
            const rowsShown = JSON.parse(answered) as unknown
            for (const r of Array.isArray(rowsShown) ? rowsShown : [rowsShown]) if (r !== null && typeof r === 'object' && spec.pk in r) landed.add(String((r as Record<string, unknown>)[spec.pk]))
          } catch (e) {
            // The write committed: it is answered as it was, its value kept for no row.
            console.error(`a write to ${table} answered no JSON its rows could be read from: ${e instanceof Error ? e.message : e}`)
          }
        }
        return new Response(answered === '' ? null : answered, { status: res.status, headers: res.headers })
      } finally {
        const kept = new Set([...landed].flatMap((k) => [...spec.fields].map((f) => this.#secretKey(table!, k, f))))
        await settle((at) => kept.has(at), committed)
      }
    }

    /** The dispatcher's answer for a run, settled here in the object's
     * database. While a directory loads the answer is refused, and the
     * dispatcher holds it until its run's lease would end. */
    async effectAnswer(key: string, entered: number, answer: RunAnswer): Promise<void> {
      if (this.#resetting || !this.#dir.complete || !this.#dir.storageReady) throw new DataDirectoryLoading()
      await this.#effects((airlock) => airlock.answer(key, entered, answer))
      // Settled, or settled unknown on its last error: no run asks again.
      // A value another effect naming its field still awaits on the row
      // (claimed, unsettled) is kept for that one.
      if ('outcome' in answer || entered >= (effects[key.slice(0, key.indexOf(':'))]?.declaration.attempts ?? Infinity)) {
        for (const [k, v] of this.#sealed.entries()) {
          if (!v.keys.delete(key)) continue
          const [table, pk, field] = JSON.parse(k) as [string, string, string]
          const naming = Object.entries(effects).filter(([, e]) => e.declaration.table === table && e.declaration.secretFields?.includes(field))
          const awaited = await this.#effects((airlock) => airlock.awaiting(naming.map(([n]) => n), naming[0]?.[1].declaration.row[0] ?? '', pk, key))
          if (!awaited) this.#sealed.delete(k)
        }
      }
    }

    override async alarm(): Promise<void> {
      if (!this.#dir.complete || !this.#dir.storageReady) return
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
      this.#signalCompute()
      await (await this.#boot()).clock.arm()
    }

    protected async readPublic<T>(use: (snapshot: PublicSnapshot) => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      return await this.#snapshotAdmission(priority, async () => {
        const { cluster } = await this.#boot()
        return await cluster.publicSnapshot(this.#dir.generation, use, priority)
      })
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
      if (path === '/import/reset') {
        this.#resetting = true
        const booted = this.#cluster ? await this.#cluster : null
        if (booted) await booted.cluster.read(async () => {})
        for (const { owner, capture } of this.#readers.bases()) {
          if (owner === compute?.reader) await this.#reader(capture).release(capture, true)
          else this.#readers.retain(owner, capture)
          this.#readers.clearBase(owner, capture)
        }
        for (const snapshot of this.#dir.snapshots()) {
          await this.#releaseCapture({ generation: snapshot.sourceGeneration, identity: JSON.parse(snapshot.id) })
        }
        for (const { owner, capture } of this.#readers.list()) {
          if (owner === compute?.reader) await this.#readers.release(owner, capture, async () => { await this.#reader(capture).release(capture, true) })
        }
        await this.ctx.blockConcurrencyWhile(async () => {
          await this.ctx.storage.deleteAlarm()
          if (booted) await booted.cluster.read(() => Promise.resolve(this.#dir.reset()))
          else this.#dir.reset()
        })
        return json({ reset: true })
      }
      if (path === '/import/compute') {
        if (req.method !== 'GET') return json({ error: 'compute status is a GET' }, 405)
        if (!compute || !this.env.COMPUTE_COORDINATOR) return json({ error: 'computation is not configured' }, 404)
        const detail = new URL(req.url).searchParams.get('detail') === '1'
        const coordinator = await this.env.COMPUTE_COORDINATOR.get(this.env.COMPUTE_COORDINATOR.idFromName('compute')).status(detail)
        const postgresMemoryBytes = detail && this.#cluster ? (await this.#cluster).db.Module.HEAPU8.byteLength : null
        const readers = []
        for (const row of this.#readers.list()) {
          if (row.owner !== compute.reader) { readers.push({ ...row, status: null }); continue }
          try {
            readers.push({ ...row, status: { released: false, transfer: await this.#reader(row.capture).status(row.capture) } })
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'compute reader was released') throw error
            readers.push({ ...row, status: { released: true, transfer: null } })
          }
        }
        return json({ coordinator, readerOwner: compute.reader ?? null, readers, readerBases: this.#readers.bases(), ...(detail ? { postgresMemoryBytes } : {}) })
      }
      // A release's migrations over a directory kept: what the ledger lacks
      // is applied while nothing else runs, and the Worker ends the object
      // once it holds the answer, so the next request boots on the new schema,
      // under new shape handles, as after a reset.
      if (path === '/import/migrate') {
        if (req.method !== 'POST') return json({ error: 'migrate is a POST' }, 405)
        if (this.#resetting || !this.#dir.complete || !this.#dir.storageReady) return json({ error: 'the data directory is loading' }, 503)
        const scripts = await req.json() as Script[]
        if (this.#resetting) return json({ error: 'the data directory is loading' }, 503)
        const { db, cluster } = await this.#boot()
        const applied = await cluster.read(async (): Promise<string[] | Response> => {
          if (this.#resetting) return json({ error: 'the data directory is loading' }, 503)
          try {
            const names = await applyScripts(db, scripts, console.error)
            if (names.length) await db.exec('CHECKPOINT')
            return names
          } catch (error) {
            if (error instanceof NoLedger || error instanceof ChangedScript || error instanceof OutOfOrderScript || error instanceof UnrunnableScript) return json({ error: error.message }, 409)
            if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
              await db.exec('ROLLBACK')
              return json({ error: error.message, sqlstate: error.code }, 422)
            }
            throw error
          }
        })
        if (applied instanceof Response) return applied
        return json({ applied })
      }
      if (path.startsWith('/import/')) {
        if (path === '/import/storage') {
          if (req.method !== 'GET') return json({ error: 'storage status is a GET' }, 405)
          return json(this.#dir.storageStatus())
        }
        if (path === '/import/compress') {
          if (req.method !== 'POST') return json({ error: 'compression is a POST' }, 405)
          const { generation, target } = await req.json() as { generation: string; target: StorageFormat }
          this.#dir.beginCompression(generation, target)
          return json(this.#dir.advanceCompression(generation, 1024))
        }
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
      if ((CLUSTER_ROUTES.test(path) || path === '/poke') && (!this.#dir.complete || !this.#dir.storageReady)) return json({ error: 'the data directory is loading' }, 503)
      // The poke: contentless, from the Worker's Cron Trigger or a publish,
      // answered with the ticker's report (services/ticker/README.md).
      if (path === '/poke') {
        if (req.method !== 'POST') return json({ error: 'poke is a POST' }, 405)
        this.#signalCompute()
        if (clockMode === 'disabled') return compute ? json({ compute: true }) : json({ error: 'the clock is disabled' }, 409)
        const { db, cluster, clock, airlock, ticks } = await this.#boot()
        if (!ticks && hatches.length === 0) return compute ? json({ compute: true }) : json({ error: 'the data directory holds no schedule table' }, 409)
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
      if (path.startsWith('/signal/')) {
        if (!this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
        const { db, cluster, clock, airlock, ticks } = await this.#boot()
        const [, , name, id] = path.split('/')
        const bytes = new Uint8Array(await req.arrayBuffer())
        if (bytes.length > SIGNAL_MAX_BYTES) return json({ error: 'a signal is small' }, 413)
        const body = new TextDecoder().decode(bytes)
        let signal: string
        try {
          const { rows } = await cluster.serialize(() => db.query<{ signal: string }>('SELECT airlock.signal($1, $2, $3::json) AS signal', [name, id ?? null, body]))
          signal = rows[0].signal
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === 'PT503') return json({ error: 'a check is in flight' }, 503)
          if (code === 'PT404' || code === '42883' || code === '3F000') return json({ error: `no signal ${name}` }, 404)
          if (code === '22P02') return json({ error: 'a signal is JSON' }, 400)
          throw error
        }
        if (signal === 'moved') {
          if (ticks) await clock.arm()
          if (hasAirlock) this.ctx.waitUntil(airlock.drain())
        }
        return json({ signal })
      }
      if (/^\/blob-(claim|write)\//.test(path)) {
        if (!this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
        const { db, cluster } = await this.#boot()
        const auth = req.headers.get('authorization')
        const claims = auth?.startsWith('Bearer ') ? await verifyJwt(this.env.JWT_SECRET, auth.slice('Bearer '.length)) : null
        if (!claims || claims.role !== 'app_user' || typeof claims.sub !== 'string') return json({ error: 'a session is required' }, 401)
        const key = blobKeyOf(path.split('/')[2])
        if (key === null) return json({ error: 'a key is percent-encoded' }, 400)
        try {
          if (path.startsWith('/blob-claim/')) {
            await cluster.serialize(() => db.query('SELECT blob_plane.claim_key($1, $2)', [claims.sub, key]))
            return json({ claimed: key })
          }
          const { rows } = await cluster.serialize(() => db.query<{ may: boolean }>('SELECT blob_plane.may_write($1, $2) AS may', [claims.sub, key]))
          return rows[0].may ? json({ may: true }) : json({ error: 'not this session\'s claim' }, 403)
        } catch (error) {
          const status = /^PT(\d{3})$/.exec((error as { code?: string }).code ?? '')?.[1]
          if (status) return json({ error: (error as Error).message }, Number(status))
          throw error
        }
      }
      if (CLUSTER_ROUTES.test(path)) {
        const { cluster, clock, airlock, ticks } = await this.#boot()
        const res = secretTables.size > 0 ? await this.#withoutSecrets(req, (r) => cluster.handle(r)) : await cluster.handle(req)
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
