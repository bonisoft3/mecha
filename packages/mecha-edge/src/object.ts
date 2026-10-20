// mecha's edge tier: the cluster in one Durable Object over PGlite (pglite-workerd).
// The object boots on the first request that needs the database, over the data
// directory a release loaded through /import/* (pglite-workerd's load.ts), and
// answers the cluster's routes (cluster.ts); worker.ts is the Worker in front.
// The environment: CLUSTER, the object's namespace; JWT_SECRET, the tokens'
// secret; IMPORT_TOKEN, the bearer /import/* takes; CF_VERSION_METADATA, the
// Worker's version; ASSETS, the static files, where it has any; OIDC_*, the
// providers a person may sign in through, as the auth service reads them
// (services/auth/README.md#provider-sign-in), a client secret as a secret;
// WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN, where passkeys belong when not the
// Worker's own door.
import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { type Assets, DataDirectory } from '../../pglite-workerd/src/data-directory.ts'
import type { StorageFormat } from '../../pglite-workerd/src/storage-block.ts'
import { providersFrom } from '../../../services/auth/oidc.ts'
import { createEdgeCluster, type EdgeCluster, type EdgeClusterConfig } from './cluster.ts'
import type { PublicSnapshot } from './public-snapshot.ts'

export interface EdgeEnv {
  CLUSTER: DurableObjectNamespace
  JWT_SECRET: string
  IMPORT_TOKEN: string
  CF_VERSION_METADATA: { id: string }
  ASSETS?: Fetcher
  WEBAUTHN_RP_ID?: string
  WEBAUTHN_ORIGIN?: string
  [setting: `OIDC_${string}`]: string | undefined
}

export interface EdgeOptions {
  assets: Assets
  /** Server tables that carry shapes, and the shell's schema (shell.json). */
  tables: string[]
  schema?: EdgeClusterConfig['schema']
  storageFormat?: StorageFormat
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/

export class DataDirectoryLoading extends Error {
  constructor() { super('the data directory is loading') }
}

export function edgeObject({ assets, tables, schema, storageFormat }: EdgeOptions) {
  return class Cluster extends DurableObject<EdgeEnv> {
    readonly #dir = new DataDirectory(this.ctx.storage, storageFormat)
    #cluster: Promise<{ db: PGlite; cluster: EdgeCluster }> | null = null

    #boot() {
      return this.#cluster ??= (async () => {
        // A provider that cannot be signed in through refuses the boot, as it
        // refuses the auth service's start.
        const providers = providersFrom((name) => this.env[name as `OIDC_${string}`])
        const db = await this.#dir.open(assets)
        const cluster = await createEdgeCluster({
          db, tables, schema, secret: this.env.JWT_SECRET, providers, log: console.error,
          webauthn: { rpId: this.env.WEBAUTHN_RP_ID || undefined, origin: this.env.WEBAUTHN_ORIGIN || undefined },
          // A hole in a shape log is answered by a fresh object: a new log,
          // under new handles every client refetches from.
          fail: (e) => this.ctx.abort(e),
        })
        return { db, cluster }
      })().catch((e) => {
        // A boot that failed leaves nothing to answer with; the next request
        // meets a fresh object.
        this.ctx.abort(e)
        throw e
      })
    }

    protected async readPublic<T>(use: (snapshot: PublicSnapshot) => Promise<T>): Promise<T> {
      if (!this.#dir.complete) throw new DataDirectoryLoading()
      const { cluster } = await this.#boot()
      return cluster.publicSnapshot(this.#dir.generation, use)
    }

    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname
      // The Worker checked the import's token: an object keeps the version,
      // and so the secrets, it started on while requests keep it awake.
      if (path === '/import/reset' && this.#cluster) {
        // A release replacing live data: the directory goes now, the object
        // and its PGlite once this answer is out.
        this.#dir.reset()
        setTimeout(() => this.ctx.abort(new Error('the data directory was reset')), 0)
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
      if (CLUSTER_ROUTES.test(path) && !this.#dir.complete) return json({ error: 'the data directory is loading' }, 503)
      if (CLUSTER_ROUTES.test(path)) return (await this.#boot()).cluster.handle(req)
      return json({ error: `no route for ${path}` }, 404)
    }
  }
}
