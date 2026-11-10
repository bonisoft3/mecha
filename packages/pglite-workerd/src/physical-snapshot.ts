import { Buffer } from 'node:buffer'
import { checkFormat, decodeBlock, type StorageFormat } from './storage-block.ts'

export interface PhysicalSnapshot { id: string; sourceGeneration: string; format: StorageFormat; nodeCount: number; logicalBytes: number }
export type SnapshotNode = { path: string; mode: number; size: number; mtime: number; id: number | null; needsBlocks?: boolean }
export interface SnapshotNodes { baseId?: string; id: string; after: string; next: string; done: boolean; nodes: SnapshotNode[] }
export interface SnapshotBlocks { id: string; path: string; after: number; next: number; done: boolean; blocks: { index: number; data: ArrayBuffer | null }[] }
export interface PhysicalImportStatus { manifest: PhysicalSnapshot; baseId: string | null; preparing: boolean; nodesAfter: string; nodesDone: boolean; nextFile: { path: string; after: number } | null; complete: boolean }

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
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_decision (target TEXT NOT NULL,base TEXT NOT NULL,path TEXT NOT NULL,needed INTEGER NOT NULL,PRIMARY KEY(target,base,path)) WITHOUT ROWID')
  sql.exec('CREATE INDEX IF NOT EXISTS fs_snapshot_decision_base ON fs_snapshot_decision(base,target)')
  sql.exec(`CREATE TABLE IF NOT EXISTS fs_snapshot_node (snapshot TEXT NOT NULL,path TEXT NOT NULL,mode INTEGER NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,id INTEGER,blocks INTEGER NOT NULL,PRIMARY KEY(snapshot,path)) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS fs_snapshot_inode_lookup ON fs_snapshot_node(id,blocks,snapshot)')
  sql.exec('CREATE INDEX IF NOT EXISTS fs_snapshot_by_inode ON fs_snapshot_node(snapshot,id)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_block(snapshot TEXT NOT NULL,id INTEGER NOT NULL,idx INTEGER NOT NULL,data BLOB,PRIMARY KEY(snapshot,id,idx)) WITHOUT ROWID')
  const hasExtra = sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fs_snapshot_extra'").toArray().length
  if (hasExtra && existing && sql.exec('SELECT 1 FROM fs_snapshot LIMIT 1').toArray().length && !sql.exec("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='fs_snapshot_extra_insert'").toArray().length) throw new Error('physical snapshots lost their filesystem guards')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_extra(snapshot TEXT NOT NULL,id INTEGER NOT NULL,idx INTEGER NOT NULL,PRIMARY KEY(snapshot,id,idx)) WITHOUT ROWID')
  if (!hasExtra) sql.exec('INSERT INTO fs_snapshot_extra SELECT s.id,b.id,b.idx FROM fs_snapshot s CROSS JOIN fs_block b WHERE NOT EXISTS(SELECT 1 FROM fs_snapshot_node n WHERE n.snapshot=s.id AND n.id=b.id AND b.idx<n.blocks)')
  sql.exec(`CREATE TRIGGER IF NOT EXISTS fs_snapshot_extra_insert BEFORE INSERT ON fs_block BEGIN
    INSERT OR IGNORE INTO fs_snapshot_extra SELECT s.id,NEW.id,NEW.idx FROM fs_snapshot s
      WHERE NOT EXISTS(SELECT 1 FROM fs_snapshot_node n WHERE n.snapshot=s.id AND n.id=NEW.id AND NEW.idx<n.blocks);
    END`)
  for (const [operation, reference, value] of [['INSERT', 'NEW', '(SELECT data FROM fs_block WHERE id=NEW.id AND idx=NEW.idx)'], ['UPDATE', 'OLD', 'OLD.data'], ['DELETE', 'OLD', 'OLD.data']]) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS fs_snapshot_${operation.toLowerCase()} BEFORE ${operation} ON fs_block BEGIN
      INSERT OR IGNORE INTO fs_snapshot_block(snapshot,id,idx,data)
      SELECT n.snapshot,${reference}.id,${reference}.idx,${value} FROM fs_snapshot_node n
      WHERE n.id=${reference}.id AND n.blocks>${reference}.idx
        AND NOT EXISTS(SELECT 1 FROM fs_snapshot_block b WHERE b.snapshot=n.snapshot AND b.id=${reference}.id AND b.idx=${reference}.idx);
      END`)
  }
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_guard (slot INTEGER PRIMARY KEY CHECK(slot=1))')
  sql.exec('DROP TRIGGER IF EXISTS fs_snapshot_inode')
  sql.exec(`CREATE TRIGGER fs_snapshot_inode BEFORE INSERT ON fs_node
    WHEN NEW.id IS NOT NULL AND EXISTS(SELECT 1 FROM fs_snapshot_node WHERE id=NEW.id)
      AND NOT EXISTS(SELECT 1 FROM fs_node WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM fs_snapshot_guard)
    BEGIN SELECT RAISE(ABORT,'file identity is pinned by a physical snapshot'); END`)
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import(slot INTEGER PRIMARY KEY CHECK(slot=1),manifest TEXT NOT NULL,nodes_after TEXT NOT NULL,nodes_done INTEGER NOT NULL,complete INTEGER NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_prepare (slot INTEGER PRIMARY KEY CHECK(slot=1))')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_base (slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_restore (slot INTEGER PRIMARY KEY CHECK(slot=1),id TEXT NOT NULL,phase INTEGER NOT NULL,after_id INTEGER NOT NULL,after_idx INTEGER NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_node (path TEXT PRIMARY KEY,mode INTEGER NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,id INTEGER)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_needed (path TEXT PRIMARY KEY,needed INTEGER NOT NULL)')
  sql.exec('CREATE TABLE IF NOT EXISTS fs_snapshot_import_file(path TEXT PRIMARY KEY,after_idx INTEGER NOT NULL,done INTEGER NOT NULL)')
  sql.exec('CREATE INDEX IF NOT EXISTS fs_snapshot_import_pending ON fs_snapshot_import_file(path) WHERE done=0')
}

export function pinnedNextId(sql: SqlStorage): number {
  return sql.exec<{ next: number }>('SELECT coalesce(max(id),0)+1 AS next FROM fs_snapshot_node').toArray()[0].next
}

export function dropSnapshotStorage(sql: SqlStorage): void {
  if (sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fs_snapshot'").toArray().length && sql.exec('SELECT 1 FROM fs_snapshot LIMIT 1').toArray().length) throw new Error('release physical snapshots before resetting the directory')
  for (const name of ['fs_snapshot_decision', 'fs_snapshot_import_needed', 'fs_snapshot_import_prepare', 'fs_snapshot_import_base', 'fs_snapshot_restore', 'fs_snapshot_guard', 'fs_snapshot_import_node', 'fs_snapshot_import_file', 'fs_snapshot_import', 'fs_snapshot_extra', 'fs_snapshot_block', 'fs_snapshot_node', 'fs_snapshot_released', 'fs_snapshot']) sql.exec(`DROP TABLE IF EXISTS ${name}`)
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

  nodes(id: string, after = '', baseId?: string): SnapshotNodes {
    return this.atomic(() => {
      const target = this.manifest(id)
      if (!target) throw new Error('physical snapshot is unavailable')
      if (baseId) {
        const base = this.manifest(baseId)
        if (!base || baseId === id || base.sourceGeneration !== target.sourceGeneration || JSON.stringify(base.format) !== JSON.stringify(target.format)) throw new Error('physical snapshot base differs')
      }
      if (after !== '') pathName(after)
      const found: SnapshotNode[] = baseId
        ? this.sql.exec<Omit<SnapshotNode, 'needsBlocks'> & { needed: number }>(`SELECT n.path,n.mode,n.size,n.mtime,n.id,
            CASE WHEN decision.needed IS NOT NULL THEN decision.needed
            WHEN n.id IS NULL OR n.blocks=0 THEN 0 WHEN old.id IS NULL OR n.blocks>old.blocks THEN 1
            WHEN EXISTS(SELECT 1 FROM fs_snapshot_block b WHERE b.snapshot=? AND b.id=n.id AND b.idx<n.blocks) THEN 1 ELSE 0 END AS needed
            FROM fs_snapshot_node n LEFT JOIN fs_snapshot_node old ON old.snapshot=? AND old.id=n.id
            LEFT JOIN fs_snapshot_decision decision ON decision.target=n.snapshot AND decision.base=? AND decision.path=n.path
            WHERE n.snapshot=? AND n.path>? ORDER BY n.path LIMIT ?`, baseId, baseId, baseId, id, after, ROWS).toArray().map(({ needed, ...node }) => ({ ...node, needsBlocks: Boolean(needed) }))
        : this.sql.exec<Omit<SnapshotNode, 'needsBlocks'>>('SELECT path,mode,size,mtime,id FROM fs_snapshot_node WHERE snapshot=? AND path>? ORDER BY path LIMIT ?', id, after, ROWS).toArray()
      const nodes: SnapshotNode[] = []
      let bytes = 8192
      for (const node of found) {
        const size = jsonBytes(node)
        if (bytes + size > BYTES) break
        nodes.push(node); bytes += size
        if (baseId) this.sql.exec('INSERT OR IGNORE INTO fs_snapshot_decision VALUES(?,?,?,?)', id, baseId, node.path, node.needsBlocks ? 1 : 0)
      }
      const next = nodes.at(-1)?.path ?? after
      const done = !this.sql.exec('SELECT 1 FROM fs_snapshot_node WHERE snapshot=? AND path>? LIMIT 1', id, next).toArray().length
      return baseId ? { id, baseId, after, next, done, nodes } : { id, after, next, done, nodes }
    })
  }

  blocks(id: string, path: string, after = -1, baseId?: string): SnapshotBlocks {
    const target = this.manifest(id)
    if (!target) throw new Error('physical snapshot is unavailable')
    pathName(path)
    if (!integer(after, -1)) throw new Error('invalid snapshot block cursor')
    const [node] = this.sql.exec<{ id: number | null; blocks: number }>('SELECT id,blocks FROM fs_snapshot_node WHERE snapshot=? AND path=?', id, path).toArray()
    if (!node || node.id === null || after >= node.blocks && !(node.blocks === 0 && after === -1)) throw new Error('invalid snapshot file or cursor')
    let baseBlocks = 0
    if (baseId) {
      const base = this.manifest(baseId)
      if (!base || baseId === id || base.sourceGeneration !== target.sourceGeneration || JSON.stringify(base.format) !== JSON.stringify(target.format)) throw new Error('physical snapshot base differs')
      const [old] = this.sql.exec<{ blocks: number }>('SELECT blocks FROM fs_snapshot_node WHERE snapshot=? AND id=?', baseId, node.id).toArray()
      baseBlocks = old?.blocks ?? 0
    }
    const keys = baseId ? `SELECT idx FROM fs_snapshot_block WHERE snapshot=? AND id=? AND idx>? AND idx<? UNION SELECT idx FROM fs_block WHERE id=? AND idx>? AND idx<? UNION SELECT idx FROM fs_snapshot_block WHERE snapshot=? AND id=? AND idx>? AND idx<? ORDER BY idx LIMIT ${ROWS}` : `SELECT idx FROM fs_block WHERE id=? AND idx>? AND idx<? UNION SELECT idx FROM fs_snapshot_block WHERE snapshot=? AND id=? AND idx>? AND idx<? ORDER BY idx LIMIT ${ROWS}`
    const params = baseId ? [baseId, node.id, after, Math.min(baseBlocks, node.blocks), node.id, Math.max(after, baseBlocks - 1), node.blocks, id, node.id, Math.max(after, baseBlocks - 1), node.blocks] : [node.id, after, node.blocks, id, node.id, after, node.blocks]
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
    const blocks = accepted ? this.sql.exec<{ index: number; data: ArrayBuffer | null }>(`SELECT k.idx AS 'index',${data} AS data ${relation} ${baseId ? 'LEFT JOIN fs_snapshot_block prior ON prior.snapshot=? AND prior.id=? AND prior.idx=k.idx' : ''} WHERE k.idx<=? ${baseId ? `AND (k.idx>=? OR prior.data IS NOT ${data})` : `AND ${data} IS NOT NULL`} ORDER BY k.idx`, ...args, ...(baseId ? [baseId, node.id, next, baseBlocks] : [next])).toArray() : []
    const done = next === node.blocks - 1 || accepted === sizes.length && sizes.length < ROWS
    return { id, path, after, next: done ? node.blocks - 1 : next, done, blocks }
  }

  release(id: string): void {
    identity(id)
    this.atomic(() => {
      if (!this.manifest(id)) return
      this.sql.exec('INSERT OR IGNORE INTO fs_snapshot_released VALUES(?)', id)
      this.sql.exec('DELETE FROM fs_snapshot_decision WHERE target=? OR base=?', id, id)
      this.sql.exec('DELETE FROM fs_snapshot_block WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot_extra WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot_node WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot WHERE id=?', id)
    })
  }

  beginRestore(id: string): void {
    const manifest = this.manifest(id)
    if (!manifest) throw new Error('physical snapshot is unavailable')
    this.atomic(() => {
      const [prior] = this.sql.exec<{ id: string }>('SELECT id FROM fs_snapshot_restore WHERE slot=1').toArray()
      if (prior) { if (prior.id !== id) throw new Error('physical restore differs'); return }
      this.sql.exec('INSERT INTO fs_snapshot_restore VALUES(1,?,0,-1,-1)', id)
      this.sql.exec("DELETE FROM data_directory WHERE key IN ('complete','snapshot_restored')")
    })
  }

  advanceRestore(id: string, maxBlocks = 128): boolean {
    if (!integer(maxBlocks, 1) || maxBlocks > 1024) throw new Error('invalid restore batch size')
    return this.atomic(() => {
      const [state] = this.sql.exec<{ id: string; phase: number; after_id: number; after_idx: number }>('SELECT * FROM fs_snapshot_restore WHERE slot=1').toArray()
      if (!state) {
        const [restored] = this.sql.exec<{ value: string }>("SELECT value FROM data_directory WHERE key='snapshot_restored'").toArray()
        if (restored?.value === id) return true
        throw new Error('physical restore is unavailable')
      }
      if (state.id !== id) throw new Error('physical restore is unavailable')
      const manifest = this.manifest(id)
      if (!manifest) throw new Error('physical snapshot is unavailable')
      if (state.phase === 0) {
        const rows = this.sql.exec<{ id: number; idx: number }>('SELECT id,idx FROM fs_snapshot_extra WHERE snapshot=? LIMIT ?', id, maxBlocks).toArray()
        for (const row of rows) {
          this.sql.exec('DELETE FROM fs_block WHERE id=? AND idx=?', row.id, row.idx)
          this.sql.exec('DELETE FROM fs_snapshot_extra WHERE snapshot=? AND id=? AND idx=?', id, row.id, row.idx)
        }
        if (rows.length === maxBlocks) return false
        this.sql.exec('UPDATE fs_snapshot_restore SET phase=1 WHERE slot=1')
      }
      const rows = this.sql.exec<{ id: number; idx: number; data: ArrayBuffer | null }>('SELECT id,idx,data FROM fs_snapshot_block WHERE snapshot=? AND (id,idx)>(?,?) ORDER BY id,idx LIMIT ?', id, state.after_id, state.after_idx, maxBlocks).toArray()
      for (const row of rows) {
        if (row.data === null) this.sql.exec('DELETE FROM fs_block WHERE id=? AND idx=?', row.id, row.idx)
        else this.sql.exec('INSERT OR REPLACE INTO fs_block VALUES(?,?,?)', row.id, row.idx, row.data)
      }
      if (rows.length) {
        const last = rows[rows.length - 1]
        this.sql.exec('UPDATE fs_snapshot_restore SET after_id=?,after_idx=? WHERE slot=1', last.id, last.idx)
      }
      if (rows.length === maxBlocks) return false
      this.sql.exec('DELETE FROM fs_node')
      this.sql.exec('INSERT INTO fs_snapshot_guard VALUES(1)')
      this.sql.exec('INSERT INTO fs_node SELECT path,mode,size,mtime,id FROM fs_snapshot_node WHERE snapshot=?', id)
      this.sql.exec('DELETE FROM fs_snapshot_guard')
      this.sql.exec('DELETE FROM fs_recompress')
      this.sql.exec('DELETE FROM fs_snapshot_import_file')
      this.sql.exec('DELETE FROM fs_snapshot_import_node')
      this.sql.exec('DELETE FROM fs_snapshot_import_needed')
      this.sql.exec('DELETE FROM fs_snapshot_import')
      this.sql.exec('DELETE FROM fs_snapshot_import_base')
      this.sql.exec('DELETE FROM fs_snapshot_import_prepare')
      this.sql.exec('DELETE FROM fs_snapshot_restore')
      this.sql.exec("INSERT OR REPLACE INTO data_directory VALUES('complete',?)", new Date().toISOString())
      this.sql.exec("INSERT OR REPLACE INTO data_directory VALUES('snapshot_restored',?)", id)
      return true
    })
  }

  importStatus(): PhysicalImportStatus | null {
    const [row] = this.sql.exec<{ manifest: string; nodes_after: string; nodes_done: number; complete: number }>('SELECT * FROM fs_snapshot_import WHERE slot=1').toArray()
    if (!row) return null
    const preparing = Boolean(this.sql.exec('SELECT 1 FROM fs_snapshot_import_prepare WHERE slot=1').toArray().length)
    const [file] = row.nodes_done && !row.complete && !preparing
      ? this.sql.exec<{ path: string; after: number }>('SELECT path,after_idx AS after FROM fs_snapshot_import_file WHERE done=0 ORDER BY path LIMIT 1').toArray()
      : []
    return { manifest: JSON.parse(row.manifest), preparing, baseId: this.sql.exec<{ id: string }>('SELECT id FROM fs_snapshot_import_base WHERE slot=1').toArray()[0]?.id ?? null, nodesAfter: row.nodes_after, nodesDone: Boolean(row.nodes_done), nextFile: row.nodes_done ? file ?? null : null, complete: Boolean(row.complete) }
  }

  beginImport(manifest: PhysicalSnapshot, baseId?: string): PhysicalImportStatus {
    identity(manifest.id); identity(manifest.sourceGeneration); checkFormat(manifest.format)
    if (!integer(manifest.nodeCount, 1) || !integer(manifest.logicalBytes)) throw new Error('invalid physical snapshot manifest')
    return this.atomic(() => {
      const prior = this.importStatus()
      if (prior) {
        if (JSON.stringify(prior.manifest) !== JSON.stringify(manifest) || prior.baseId !== (baseId ?? null)) throw new Error('physical import manifest differs')
        return prior
      }
      if (baseId) {
        const base = this.manifest(baseId)
        if (!base || baseId === manifest.id || base.sourceGeneration !== manifest.sourceGeneration || JSON.stringify(base.format) !== JSON.stringify(manifest.format)) throw new Error('physical import base differs')
        const [restored] = this.sql.exec<{ value: string }>("SELECT value FROM data_directory WHERE key='snapshot_restored'").toArray()
        if (restored?.value !== baseId) throw new Error('physical import requires a restored base')
        this.sql.exec("DELETE FROM data_directory WHERE key IN ('complete','snapshot_restored')")
      } else if (this.sql.exec('SELECT 1 FROM fs_node LIMIT 1').toArray().length) throw new Error('physical import requires an empty directory')
      this.sql.exec('INSERT OR REPLACE INTO fs_format(id,value) VALUES(1,?)', JSON.stringify(manifest.format))
      this.sql.exec('INSERT INTO fs_snapshot_import VALUES(1,?,?,0,0)', JSON.stringify(manifest), '')
      if (baseId) this.sql.exec('INSERT INTO fs_snapshot_import_base VALUES(1,?)', baseId)
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
      if ((page.baseId ?? null) !== status.baseId) throw new Error('physical node page base differs')
      const replay = page.after !== status.nodesAfter || status.nodesDone
      let previous = page.after
      for (const node of page.nodes) {
        pathName(node.path)
        if (!integer(node.size) || !integer(node.mode) || !Number.isFinite(node.mtime) || node.id !== null && !integer(node.id, 1) || comparePath(node.path, previous) <= 0) throw new Error('invalid snapshot node')
        if (status.baseId && (typeof node.needsBlocks !== 'boolean' || (node.id === null || node.size === 0) && node.needsBlocks)) throw new Error('invalid snapshot node block decision')
        if (!status.baseId && node.needsBlocks !== undefined) throw new Error('unexpected snapshot node block decision')
        previous = node.path
        if (replay) {
          const [saved] = this.sql.exec<Omit<SnapshotNode, 'needsBlocks'>>(`SELECT path,mode,size,mtime,id FROM ${status.baseId ? 'fs_snapshot_import_node' : 'fs_node'} WHERE path=?`, node.path).toArray()
          if (!saved || !sameNode(saved, node)) throw new Error('replayed snapshot node differs')
          if (status.baseId) {
            const [decision] = this.sql.exec<{ needed: number }>('SELECT needed FROM fs_snapshot_import_needed WHERE path=?', node.path).toArray()
            if (!decision || Boolean(decision.needed) !== node.needsBlocks) throw new Error('replayed snapshot node differs')
          }
        } else {
          this.sql.exec(`INSERT INTO ${status.baseId ? 'fs_snapshot_import_node' : 'fs_node'}(path,mode,size,mtime,id) VALUES(?,?,?,?,?)`, node.path, node.mode, node.size, node.mtime, node.id)
          if (status.baseId) this.sql.exec('INSERT INTO fs_snapshot_import_needed VALUES(?,?)', node.path, node.needsBlocks ? 1 : 0)
          if (node.id !== null) this.sql.exec('INSERT INTO fs_snapshot_import_file VALUES(?,-1,?)', node.path, node.size === 0 || status.baseId && !node.needsBlocks ? 1 : 0)
        }
      }
      if (page.next !== previous || typeof page.done !== 'boolean' || !page.done && !page.nodes.length) throw new Error('invalid node page cursor')
      if (replay) {
        if (comparePath(page.next, status.nodesAfter) > 0) throw new Error('node replay exceeds saved cursor')
      } else {
        if (page.done && status.baseId) {
          this.sql.exec('DELETE FROM fs_node')
          this.sql.exec('INSERT INTO fs_snapshot_guard VALUES(1)')
          this.sql.exec('INSERT INTO fs_node SELECT * FROM fs_snapshot_import_node')
          this.sql.exec('DELETE FROM fs_snapshot_guard')
          this.sql.exec('INSERT INTO fs_snapshot_import_prepare VALUES(1)')
        }
        this.sql.exec('UPDATE fs_snapshot_import SET nodes_after=?,nodes_done=? WHERE slot=1', page.next, page.done ? 1 : 0)
      }
      return this.importStatus()!
    })
  }

  advanceImport(id: string, maxBlocks = 128): boolean {
    if (!integer(maxBlocks, 1) || maxBlocks > 1024) throw new Error('invalid import batch size')
    return this.atomic(() => {
      const status = this.importStatus()
      if (!status || status.manifest.id !== id || !status.nodesDone || status.complete) throw new Error('physical import is unavailable')
      if (!status.preparing) return true
      const rows = this.sql.exec<{ id: number; idx: number }>(`WITH removed AS MATERIALIZED (SELECT old.id FROM fs_snapshot_node old WHERE old.snapshot=? AND old.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fs_node n WHERE n.id=old.id)), shortened AS MATERIALIZED (SELECT old.id,CAST((n.size+?-1)/? AS INTEGER) AS keep FROM fs_snapshot_node old JOIN fs_node n ON n.id=old.id WHERE old.snapshot=? AND n.size<old.size) SELECT b.id,b.idx FROM removed CROSS JOIN fs_block b ON b.id=removed.id UNION ALL SELECT b.id,b.idx FROM shortened CROSS JOIN fs_block b ON b.id=shortened.id AND b.idx>=shortened.keep LIMIT ?`, status.baseId!, status.manifest.format.blockSize, status.manifest.format.blockSize, status.baseId!, maxBlocks).toArray()
      for (const row of rows) this.sql.exec('DELETE FROM fs_block WHERE id=? AND idx=?', row.id, row.idx)
      if (rows.length === maxBlocks) return false
      this.sql.exec('DELETE FROM fs_snapshot_import_prepare')
      return true
    })
  }

  importBlocks(page: SnapshotBlocks): PhysicalImportStatus {
    if (!page || !Array.isArray(page.blocks) || page.blocks.length > ROWS || !integer(page.after, -1) || !integer(page.next, -1)) throw new Error('invalid physical block page')
    pathName(page.path)
    let bytes = 8192, previous = page.after
    for (const block of page.blocks) {
      if (!(block.data instanceof ArrayBuffer) && block.data !== null || !integer(block.index) || block.index <= previous || block.index > page.next) throw new Error('invalid physical block')
      bytes += block.data?.byteLength ?? 0; previous = block.index
    }
    if (bytes > BYTES) throw new Error('physical block page exceeds bounds')
    return this.atomic(() => {
      const status = this.importStatus()
      if (!status || page.id !== status.manifest.id || !status.nodesDone || status.preparing || status.complete) throw new Error('physical import is unavailable')
      const [file] = this.sql.exec<{ id: number; size: number; after_idx: number; done: number }>('SELECT n.id,n.size,f.after_idx,f.done FROM fs_node n JOIN fs_snapshot_import_file f USING(path) WHERE path=?', page.path).toArray()
      if (!file) throw new Error('physical import file is unavailable')
      const last = Math.ceil(file.size / status.manifest.format.blockSize) - 1
      if (page.next > last || page.next < page.after || page.done !== (page.next === last) || !page.done && page.next === page.after) throw new Error('invalid physical block page cursor')
      const replay = page.after !== file.after_idx || Boolean(file.done)
      if (replay && page.next > file.after_idx) throw new Error('block replay exceeds saved cursor')
      for (const block of page.blocks) {
        if (block.data === null) {
          if (!status.baseId) throw new Error('unexpected snapshot tombstone')
          if (replay) { if (this.sql.exec('SELECT 1 FROM fs_block WHERE id=? AND idx=?', file.id, block.index).toArray().length) throw new Error('replayed snapshot block differs') }
          else this.sql.exec('DELETE FROM fs_block WHERE id=? AND idx=?', file.id, block.index)
          continue
        }
        const decoded = decodeBlock(new Uint8Array(block.data), status.manifest.format)
        if (decoded.length > Math.min(status.manifest.format.blockSize, file.size - block.index * status.manifest.format.blockSize)) throw new Error('snapshot block exceeds file size')
        if (replay) {
          if (!this.sql.exec('SELECT 1 FROM fs_block WHERE id=? AND idx=? AND data=?', file.id, block.index, block.data).toArray().length) throw new Error('replayed snapshot block differs')
        } else this.sql.exec('INSERT OR REPLACE INTO fs_block VALUES(?,?,?)', file.id, block.index, block.data)
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
      if (!status.nodesDone || status.preparing || status.nextFile) throw new Error('physical import is incomplete')
      const totals = this.sql.exec<{ nodes: number; bytes: number }>('SELECT count(*) AS nodes,coalesce(sum(size),0) AS bytes FROM fs_node').toArray()[0]
      if (totals.nodes !== status.manifest.nodeCount || totals.bytes !== status.manifest.logicalBytes || !this.sql.exec("SELECT 1 FROM fs_node WHERE path='/' AND id IS NULL AND (mode & 16384)!=0").toArray().length) throw new Error('physical import metadata differs')
      this.sql.exec('INSERT INTO fs_snapshot(id,manifest) VALUES(?,?)', id, JSON.stringify(status.manifest))
      this.sql.exec('INSERT INTO fs_snapshot_node SELECT ?,path,mode,size,mtime,id,CAST((size+?-1)/? AS INTEGER) FROM fs_node', id, status.manifest.format.blockSize, status.manifest.format.blockSize)
      this.sql.exec('UPDATE fs_snapshot_import SET complete=1 WHERE slot=1')
      this.sql.exec("INSERT INTO data_directory(key,value) VALUES('complete',?)", new Date().toISOString())
      return this.importStatus()!
    })
  }
}
