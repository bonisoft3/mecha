// A Durable Object's PGlite and the data directory under it. `initdb` cannot
// run in an object, so the directory is built elsewhere and arrives through
// importing() (load.ts is the sending side), which marks it complete once every
// chunk is verified; only then does open() start PGlite over it. Over a partial
// or absent directory PGlite would run initdb and answer from an empty database.
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { loadIncrementalViews } from '../../incremental-views/runtime.ts'
import { SqliteFS, type StorageFormat } from './sqlite-fs.ts'
import { PhysicalSnapshots, type PhysicalSnapshot, type SnapshotNodes, type SnapshotBlocks, type PhysicalImportStatus } from './physical-snapshot.ts'
import { StorageCompression, sameFormat } from './storage-compression.ts'
export type { PhysicalSnapshot, SnapshotNode, SnapshotNodes, SnapshotBlocks, PhysicalImportStatus } from './physical-snapshot.ts'

/** What the package's dist/ holds, as a Worker imports it. */
export interface Assets {
  pgliteWasm: WebAssembly.Module
  initdbWasm: WebAssembly.Module
  pgliteData: ArrayBuffer
  /** An ICU data archive, icu-root.tgz or one with the collations an app opens. */
  icu: ArrayBuffer
}

// Postgres's memory cut to what an isolate's 128 MB holds beside the wasm
// heap; measured with GolAberto's 5.2 GB archive (README.md).
export const SETTINGS: Record<string, string> = {
  shared_buffers: '16MB',
  work_mem: '8MB',
  maintenance_work_mem: '8MB',
  temp_buffers: '1MB',
  wal_buffers: '256kB',
}
const INITIAL_MEMORY = 16 * 2 ** 20

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

export class DataDirectory {
  readonly #storage: DurableObjectStorage
  #fs: SqliteFS | null = null
  #opened = false
  #db: Promise<PGlite> | null = null
  #physical: PhysicalSnapshots | null = null
  readonly #compression: StorageCompression

  constructor(storage: DurableObjectStorage, private readonly format?: StorageFormat) {
    this.#storage = storage
    storage.sql.exec('CREATE TABLE IF NOT EXISTS data_directory (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    this.#compression = new StorageCompression(storage)
  }

  get storageReady(): boolean {
    if (this.#compression.progress()) return false
    const actual = this.#compression.format()
    return !actual || !this.format || sameFormat(actual, this.format)
  }

  storageStatus() {
    return { format: this.#compression.format(), maintenance: this.#compression.progress(), requested: this.format ?? null,
      generation: this.complete ? this.generation : null, databaseSize: this.#storage.sql.databaseSize, ready: this.storageReady }
  }

  beginCompression(expectedGeneration: string, target: StorageFormat) {
    if (this.#opened) throw new Error('compression requires an unopened directory')
    this.#compression.begin(expectedGeneration, target)
    this.#fs = null
    return this.storageStatus()
  }

  advanceCompression(expectedGeneration: string, maxBlocks = 256) {
    if (this.#opened) throw new Error('compression requires an unopened directory')
    this.#compression.advance(expectedGeneration, maxBlocks)
    this.#fs = null
    return this.storageStatus()
  }

  #available() {
    if (this.#compression.progress()) throw new Error('data directory storage maintenance is active')
  }

  get complete(): boolean {
    return this.#storage.sql.exec("SELECT 1 FROM data_directory WHERE key = 'complete'").toArray().length > 0
  }

  /** Stable through eviction, replaced with the directory on reset. */
  get generation(): string {
    if (!this.complete) throw new Error('no complete data directory')
    const [stored] = this.#storage.sql.exec<{ value: string }>("SELECT value FROM data_directory WHERE key = 'generation'").toArray()
    if (stored) return stored.value
    const generation = crypto.randomUUID()
    this.#storage.sql.exec("INSERT INTO data_directory (key, value) VALUES ('generation', ?)", generation)
    return generation
  }

  get #dir() {
    this.#available()
    this.#fs ??= new SqliteFS(this.#storage.sql, this.format)
    return this.#fs
  }

  /** PGlite over the stored directory; once per object. */
  open(assets: Assets, options: PGliteOptions = {}): Promise<PGlite> {
    if (!this.storageReady) throw new Error('data directory storage is not ready')
    if (this.#opened) throw new Error('the data directory is already open')
    if (!this.complete) throw new Error('no complete data directory: load one through /import first')
    this.#opened = true
    this.#db = PGlite.create({
      fs: this.#dir,
      pgliteWasmModule: assets.pgliteWasm,
      initdbWasmModule: assets.initdbWasm,
      fsBundle: new Blob([assets.pgliteData]),
      icuDataDir: new Blob([assets.icu]),
      initialMemory: INITIAL_MEMORY,
      startParams: [...PGlite.defaultStartParams, ...Object.entries(SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
      ...options,
    }).then(loadIncrementalViews)
    return this.#db
  }

  get #snapshots() {
    this.#available()
    if (!this.#physical) {
      SqliteFS.schema(this.#storage.sql)
      this.#physical = new PhysicalSnapshots(this.#storage.sql, fn => this.#storage.transactionSync(fn))
    }
    return this.#physical
  }

  /** The caller holds the database serializer through committed sync and this cut. */
  async freeze(id: string): Promise<PhysicalSnapshot> {
    if (!this.complete) throw new Error('cannot snapshot an incomplete directory')
    const prior = this.#snapshots.manifest(id)
    if (prior) {
      if (prior.sourceGeneration !== this.generation) throw new Error('snapshot directory generation differs')
      return prior
    }
    if (this.#db) {
      const db = await this.#db
      if (db.fs !== this.#dir) throw new Error('snapshot requires the owned data-directory filesystem')
      if (db.isInTransaction()) throw new Error('cannot snapshot an open PostgreSQL transaction')
      await db.syncToFs()
      if (db.isInTransaction()) throw new Error('snapshot requires the database serializer')
    }
    return this.#snapshots.freeze(id, this.generation, this.#dir.format)
  }

  snapshotManifest(id: string): PhysicalSnapshot | null { return this.#snapshots.manifest(id) }
  snapshots(): PhysicalSnapshot[] { return this.#snapshots.list() }
  snapshotNodes(id: string, after = ''): SnapshotNodes { return this.#snapshots.nodes(id, after) }
  snapshotBlocks(id: string, path: string, after = -1): SnapshotBlocks { return this.#snapshots.blocks(id, path, after) }
  releaseSnapshot(id: string): void { this.#snapshots.release(id) }
  snapshotImportStatus(): PhysicalImportStatus | null { return this.#snapshots.importStatus() }
  beginSnapshotImport(manifest: PhysicalSnapshot): PhysicalImportStatus {
    if (this.#opened || this.complete) throw new Error('physical import requires an unopened incomplete directory')
    return this.#snapshots.beginImport(manifest)
  }
  importSnapshotNodes(page: SnapshotNodes): PhysicalImportStatus {
    if (this.#opened) throw new Error('physical import directory is open')
    return this.#snapshots.importNodes(page)
  }
  importSnapshotBlocks(page: SnapshotBlocks): PhysicalImportStatus {
    if (this.#opened) throw new Error('physical import directory is open')
    return this.#snapshots.importBlocks(page)
  }
  finishSnapshotImport(id: string): PhysicalImportStatus {
    if (this.#opened) throw new Error('physical import directory is open')
    const result = this.#snapshots.finishImport(id)
    this.#fs = null
    return result
  }

  /** Drops the stored directory. Open, its PGlite is lost with it: the owner
   * ends the object (ctx.abort()) once the request that asked has its answer. */
  reset() {
    this.#available()
    SqliteFS.drop(this.#storage.sql)
    this.#storage.sql.exec('DELETE FROM data_directory')
    this.#fs = null
    this.#physical = null
  }

  /** Answers load.ts's `route` (what follows /import/). Past `status`, refused
   * once open() — PGlite's writes make the stored directory differ from its
   * source — and past `reset`, once complete. */
  async importing(route: string, req: Request): Promise<Response> {
    if (route === 'status') return json({ complete: this.complete })
    if (this.#compression.progress()) return json({ error: 'data directory storage maintenance is active' }, 503)
    if (this.#opened) return json({ error: 'the data directory is open; an import needs a fresh object' }, 409)
    const q = new URL(req.url).searchParams
    switch (route) {
      case 'reset':
        this.reset()
        return json({ reset: true })
    }
    if (this.complete) return json({ error: 'the data directory is complete; reset to load another' }, 409)
    switch (route) {
      case 'complete':
        this.#storage.sql.exec("INSERT INTO data_directory (key, value) VALUES ('complete', ?)", new Date().toISOString())
        return json({ complete: true })
      case 'dir':
        this.#dir.importDir(q.get('path')!)
        return json({ ok: true })
      case 'chunk': {
        const bytes = new Uint8Array(await req.arrayBuffer())
        // One transaction, so a file's stored size always ends a whole chunk.
        this.#storage.transactionSync(() => this.#dir.importChunk(q.get('path')!, Number(q.get('offset')), bytes))
        return json({ ok: true, bytes: bytes.length })
      }
      case 'state':
        return json(this.#dir.importState())
      case 'hash': {
        const ranges = (await req.json()) as { path: string; offset: number; length: number }[]
        return json(await Promise.all(ranges.map(async (r) => hex(await crypto.subtle.digest('SHA-256', this.#dir.readRange(r.path, r.offset, r.length))))))
      }
    }
    return json({ error: `no import route ${route}` }, 404)
  }
}
