import { Buffer } from 'node:buffer'
import { checkFormat, decodeBlock, type StorageFormat } from './storage-block.ts'

export interface PhysicalSnapshot { id: string; sourceGeneration: string; format: StorageFormat; nodeCount: number; logicalBytes: number }
export type SnapshotNode = { path: string; mode: number; size: number; mtime: number; id: number | null }
export interface SnapshotNodes { id: string; after: string; next: string; done: boolean; nodes: SnapshotNode[] }
export interface SnapshotBlocks { id: string; path: string; after: number; next: number; done: boolean; blocks: { index: number; data: ArrayBuffer }[] }
export interface PhysicalImportStatus { manifest: PhysicalSnapshot; nodesAfter: string; nodesDone: boolean; nextFile: { path: string; after: number } | null; complete: boolean }

const ROWS = 128
const BYTES = 256 * 1024
const encoder = new TextEncoder()
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
const identity = (id: string) => { if (typeof id !== 'string' || !id || encoder.encode(id).byteLength > 2048) throw new Error('invalid physical snapshot identity') }
const pathName = (path: string) => { if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || encoder.encode(path).byteLength > 4096) throw new Error('invalid snapshot path') }
const integer = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const comparePath = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const sameNode = (a: SnapshotNode, b: SnapshotNode) => a.path === b.path && a.id === b.id && a.mode === b.mode && a.size === b.size && a.mtime === b.mtime

export function initializeSnapshots(sql: SqlStorage): void {
  const existing = sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fs_snapshot'").toArray().length
  if (existing && sql.exec('SELECT 1 FROM fs_snapshot LIMIT 1').toArray().length) {
    const count = sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name IN ('fs_snapshot_insert','fs_snapshot_update','fs_snapshot_delete','fs_snapshot_inode')").toArray()[0].n
    if (count !== 4) throw new Error('physical snapshots lost their filesystem guards; release snapshots before resetting or downgrading')
  }
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot (id TEXT PRIMARY KEY, manifest TEXT NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_released (id TEXT PRIMARY KEY)')
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_snapshot_node (snapshot TEXT NOT NULL,path TEXT NOT NULL,mode INTEGER NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,id INTEGER,blocks INTEGER NOT NULL,PRIMARY KEY(snapshot,path)) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS fs_snapshot_inode_lookup ON fs_snapshot_node(id,blocks,snapshot)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_block(snapshot TEXT NOT NULL,id INTEGER NOT NULL,idx INTEGER NOT NULL,data BLOB,PRIMARY KEY(snapshot,id,idx)) WITHOUT ROWID')
  for (const [operation, reference, value] of [['INSERT', 'NEW', '(SELECT data FROM fs_block WHERE id=NEW.id AND idx=NEW.idx)'], ['UPDATE', 'OLD', 'OLD.data'], ['DELETE', 'OLD', 'OLD.data']]) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS fs_snapshot_${operation.toLowerCase()} BEFORE ${operation} ON fs_block BEGIN
      INSERT OR IGNORE INTO fs_snapshot_block(snapshot,id,idx,data)
      SELECT n.snapshot,${reference}.id,${reference}.idx,${value} FROM fs_snapshot_node n
      WHERE n.id=${reference}.id AND n.blocks>${reference}.idx
        AND NOT EXISTS(SELECT 1 FROM fs_snapshot_block b WHERE b.snapshot=n.snapshot AND b.id=${reference}.id AND b.idx=${reference}.idx);
      END`)
  }
  sql.exec(`CREATE TRIGGER IF NOT EXISTS fs_snapshot_inode BEFORE INSERT ON fs_node
    WHEN NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM fs_snapshot_node WHERE id=NEW.id)
      AND NOT EXISTS(SELECT 1 FROM fs_node WHERE id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'file identity is pinned by a physical snapshot'); END`)
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import(slot INTEGER PRIMARY KEY CHECK(slot=1),manifest TEXT NOT NULL,nodes_after TEXT NOT NULL,nodes_done INTEGER NOT NULL,complete INTEGER NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_file(path TEXT PRIMARY KEY,after_idx INTEGER NOT NULL,done INTEGER NOT NULL)')
}

export function pinnedNextId(sql: SqlStorage): number {
  return sql.exec<{ next: number }>('SELECT coalesce(max(id),0)+1 AS next FROM fs_snapshot_node').toArray()[0].next
}

export function dropSnapshotStorage(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fs_snapshot'").toArray().length && sql.exec('SELECT 1 FROM fs_snapshot LIMIT 1').toArray().length) throw new Error('release physical snapshots before resetting the directory')
  for (const name of ['fs_snapshot_import_file', 'fs_snapshot_import', 'fs_snapshot_block', 'fs_snapshot_node', 'fs_snapshot_released', 'fs_snapshot']) sql.exec(`DROP TABLE IF EXISTS ${name}`)
}

export class PhysicalSnapshots {
  constructor(private readonly sql: SqlStorage, private readonly atomic: <T>(fn: () => T) => T) {}

  manifest(id: string): PhysicalSnapshot | null {
    identity(id)
    const [row] = this.sql.exec<{ manifest: string }>('SELECT manifest FROM fs_snapshot WHERE id=?', id).toArray()
    return row ? JSON.parse(row.manifest) : null
  }

  list(): PhysicalSnapshot[] { return this.sql.exec<{ manifest: string }>('SELECT manifest FROM fs_snapshot ORDER BY id').toArray().map(row => JSON.parse(row.manifest)) }

  freeze(id: string, sourceGeneration: string, format: StorageFormat): PhysicalSnapshot {
    identity(id)
    return this.atomic(() => {
      if (this.sql.exec('SELECT 1 FROM fs_snapshot_released WHERE id=?', id).toArray().length) throw new Error('physical snapshot was released')
      const prior = this.manifest(id)
      if (prior) {
        if (prior.sourceGeneration !== sourceGeneration) throw new Error('snapshot identity belongs to another directory generation')
        return prior
      }
      if (this.sql.exec('SELECT 1 FROM fs_node WHERE length(CAST(path AS BLOB))>4096 LIMIT 1').toArray().length) throw new Error('snapshot path exceeds export bounds')
      const totals = this.sql.exec<{ nodes: number; bytes: number }>('SELECT count(*) AS nodes,coalesce(sum(size),0) AS bytes FROM fs_node').toArray()[0]
      const manifest = { id, sourceGeneration, format, nodeCount: totals.nodes, logicalBytes: totals.bytes }
      this.sql.exec('INSERT INTO fs_snapshot(id,manifest) VALUES(?,?)', id, JSON.stringify(manifest))
      this.sql.exec(`INSERT INTO fs_snapshot_node SELECT ?,path,mode,size,mtime,id,CAST((size+?-1)/? AS INTEGER) FROM fs_node`, id, format.blockSize, format.blockSize)
      return manifest
    })
  }

  nodes(id: string, after = ''): SnapshotNodes {
    if (!this.manifest(id)) throw new Error('physical snapshot is unavailable')
    if (after !== '') pathName(after)
    const found = this.sql.exec<SnapshotNode>('SELECT path,mode,size,mtime,id FROM fs_snapshot_node WHERE snapshot=? AND path>? ORDER BY path LIMIT ?', id, after, ROWS).toArray()
    const nodes: SnapshotNode[] = []
    let bytes = 8192
    for (const node of found) {
      const size = jsonBytes(node)
      if (bytes + size > BYTES) break
      nodes.push(node); bytes += size
    }
    const next = nodes.at(-1)?.path ?? after
    const done = !this.sql.exec('SELECT 1 FROM fs_snapshot_node WHERE snapshot=? AND path>? LIMIT 1', id, next).toArray().length
    return { id, after, next, done, nodes }
  }

  blocks(id: string, path: string, after = -1): SnapshotBlocks {
    if (!this.manifest(id)) throw new Error('physical snapshot is unavailable')
    pathName(path)
    if (!integer(after, -1)) throw new Error('invalid snapshot block cursor')
    const [node] = this.sql.exec<{ id: number | null; blocks: number }>('SELECT id,blocks FROM fs_snapshot_node WHERE snapshot=? AND path=?', id, path).toArray()
    if (!node || node.id === null || after >= node.blocks && !(node.blocks === 0 && after === -1)) throw new Error('invalid snapshot file or cursor')
    const keys = `SELECT idx FROM fs_block WHERE id=? AND idx>? AND idx<? UNION SELECT idx FROM fs_snapshot_block WHERE snapshot=? AND id=? AND idx>? AND idx<? ORDER BY idx LIMIT ${ROWS}`
    const params = [node.id, after, node.blocks, id, node.id, after, node.blocks]
    const relation = `FROM (${keys}) k LEFT JOIN fs_snapshot_block old ON old.snapshot=? AND old.id=? AND old.idx=k.idx LEFT JOIN fs_block live ON live.id=? AND live.idx=k.idx`
    const args = [...params, id, node.id, node.id]
    const data = 'CASE WHEN old.snapshot IS NOT NULL THEN old.data ELSE live.data END'
    const sizes = this.sql.exec<{ idx: number; bytes: number }>(`SELECT k.idx,coalesce(length(${data}),0) AS bytes ${relation} ORDER BY k.idx`, ...args).toArray()
    let bytes = 8192, next = after, accepted = 0
    for (const row of sizes) {
      if (row.bytes > BYTES - 8192) throw new Error('physical snapshot block exceeds export bounds')
      if (bytes + row.bytes > BYTES) break
      bytes += row.bytes; next = row.idx; accepted++
    }
    const blocks = accepted ? this.sql.exec<{ index: number; data: ArrayBuffer }>(`SELECT k.idx AS 'index',${data} AS data ${relation} WHERE k.idx<=? AND ${data} IS NOT NULL ORDER BY k.idx`, ...args, next).toArray() : []
    const done = next === node.blocks - 1 || accepted === sizes.length && sizes.length < ROWS
    return { id, path, after, next: done ? node.blocks - 1 : next, done, blocks }
  }

  release(id: string): void {
    identity(id)
    this.atomic(() => {
      if (!this.manifest(id)) return
      this.sql.exec('INSERT OR IGNORE INTO fs_snapshot_released VALUES(?)', id)
      this.sql.exec('DELETE FROM fs_snapshot_block WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot_node WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot WHERE id=?', id)
    })
  }

  importStatus(): PhysicalImportStatus | null {
    const [row] = this.sql.exec<{ manifest: string; nodes_after: string; nodes_done: number; complete: number }>('SELECT * FROM fs_snapshot_import WHERE slot=1').toArray()
    if (!row) return null
    const [file] = this.sql.exec<{ path: string; after: number }>('SELECT path,after_idx AS after FROM fs_snapshot_import_file WHERE done=0 ORDER BY path LIMIT 1').toArray()
    return { manifest: JSON.parse(row.manifest), nodesAfter: row.nodes_after, nodesDone: Boolean(row.nodes_done), nextFile: row.nodes_done ? file ?? null : null, complete: Boolean(row.complete) }
  }

  beginImport(manifest: PhysicalSnapshot): PhysicalImportStatus {
    identity(manifest.id); identity(manifest.sourceGeneration); checkFormat(manifest.format)
    if (!integer(manifest.nodeCount, 1) || !integer(manifest.logicalBytes)) throw new Error('invalid physical snapshot manifest')
    return this.atomic(() => {
      const prior = this.importStatus()
      if (prior) {
        if (JSON.stringify(prior.manifest) !== JSON.stringify(manifest)) throw new Error('physical import manifest differs')
        return prior
      }
      if (this.sql.exec('SELECT 1 FROM fs_node LIMIT 1').toArray().length) throw new Error('physical import requires an empty directory')
      this.sql.exec('INSERT OR REPLACE INTO fs_format(id,value) VALUES(1,?)', JSON.stringify(manifest.format))
      this.sql.exec('INSERT INTO fs_snapshot_import VALUES(1,?,?,0,0)', JSON.stringify(manifest), '')
      return this.importStatus()!
    })
  }

  importNodes(page: SnapshotNodes): PhysicalImportStatus {
    if (!page || !Array.isArray(page.nodes) || page.nodes.length > ROWS || jsonBytes(page) > BYTES) throw new Error('physical node page exceeds bounds')
    if (typeof page.after !== 'string' || typeof page.next !== 'string' || typeof page.done !== 'boolean') throw new Error('invalid node page cursor')
    if (page.after !== '') pathName(page.after)
    return this.atomic(() => {
      const status = this.importStatus()
      if (!status || page.id !== status.manifest.id || status.complete) throw new Error('physical import is unavailable')
      const replay = page.after !== status.nodesAfter || status.nodesDone
      let previous = page.after
      for (const node of page.nodes) {
        pathName(node.path)
        if (!integer(node.size) || !integer(node.mode) || !Number.isFinite(node.mtime) || node.id !== null && !integer(node.id, 1) || comparePath(node.path, previous) <= 0) throw new Error('invalid snapshot node')
        previous = node.path
        if (replay) {
          const [saved] = this.sql.exec<SnapshotNode>('SELECT path,mode,size,mtime,id FROM fs_node WHERE path=?', node.path).toArray()
          if (!saved || !sameNode(saved, node)) throw new Error('replayed snapshot node differs')
        } else {
          this.sql.exec('INSERT INTO fs_node(path,mode,size,mtime,id) VALUES(?,?,?,?,?)', node.path, node.mode, node.size, node.mtime, node.id)
          if (node.id !== null) this.sql.exec('INSERT INTO fs_snapshot_import_file VALUES(?,-1,?)', node.path, node.size === 0 ? 1 : 0)
        }
      }
      if (page.next !== previous || typeof page.done !== 'boolean' || !page.done && !page.nodes.length) throw new Error('invalid node page cursor')
      if (replay) {
        if (comparePath(page.next, status.nodesAfter) > 0) throw new Error('node replay exceeds saved cursor')
      } else this.sql.exec('UPDATE fs_snapshot_import SET nodes_after=?,nodes_done=? WHERE slot=1', page.next, page.done ? 1 : 0)
      return this.importStatus()!
    })
  }

  importBlocks(page: SnapshotBlocks): PhysicalImportStatus {
    if (!page || !Array.isArray(page.blocks) || page.blocks.length > ROWS || !integer(page.after, -1) || !integer(page.next, -1)) throw new Error('invalid physical block page')
    pathName(page.path)
    let bytes = 8192, previous = page.after
    for (const block of page.blocks) {
      if (!(block.data instanceof ArrayBuffer) || !integer(block.index) || block.index <= previous || block.index > page.next) throw new Error('invalid physical block')
      bytes += block.data.byteLength; previous = block.index
    }
    if (bytes > BYTES) throw new Error('physical block page exceeds bounds')
    return this.atomic(() => {
      const status = this.importStatus()
      if (!status || page.id !== status.manifest.id || !status.nodesDone || status.complete) throw new Error('physical import is unavailable')
      const [file] = this.sql.exec<{ id: number; size: number; after_idx: number; done: number }>('SELECT n.id,n.size,f.after_idx,f.done FROM fs_node n JOIN fs_snapshot_import_file f USING(path) WHERE path=?', page.path).toArray()
      if (!file) throw new Error('physical import file is unavailable')
      const last = Math.ceil(file.size / status.manifest.format.blockSize) - 1
      if (page.next > last || page.next < page.after || page.done !== (page.next === last) || !page.done && page.next === page.after) throw new Error('invalid physical block page cursor')
      const replay = page.after !== file.after_idx || Boolean(file.done)
      if (replay && page.next > file.after_idx) throw new Error('block replay exceeds saved cursor')
      for (const block of page.blocks) {
        const decoded = decodeBlock(new Uint8Array(block.data), status.manifest.format)
        if (decoded.length > Math.min(status.manifest.format.blockSize, file.size - block.index * status.manifest.format.blockSize)) throw new Error('snapshot block exceeds file size')
        if (replay) {
          if (!this.sql.exec('SELECT 1 FROM fs_block WHERE id=? AND idx=? AND data=?', file.id, block.index, block.data).toArray().length) throw new Error('replayed snapshot block differs')
        } else this.sql.exec('INSERT INTO fs_block VALUES(?,?,?)', file.id, block.index, block.data)
      }
      if (!replay) this.sql.exec('UPDATE fs_snapshot_import_file SET after_idx=?,done=? WHERE path=?', page.next, page.done ? 1 : 0, page.path)
      return this.importStatus()!
    })
  }

  finishImport(id: string): PhysicalImportStatus {
    return this.atomic(() => {
      const status = this.importStatus()
      if (!status || status.manifest.id !== id) throw new Error('physical import is unavailable')
      if (status.complete) return status
      if (!status.nodesDone || status.nextFile) throw new Error('physical import is incomplete')
      const totals = this.sql.exec<{ nodes: number; bytes: number }>('SELECT count(*) AS nodes,coalesce(sum(size),0) AS bytes FROM fs_node').toArray()[0]
      if (totals.nodes !== status.manifest.nodeCount || totals.bytes !== status.manifest.logicalBytes || !this.sql.exec("SELECT 1 FROM fs_node WHERE path='/' AND id IS NULL AND (mode & 16384)!=0").toArray().length) throw new Error('physical import metadata differs')
      this.sql.exec('UPDATE fs_snapshot_import SET complete=1 WHERE slot=1')
      this.sql.exec("INSERT INTO data_directory(key,value) VALUES('complete',?)", new Date().toISOString())
      return this.importStatus()!
    })
  }
}
