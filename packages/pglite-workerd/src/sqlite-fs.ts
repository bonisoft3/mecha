// PGlite's data directory as rows of a Durable Object's SQLite: a node per
// path, a file's bytes as fixed blocks keyed by (file, index). Both PGlite's
// filesystem calls and ctx.storage.sql are synchronous, so Postgres reads a
// page from storage when it asks for it, as OpfsAhpFS reads from an OPFS
// access handle. Decoded blocks have a bounded cache checked against storage.
// The persisted format fixes block size and codec for the directory.
import { BaseFilesystem, ERRNO_CODES, type FsStats } from '@electric-sql/pglite/basefs'
import { checkFormat, encodeBlock, RAW_FORMAT, type StorageFormat } from './storage-block.ts'
import { BlockDecoder } from './block-decoder.ts'
export type { StorageFormat } from './storage-block.ts'

const DIR = 16384
const FILE = 32768

interface Node { mode: number; size: number; mtime: number; id: number | null }

class FsError extends Error {
  code: number
  constructor(code: keyof typeof ERRNO_CODES, message: string) {
    super(`${code}: ${message}`)
    this.code = ERRNO_CODES[code]
  }
}

export class SqliteFS extends BaseFilesystem {
  readonly #format: StorageFormat
  readonly #decoder: BlockDecoder
  readonly #sql: SqlStorage
  readonly #nodes = new Map<string, Node>()
  readonly #fds = new Map<number, string>()
  #nextFd = 1
  #nextId = 1

  constructor(sql: SqlStorage, requested?: StorageFormat) {
    super('sqlite://')
    this.#sql = sql
    if (requested) checkFormat(requested)
    SqliteFS.schema(sql)
    const [saved] = sql.exec<{ value: string }>('SELECT value FROM fs_format WHERE id = 1').toArray()
    const existing = sql.exec('SELECT 1 FROM fs_node LIMIT 1').toArray().length > 0
    this.#format = Object.freeze(saved ? JSON.parse(saved.value) : existing ? { ...RAW_FORMAT } : { ...(requested ?? RAW_FORMAT) })
    checkFormat(this.#format)
    this.#decoder = new BlockDecoder(this.#format)
    if (requested && (requested.version !== this.#format.version || requested.blockSize !== this.#format.blockSize || requested.codec !== this.#format.codec)) {
      throw new Error('filesystem storage format differs; load a fresh directory to change it')
    }
    if (!saved) sql.exec('INSERT INTO fs_format (id, value) VALUES (1, ?)', JSON.stringify(this.#format))
    for (const r of sql.exec<{ path: string; mode: number; size: number; mtime: number; id: number | null }>('SELECT path, mode, size, mtime, id FROM fs_node')) {
      this.#nodes.set(r.path, { mode: r.mode, size: r.size, mtime: r.mtime, id: r.id })
      if (r.id !== null && r.id >= this.#nextId) this.#nextId = r.id + 1
    }
    if (!this.#nodes.has('/')) this.#put('/', { mode: DIR | 0o700, size: 0, mtime: Date.now(), id: null })
  }

  static schema(sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS fs_format (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)')
    sql.exec(`CREATE TABLE IF NOT EXISTS fs_node (path TEXT PRIMARY KEY, mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, id INTEGER UNIQUE)`)
    sql.exec(`CREATE TABLE IF NOT EXISTS fs_block (id INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, idx)) WITHOUT ROWID`)
  }

  /** Drops the stored directory; a SqliteFS over it must not be used again. */
  static drop(sql: SqlStorage) {
    sql.exec('DROP TABLE IF EXISTS fs_format')
    sql.exec('DROP TABLE IF EXISTS fs_block')
    sql.exec('DROP TABLE IF EXISTS fs_node')
  }

  #put(path: string, n: Node) {
    this.#nodes.set(path, n)
    this.#sql.exec('INSERT OR REPLACE INTO fs_node (path, mode, size, mtime, id) VALUES (?, ?, ?, ?, ?)', path, n.mode, n.size, n.mtime, n.id)
  }

  #norm(path: string) {
    return '/' + path.split('/').filter(Boolean).join('/')
  }

  #parent(path: string) {
    const i = path.lastIndexOf('/')
    return i <= 0 ? '/' : path.slice(0, i)
  }

  #node(path: string): Node {
    const n = this.#nodes.get(this.#norm(path))
    if (!n) throw new FsError('ENOENT', path)
    return n
  }

  #file(path: string): Node {
    const n = this.#node(path)
    if (n.mode & DIR) throw new FsError('EISDIR', path)
    return n
  }

  #dir(path: string): Node {
    const n = this.#node(path)
    if (!(n.mode & DIR)) throw new FsError('ENOTDIR', path)
    return n
  }

  #block(id: number, idx: number): Uint8Array | null {
    const rows = this.#sql.exec<{ data: ArrayBuffer }>('SELECT data FROM fs_block WHERE id = ? AND idx = ?', id, idx).toArray()
    return rows.length ? this.#decoder.decode(`${id}:${idx}`, new Uint8Array(rows[0].data)) : null
  }

  #setBlock(id: number, idx: number, data: Uint8Array) {
    this.#sql.exec('INSERT OR REPLACE INTO fs_block (id, idx, data) VALUES (?, ?, ?)', id, idx, encodeBlock(data, this.#format))
  }

  /** Writes bytes at a position, block by block; a partial block is merged
   * with what is stored, and a block is stored only as long as it is filled. */
  #writeAt(n: Node, src: Uint8Array, position: number) {
    let done = 0
    while (done < src.length) {
      const at = position + done
      const idx = Math.floor(at / this.#format.blockSize)
      const within = at % this.#format.blockSize
      const len = Math.min(this.#format.blockSize - within, src.length - done)
      let block: Uint8Array
      if (within === 0 && len === this.#format.blockSize) block = src.subarray(done, done + len)
      else {
        const old = this.#block(n.id!, idx)
        block = new Uint8Array(Math.max(old?.length ?? 0, within + len))
        if (old) block.set(old)
        block.set(src.subarray(done, done + len), within)
      }
      this.#setBlock(n.id!, idx, block)
      done += len
    }
  }

  #resize(path: string, n: Node, size: number) {
    if (size < n.size) {
      const keep = Math.ceil(size / this.#format.blockSize)
      this.#sql.exec('DELETE FROM fs_block WHERE id = ? AND idx >= ?', n.id, keep)
      if (size % this.#format.blockSize) {
        const last = this.#block(n.id!, keep - 1)
        if (last && last.length > size % this.#format.blockSize) this.#setBlock(n.id!, keep - 1, last.slice(0, size % this.#format.blockSize))
      }
    }
    n.size = size
    n.mtime = Date.now()
    this.#put(path, n)
  }

  // Import: the data directory arrives file by file, in chunks, before PGlite starts.
  importDir(path: string) {
    const p = this.#norm(path)
    if (!this.#nodes.has(p)) this.#put(p, { mode: DIR | 0o700, size: 0, mtime: Date.now(), id: null })
  }

  importChunk(path: string, offset: number, bytes: Uint8Array) {
    const p = this.#norm(path)
    let n = this.#nodes.get(p)
    if (!n) {
      if (offset !== 0) throw new Error(`${p}: first chunk at ${offset}`)
      n = { mode: FILE | 0o600, size: 0, mtime: Date.now(), id: this.#nextId++ }
    }
    if (offset !== n.size) throw new Error(`${p}: chunk at ${offset}, file has ${n.size}`)
    this.#writeAt(n, bytes, offset)
    n.size = offset + bytes.length
    this.#put(p, n)
  }

  /** Every node, for a loader resuming an import: a file's size is how much
   * of it is stored, since chunks only append. */
  importState(): { path: string; dir: boolean; size: number }[] {
    return [...this.#nodes].map(([path, n]) => ({ path, dir: (n.mode & DIR) !== 0, size: n.size }))
  }

  /** Bytes of a file as stored, for checking an import against its source. */
  readRange(path: string, position: number, length: number): Uint8Array<ArrayBuffer> {
    const n = this.#file(path)
    const out = new Uint8Array(Math.max(0, Math.min(length, n.size - position)))
    const first = Math.floor(position / this.#format.blockSize)
    const last = Math.floor((position + out.length - 1) / this.#format.blockSize)
    for (const r of this.#sql.exec<{ idx: number; data: ArrayBuffer }>('SELECT idx, data FROM fs_block WHERE id = ? AND idx BETWEEN ? AND ?', n.id, first, last)) {
      const data = this.#decoder.decode(`${n.id}:${r.idx}`, new Uint8Array(r.data))
      const blockStart = r.idx * this.#format.blockSize
      const from = Math.max(position, blockStart)
      const to = Math.min(position + out.length, blockStart + data.length)
      if (to > from) out.set(data.subarray(from - blockStart, to - blockStart), from - position)
    }
    return out
  }

  // BaseFilesystem

  chmod(path: string, mode: number): void {
    const n = this.#node(path)
    n.mode = mode
    this.#put(this.#norm(path), n)
  }

  close(fd: number): void {
    this.#fds.delete(fd)
  }

  fstat(fd: number): FsStats {
    return this.lstat(this.#path(fd))
  }

  lstat(path: string): FsStats {
    const n = this.#node(path)
    return {
      dev: 0, ino: 0, mode: n.mode, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size: n.size, blksize: this.#format.blockSize, blocks: Math.ceil(n.size / this.#format.blockSize),
      atime: n.mtime, mtime: n.mtime, ctime: n.mtime,
    }
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const p = this.#norm(path)
    if (this.#nodes.has(p)) {
      if (options?.recursive) return
      throw new FsError('EEXIST', p)
    }
    const parent = this.#parent(p)
    if (!this.#nodes.has(parent)) {
      if (!options?.recursive) throw new FsError('ENOENT', parent)
      this.mkdir(parent, options)
    }
    this.#dir(parent)
    this.#put(p, { mode: options?.mode || DIR | 0o700, size: 0, mtime: Date.now(), id: null })
  }

  open(path: string, _flags?: string, _mode?: number): number {
    this.#file(path)
    const fd = this.#nextFd++
    this.#fds.set(fd, this.#norm(path))
    return fd
  }

  #path(fd: number) {
    const p = this.#fds.get(fd)
    if (!p) throw new FsError('EBADF', String(fd))
    return p
  }

  readdir(path: string): string[] {
    const p = this.#norm(path)
    this.#dir(p)
    const prefix = p === '/' ? '/' : p + '/'
    const out: string[] = []
    for (const k of this.#nodes.keys()) {
      if (k !== p && k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) out.push(k.slice(prefix.length))
    }
    return out
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const n = this.#file(this.#path(fd))
    const end = Math.min(position + length, n.size)
    if (position >= end) return 0
    const first = Math.floor(position / this.#format.blockSize)
    const last = Math.floor((end - 1) / this.#format.blockSize)
    const dst = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, end - position)
    dst.fill(0)
    for (const r of this.#sql.exec<{ idx: number; data: ArrayBuffer }>('SELECT idx, data FROM fs_block WHERE id = ? AND idx BETWEEN ? AND ?', n.id, first, last)) {
      const data = this.#decoder.decode(`${n.id}:${r.idx}`, new Uint8Array(r.data))
      const blockStart = r.idx * this.#format.blockSize
      const from = Math.max(position, blockStart)
      const to = Math.min(end, blockStart + data.length)
      if (to > from) dst.set(data.subarray(from - blockStart, to - blockStart), from - position)
    }
    return end - position
  }

  rename(oldPath: string, newPath: string): void {
    const from = this.#norm(oldPath)
    const to = this.#norm(newPath)
    this.#node(from)
    const existing = this.#nodes.get(to)
    if (existing) {
      if (existing.mode & DIR) throw new FsError('EISDIR', to)
      this.#drop(to, existing)
    }
    const moves = [...this.#nodes.keys()].filter((k) => k === from || k.startsWith(from + '/'))
    for (const k of moves) {
      const m = this.#nodes.get(k)!
      this.#nodes.delete(k)
      this.#sql.exec('DELETE FROM fs_node WHERE path = ?', k)
      this.#put(to + k.slice(from.length), m)
    }
  }

  #drop(path: string, n: Node) {
    this.#nodes.delete(path)
    this.#sql.exec('DELETE FROM fs_node WHERE path = ?', path)
    if (n.id !== null) this.#sql.exec('DELETE FROM fs_block WHERE id = ?', n.id)
  }

  rmdir(path: string): void {
    const p = this.#norm(path)
    const n = this.#dir(p)
    if (this.readdir(p).length) throw new FsError('ENOTEMPTY', p)
    this.#drop(p, n)
  }

  truncate(path: string, len = 0): void {
    const p = this.#norm(path)
    const n = this.#file(p)
    this.#resize(p, n, len)
  }

  unlink(path: string): void {
    const p = this.#norm(path)
    this.#drop(p, this.#file(p))
  }

  utimes(path: string, _atime: number, mtime: number): void {
    const n = this.#node(path)
    n.mtime = mtime
    this.#put(this.#norm(path), n)
  }

  writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }): void {
    const p = this.#norm(path)
    this.#dir(this.#parent(p))
    let n = this.#nodes.get(p)
    if (n && n.mode & DIR) throw new FsError('EISDIR', p)
    if (n) this.#resize(p, n, 0)
    else n = { mode: options?.mode || FILE | 0o600, size: 0, mtime: Date.now(), id: this.#nextId++ }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (bytes.length) this.#writeAt(n, bytes, 0)
    n.size = bytes.length
    this.#put(p, n)
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const p = this.#path(fd)
    const n = this.#file(p)
    // createEmscriptenFS hands over the heap's ArrayBuffer and an offset into it.
    const src = new Uint8Array(buffer as unknown as ArrayBuffer, offset, length)
    this.#writeAt(n, src, position)
    if (position + length > n.size) {
      n.size = position + length
      n.mtime = Date.now()
      this.#put(p, n)
    }
    return length
  }
}
