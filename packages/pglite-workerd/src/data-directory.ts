// A Durable Object's PGlite and the data directory under it. `initdb` cannot
// run in an object, so the directory is built elsewhere and arrives through
// importing() (load.ts is the sending side), which marks it complete once every
// chunk is verified; only then does open() start PGlite over it. Over a partial
// or absent directory PGlite would run initdb and answer from an empty database.
import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { SqliteFS, type StorageFormat } from './sqlite-fs.ts'

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

  constructor(storage: DurableObjectStorage, private readonly format?: StorageFormat) {
    this.#storage = storage
    storage.sql.exec('CREATE TABLE IF NOT EXISTS data_directory (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
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
    this.#fs ??= new SqliteFS(this.#storage.sql, this.format)
    return this.#fs
  }

  /** PGlite over the stored directory; once per object. */
  open(assets: Assets, options: PGliteOptions = {}): Promise<PGlite> {
    if (this.#opened) throw new Error('the data directory is already open')
    if (!this.complete) throw new Error('no complete data directory: load one through /import first')
    this.#opened = true
    return PGlite.create({
      fs: this.#dir,
      pgliteWasmModule: assets.pgliteWasm,
      initdbWasmModule: assets.initdbWasm,
      fsBundle: new Blob([assets.pgliteData]),
      icuDataDir: new Blob([assets.icu]),
      initialMemory: INITIAL_MEMORY,
      startParams: [...PGlite.defaultStartParams, ...Object.entries(SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
      ...options,
    })
  }

  /** Drops the stored directory. Open, its PGlite is lost with it: the owner
   * ends the object (ctx.abort()) once the request that asked has its answer. */
  reset() {
    SqliteFS.drop(this.#storage.sql)
    this.#storage.sql.exec('DELETE FROM data_directory')
    this.#fs = null
  }

  /** Answers load.ts's `route` (what follows /import/). Past `status`, refused
   * once open() — PGlite's writes make the stored directory differ from its
   * source — and past `reset`, once complete. */
  async importing(route: string, req: Request): Promise<Response> {
    if (route === 'status') return json({ complete: this.complete })
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
