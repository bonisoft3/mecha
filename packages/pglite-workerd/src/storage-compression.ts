import { checkFormat, decodeBlock, encodeBlock, RAW_FORMAT, type StorageFormat } from './storage-block.ts'

export interface CompressionProgress {
  generation: string
  from: StorageFormat
  target: StorageFormat
  after: { id: number; idx: number } | null
  converted: number
}

const key = 'storage_compression'
const target: StorageFormat = { version: 1, blockSize: 8192, codec: 'deflate' }
// Old workers must also refuse the directory while its blocks have mixed encodings.
const sentinel = { version: 0, blockSize: 8192, codec: 'maintenance' }
export const sameFormat = (a: StorageFormat, b: StorageFormat) => a.version === b.version && a.blockSize === b.blockSize && a.codec === b.codec

export class StorageCompression {
  constructor(private readonly storage: DurableObjectStorage) {}

  private table(name: string): boolean {
    return this.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", name).toArray().length > 0
  }

  progress(): CompressionProgress | null {
    const [row] = this.storage.sql.exec<{ value: string }>('SELECT value FROM data_directory WHERE key=?', key).toArray()
    return row ? JSON.parse(row.value) : null
  }

  format(): StorageFormat | null {
    if (this.progress()) return null
    if (this.table('fs_format')) {
      const [row] = this.storage.sql.exec<{ value: string }>('SELECT value FROM fs_format WHERE id=1').toArray()
      if (row) { const format = JSON.parse(row.value); checkFormat(format); return format }
    }
    return this.table('fs_node') && this.storage.sql.exec('SELECT 1 FROM fs_node LIMIT 1').toArray().length ? { ...RAW_FORMAT } : null
  }

  private generation(expected: string) {
    const [row] = this.storage.sql.exec<{ value: string }>("SELECT value FROM data_directory WHERE key='generation'").toArray()
    if (typeof expected !== 'string' || !expected || row?.value !== expected) throw new Error('compression directory generation differs')
    if (!this.storage.sql.exec("SELECT 1 FROM data_directory WHERE key='complete'").toArray().length) throw new Error('compression requires a complete directory')
  }

  private unpinned() {
    for (const table of ['fs_snapshot', 'fs_snapshot_node', 'fs_snapshot_block', 'fs_recompress']) {
      if (this.table(table) && this.storage.sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length) throw new Error('compression requires an unpinned directory without pending writes')
    }
    if (this.table('fs_snapshot_import') && this.storage.sql.exec('SELECT 1 FROM fs_snapshot_import WHERE complete=0 LIMIT 1').toArray().length) throw new Error('compression requires no pending physical import')
  }

  begin(expected: string, requested: StorageFormat): void {
    checkFormat(requested)
    if (!sameFormat(requested, target)) throw new Error('compression only supports 8192-byte raw to deflate')
    this.storage.transactionSync(() => {
      this.generation(expected)
      const prior = this.progress()
      if (prior) {
        if (prior.generation !== expected || !sameFormat(prior.target, requested)) throw new Error('compression request differs')
        return
      }
      const from = this.format()
      if (from && sameFormat(from, target)) return
      if (!from || !sameFormat(from, RAW_FORMAT)) throw new Error('compression only supports 8192-byte raw to deflate')
      this.unpinned()
      const progress: CompressionProgress = { generation: expected, from, target: { ...target }, after: null, converted: 0 }
      this.storage.sql.exec('CREATE TABLE IF NOT EXISTS fs_format (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)')
      this.storage.sql.exec('INSERT OR REPLACE INTO fs_format VALUES(1,?)', JSON.stringify(sentinel))
      this.storage.sql.exec('INSERT INTO data_directory VALUES(?,?)', key, JSON.stringify(progress))
    })
  }

  advance(expected: string, maxBlocks = 256): void {
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 2048) throw new Error('invalid compression batch size')
    this.storage.transactionSync(() => {
      this.generation(expected)
      const progress = this.progress()
      if (!progress) {
        const format = this.format()
        if (format && sameFormat(format, target)) return
        throw new Error('compression has not begun')
      }
      if (progress.generation !== expected || !sameFormat(progress.from, RAW_FORMAT) || !sameFormat(progress.target, target)) throw new Error('compression state differs')
      this.unpinned()
      const after = progress.after ?? { id: -1, idx: -1 }
      const rows = this.storage.sql.exec<{ id: number; idx: number; data: ArrayBuffer }>(
        'SELECT id,idx,data FROM fs_block WHERE (id,idx)>(?,?) ORDER BY id,idx LIMIT ?', after.id, after.idx, maxBlocks).toArray()
      for (const row of rows) {
        const raw = new Uint8Array(row.data)
        const encoded = encodeBlock(raw, target)
        const decoded = decodeBlock(encoded, target)
        if (decoded.length !== raw.length || decoded.some((byte, index) => byte !== raw[index])) throw new Error('compression changed block bytes')
        this.storage.sql.exec('UPDATE fs_block SET data=? WHERE id=? AND idx=?', encoded, row.id, row.idx)
        progress.after = { id: row.id, idx: row.idx }
        progress.converted++
      }
      const last = progress.after ?? after
      if (this.storage.sql.exec('SELECT 1 FROM fs_block WHERE (id,idx)>(?,?) LIMIT 1', last.id, last.idx).toArray().length) {
        this.storage.sql.exec('UPDATE data_directory SET value=? WHERE key=?', JSON.stringify(progress), key)
      } else {
        this.storage.sql.exec('UPDATE fs_format SET value=? WHERE id=1', JSON.stringify(target))
        this.storage.sql.exec('DELETE FROM data_directory WHERE key=?', key)
      }
    })
  }
}
