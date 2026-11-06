const BLOCK_SIZE = 65_536
const owners = new WeakSet()
const decode = (mod, pointer, length) => new TextDecoder().decode(mod.HEAPU8.subarray(pointer, pointer + length))

export class SqliteFilesystem {
  constructor(sql, { path, temporaryDirectory, maxDatabaseBytes, maxTemporaryBytes }) {
    this.sql = sql
    this.path = path
    this.temporaryDirectory = temporaryDirectory
    this.maxDatabaseBytes = maxDatabaseBytes
    this.maxTemporaryBytes = maxTemporaryBytes
    this.claim()
    try {
      sql.exec('CREATE TABLE IF NOT EXISTS duckdb_format (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, block_size INTEGER NOT NULL, database_path TEXT NOT NULL, temporary_directory TEXT NOT NULL)')
      const saved = sql.exec('SELECT * FROM duckdb_format WHERE id = 1').toArray()[0]
      if (saved && (saved.version !== 1 || saved.block_size !== BLOCK_SIZE || saved.database_path !== path || saved.temporary_directory !== temporaryDirectory)) {
        throw new Error('DuckDB storage format or paths differ')
      }
      if (!saved) sql.exec('INSERT INTO duckdb_format VALUES (1, 1, ?, ?, ?)', BLOCK_SIZE, path, temporaryDirectory)
      sql.exec('CREATE TABLE IF NOT EXISTS duckdb_file (path TEXT PRIMARY KEY, size INTEGER NOT NULL, directory INTEGER NOT NULL)')
      sql.exec('CREATE TABLE IF NOT EXISTS duckdb_block (path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx)) WITHOUT ROWID')
      sql.exec('INSERT OR IGNORE INTO duckdb_file VALUES (?, 0, 1)', '/')
      this.clearTemporary()
      this.checkBudget(false, 0)
    } catch (error) { this.release(); throw error }
  }

  claim() {
    if (owners.has(this.sql)) throw new Error('DuckDB storage already has an open runtime')
    owners.add(this.sql)
  }

  release() { owners.delete(this.sql) }
  node(path) { return this.sql.exec('SELECT size, directory FROM duckdb_file WHERE path = ?', path).toArray()[0] }
  temporary(path) { return path.startsWith(this.temporaryDirectory + '/') }

  clearTemporary() {
    for (const row of this.sql.exec('SELECT path FROM duckdb_file').toArray()) {
      if (this.temporary(row.path)) this.remove(row.path)
    }
  }

  remove(path) {
    this.sql.exec('DELETE FROM duckdb_block WHERE path = ?', path)
    this.sql.exec('DELETE FROM duckdb_file WHERE path = ?', path)
  }

  checkBudget(temporary, growth) {
    let size = 0
    for (const row of this.sql.exec('SELECT path, size FROM duckdb_file')) {
      if (this.temporary(row.path) === temporary) size += row.size
    }
    if (size + growth > (temporary ? this.maxTemporaryBytes : this.maxDatabaseBytes)) {
      throw new Error(`DuckDB ${temporary ? 'temporary' : 'database'} storage budget exceeded`)
    }
  }

  read(path, target, position) {
    const file = this.node(path)
    if (!file || file.directory) throw new Error(`Missing DuckDB file: ${path}`)
    const length = Math.max(0, Math.min(target.length, file.size - position))
    target.subarray(0, length).fill(0)
    if (!length) return 0
    for (const row of this.sql.exec('SELECT idx, data FROM duckdb_block WHERE path = ? AND idx BETWEEN ? AND ?', path,
      Math.floor(position / BLOCK_SIZE), Math.floor((position + length - 1) / BLOCK_SIZE))) {
      const bytes = new Uint8Array(row.data)
      const start = row.idx * BLOCK_SIZE
      const from = Math.max(start, position)
      const to = Math.min(start + bytes.length, position + length)
      if (to > from) target.set(bytes.subarray(from - start, to - start), from - position)
    }
    return length
  }

  write(path, source, position) {
    const file = this.node(path)
    if (!file || file.directory) throw new Error(`Missing DuckDB file: ${path}`)
    const size = Math.max(file.size, position + source.length)
    this.checkBudget(this.temporary(path), size - file.size)
    for (let done = 0; done < source.length;) {
      const at = position + done
      const idx = Math.floor(at / BLOCK_SIZE)
      const within = at % BLOCK_SIZE
      const length = Math.min(BLOCK_SIZE - within, source.length - done)
      let block = source.subarray(done, done + length)
      if (within || length !== BLOCK_SIZE) {
        const row = this.sql.exec('SELECT data FROM duckdb_block WHERE path = ? AND idx = ?', path, idx).toArray()[0]
        const old = row && new Uint8Array(row.data)
        block = new Uint8Array(Math.max(old?.length ?? 0, within + length))
        if (old) block.set(old)
        block.set(source.subarray(done, done + length), within)
      }
      this.sql.exec('INSERT OR REPLACE INTO duckdb_block VALUES (?, ?, ?)', path, idx, block)
      done += length
    }
    this.sql.exec('UPDATE duckdb_file SET size = ? WHERE path = ?', size, path)
    return source.length
  }

  truncate(path, size) {
    const file = this.node(path)
    if (!file || file.directory) throw new Error(`Missing DuckDB file: ${path}`)
    this.checkBudget(this.temporary(path), size - file.size)
    this.sql.exec('DELETE FROM duckdb_block WHERE path = ? AND idx >= ?', path, Math.ceil(size / BLOCK_SIZE))
    if (size % BLOCK_SIZE) {
      const idx = Math.floor(size / BLOCK_SIZE)
      const row = this.sql.exec('SELECT data FROM duckdb_block WHERE path = ? AND idx = ?', path, idx).toArray()[0]
      if (row) this.sql.exec('UPDATE duckdb_block SET data = ? WHERE path = ? AND idx = ?', new Uint8Array(row.data).slice(0, size % BLOCK_SIZE), path, idx)
    }
    this.sql.exec('UPDATE duckdb_file SET size = ? WHERE path = ?', size, path)
  }

  install(runtime) {
    const fileName = (mod, id) => {
      const info = runtime.getFileInfo(mod, id)
      if (!info) throw new Error(`Missing DuckDB file metadata: ${id}`)
      return info.fileName
    }
    runtime.getDefaultDataProtocol = () => 3
    runtime.prepareDBFileHandle = () => Promise.resolve([])
    runtime.prepareFileHandles = () => Promise.resolve([])
    runtime.openFile = (mod, id, flags) => {
      runtime._fileInfoCache.delete(id)
      const path = fileName(mod, id)
      let node = this.node(path)
      if (!node) {
        if (flags & 128) return 0
        if (!(flags & (8 | 16))) throw new Error(`Missing DuckDB file: ${path}`)
        this.sql.exec('INSERT INTO duckdb_file VALUES (?, 0, 0)', path)
        node = this.node(path)
      }
      if (node.directory) throw new Error(`DuckDB path is a directory: ${path}`)
      if (flags & 16) { this.truncate(path, 0); node.size = 0 }
      const result = mod._malloc(24)
      mod.HEAPF64[result >> 3] = node.size
      mod.HEAPF64[(result >> 3) + 1] = 0
      mod.HEAPF64[(result >> 3) + 2] = 0
      return result
    }
    runtime.readFile = (mod, id, pointer, length, position) => this.read(fileName(mod, id), mod.HEAPU8.subarray(pointer, pointer + length), position)
    runtime.writeFile = (mod, id, pointer, length, position) => this.write(fileName(mod, id), mod.HEAPU8.subarray(pointer, pointer + length), position)
    runtime.truncateFile = (mod, id, size) => this.truncate(fileName(mod, id), size)
    runtime.syncFile = () => {}
    runtime.closeFile = (_mod, id) => runtime._fileInfoCache.delete(id)
    runtime.dropFile = (mod, pointer, length) => runtime._files.delete(decode(mod, pointer, length))
    runtime.checkFile = (mod, pointer, length) => {
      const node = this.node(decode(mod, pointer, length))
      return !!node && !node.directory
    }
    runtime.checkDirectory = (mod, pointer, length) => !!this.node(decode(mod, pointer, length))?.directory
    runtime.createDirectory = (mod, pointer, length) => this.sql.exec('INSERT OR IGNORE INTO duckdb_file VALUES (?, 0, 1)', decode(mod, pointer, length))
    runtime.removeDirectory = (mod, pointer, length) => this.remove(decode(mod, pointer, length))
    runtime.listDirectoryEntries = () => { throw new Error('DuckDB directory enumeration is unsupported') }
    runtime.removeFile = (mod, pointer, length) => this.remove(decode(mod, pointer, length))
    runtime.getLastFileModificationTime = () => 0
    runtime.moveFile = (mod, fromPointer, fromLength, toPointer, toLength) => {
      const from = decode(mod, fromPointer, fromLength)
      const to = decode(mod, toPointer, toLength)
      this.sql.exec('UPDATE duckdb_file SET path = ? WHERE path = ?', to, from)
      this.sql.exec('UPDATE duckdb_block SET path = ? WHERE path = ?', to, from)
      runtime._fileInfoCache.clear()
      return true
    }
    runtime.glob = (mod, pointer, length) => {
      for (const row of this.sql.exec('SELECT path FROM duckdb_file WHERE directory = 0 AND path GLOB ?', decode(mod, pointer, length))) {
        mod.ccall('duckdb_web_fs_glob_add_path', null, ['string'], [row.path])
      }
    }
  }
}
