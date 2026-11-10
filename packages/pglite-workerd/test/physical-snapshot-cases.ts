import assert from 'node:assert/strict'
import { SqliteFS } from '../src/sqlite-fs.ts'
import { PhysicalSnapshots, type SnapshotBlocks, type PhysicalSnapshot } from '../src/physical-snapshot.ts'
import { decodeBlock } from '../src/storage-block.ts'

export async function physicalSnapshotCases(storage: DurableObjectStorage, codec: 'raw' | 'deflate'): Promise<void> {
  const sql = storage.sql
  SqliteFS.schema(sql); SqliteFS.drop(sql)
  let fs = new SqliteFS(sql, { version: 1, blockSize: 131072, codec })
  const snapshots = new PhysicalSnapshots(sql, fn => storage.transactionSync(fn))
  // A resumed copy must not revisit every completed file to locate its next page.
  storage.transactionSync(() => {
    for (let i = 0; i < 2048; i++) sql.exec('INSERT INTO fs_snapshot_import_file VALUES(?,-1,1)', `/completed/${String(i).padStart(4, '0')}`)
    sql.exec("INSERT INTO fs_snapshot_import_file VALUES('/pending/a',-1,0),('/pending/b',-1,0)")
  })
  const pending = 'SELECT path,after_idx AS after FROM fs_snapshot_import_file WHERE done=0 ORDER BY path LIMIT 1'
  assert.match(sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${pending}`).toArray().map(row => row.detail).join('\n'), /USING INDEX fs_snapshot_import_pending/)
  assert.deepEqual(sql.exec(pending).toArray(), [{ path: '/pending/a', after: -1 }])
  sql.exec("UPDATE fs_snapshot_import_file SET after_idx=127 WHERE path='/pending/a'")
  assert.deepEqual(sql.exec(pending).toArray(), [{ path: '/pending/a', after: 127 }])
  sql.exec("UPDATE fs_snapshot_import_file SET done=1 WHERE path='/pending/a'")
  assert.deepEqual(sql.exec(pending).toArray(), [{ path: '/pending/b', after: -1 }])
  sql.exec("UPDATE fs_snapshot_import_file SET done=1 WHERE path='/pending/b'")
  const exhausted = sql.exec(pending)
  assert.deepEqual(exhausted.toArray(), [])
  assert.ok(exhausted.rowsRead <= 1, 'an exhausted pending index does not scan completed files')
  sql.exec('DELETE FROM fs_snapshot_import_file')
  const size = fs.format.blockSize
  const original = new Uint8Array(size * 3 + 31)
  for (let offset = 0; offset < original.length; offset += 65536) crypto.getRandomValues(original.subarray(offset, offset + 65536))
  fs.importChunk('/data', 0, original)
  fs.writeFile('/sparse', new Uint8Array())
  fs.writeFile('/removed', new Uint8Array([42]))
  fs.writeFile('/scan', new Uint8Array([1]))
  fs.writeFile('/grow', new Uint8Array([2]))
  for (let i = 0; i < 64; i++) fs.writeFile(`/unchanged-${String(i).padStart(2, '0')}`, new Uint8Array([i + 1]))
  const sparseFd = fs.open('/sparse')
  const patch = Uint8Array.from({ length: 8192 }, (_, i) => i % 256)
  const write = (fd: number, bytes: Uint8Array, at: number) => fs.write(fd, bytes.buffer as unknown as Uint8Array, bytes.byteOffset, bytes.length, at)
  write(sparseFd, patch, size * 2 + 17)
  await fs.syncToFs()
  const sparse = fs.readRange('/sparse', 0, size * 3)
  const scanId = sql.exec<{ id: number }>("SELECT id FROM fs_node WHERE path='/scan'").toArray()[0].id
  const encoded = sql.exec<{ data: ArrayBuffer }>('SELECT data FROM fs_block WHERE id=? AND idx=0', scanId).toArray()[0].data
  storage.transactionSync(() => {
    sql.exec("UPDATE fs_node SET size=? WHERE path='/scan'", size * 2048)
    for (let i = 1; i < 2048; i++) sql.exec('INSERT INTO fs_block VALUES(?,?,?)', scanId, i, encoded)
  })
  const first = snapshots.freeze('first', 'generation', fs.format)
  assert.deepEqual(snapshots.freeze('first', 'generation', fs.format), first)
  assert.equal(sql.exec('SELECT 1 FROM fs_snapshot_block').toArray().length, 0)
  const nodes = snapshots.nodes(first.id)
  const exported: SnapshotBlocks[] = []
  const image = (manifest: PhysicalSnapshot, path: string, expected: Uint8Array, save = false) => {
    let after = -1
    const bytes = new Uint8Array(expected.length)
    while (true) {
      const page = snapshots.blocks(manifest.id, path, after)
      assert.ok(page.blocks.reduce((n, b) => n + b.data!.byteLength, 8192) <= 256 * 1024)
      if (save) exported.push(page)
      for (const block of page.blocks) bytes.set(decodeBlock(new Uint8Array(block.data!), manifest.format), block.index * size)
      if (page.done) break
      assert.ok(page.next > after); after = page.next
    }
    assert.deepEqual(bytes, expected)
  }
  image(first, '/data', original, true)
  image(first, '/sparse', sparse, true)
  image(first, '/removed', new Uint8Array([42]), true)
  image(first, '/grow', new Uint8Array([2]), true)
  for (let i = 0; i < 64; i++) image(first, `/unchanged-${String(i).padStart(2, '0')}`, new Uint8Array([i + 1]), true)
  for (let after = -1;;) {
    const page = snapshots.blocks(first.id, '/scan', after)
    exported.push(page)
    if (page.done) break
    after = page.next
  }
  const oneFd = fs.open('/unchanged-01')
  write(oneFd, new Uint8Array([77]), 0)
  snapshots.freeze('one-change', 'generation', fs.format)
  const oneNodes = snapshots.nodes('one-change', '', first.id)
  assert.deepEqual(oneNodes.nodes.filter(node => node.needsBlocks).map(node => node.path), ['/unchanged-01'])
  write(oneFd, new Uint8Array([2]), 0)
  write(sparseFd, patch, 0)
  const fd = fs.open('/data')
  write(fd, patch, 0)
  await fs.syncToFs()
  fs.truncate('/data', size + 13)
  fs.rename('/data', '/renamed')
  fs.unlink('/removed')
  sql.exec('DELETE FROM fs_block WHERE id=? AND idx=2', nodes.nodes.find(node => node.path === '/sparse')!.id!)
  fs = new SqliteFS(sql)
  fs.writeFile('/new', patch)
  const grow = fs.open('/grow')
  write(grow, patch, size * 2 + 17)
  const frozenId = nodes.nodes.find(node => node.path === '/removed')!.id!
  assert.throws(() => sql.exec('INSERT INTO fs_node VALUES(?,32768,0,0,?)', '/reused', frozenId), /pinned/)
  image(first, '/data', original)
  image(first, '/sparse', sparse)
  const secondExpected = fs.readRange('/renamed', 0, size * 2)
  const second = snapshots.freeze('second', 'generation', fs.format)
  sql.exec('UPDATE fs_block SET data=data WHERE id=?', scanId)
  let classificationReads = 0, blockReads = 0
  const sourceSql = new Proxy(sql, { get: (target, key) => key === 'exec'
    ? (query: string, ...args: SqlStorageValue[]) => {
      const cursor = target.exec(query, ...args)
      if (!query.startsWith('SELECT n.path,') && !query.startsWith('SELECT k.idx,')) return cursor
      return new Proxy(cursor, { get: (cursor, key) => key === 'toArray'
        ? () => {
          const rows = cursor.toArray()
          if (query.startsWith('SELECT n.path,')) classificationReads = Math.max(classificationReads, cursor.rowsRead)
          else blockReads = Math.max(blockReads, cursor.rowsRead)
          return rows
        }
        : Reflect.get(cursor, key) })
    }
    : Reflect.get(target, key) })
  const measuredSource = new PhysicalSnapshots(sourceSql, fn => storage.transactionSync(fn))
  const secondNodes = measuredSource.nodes(second.id, '', first.id)
  assert.ok(classificationReads < 1000, `node classification read ${classificationReads} rows`)
  assert.equal(secondNodes.baseId, first.id)
  assert.equal(secondNodes.nodes.filter(node => node.path.startsWith('/unchanged-') && !node.needsBlocks).length, 63)
  for (const path of ['/grow', '/renamed', '/new', '/sparse']) assert.equal(secondNodes.nodes.find(node => node.path === path)?.needsBlocks, true)
  assert.equal(secondNodes.nodes.find(node => node.path === '/scan')?.needsBlocks, true)
  assert.throws(() => snapshots.nodes(second.id, '', 'missing'), /base differs/)
  const deltaPages: SnapshotBlocks[] = []
  for (const node of secondNodes.nodes.filter(node => node.needsBlocks)) {
    let after = -1
    while (true) {
      const page = measuredSource.blocks(second.id, node.path, after, first.id)
      deltaPages.push(page)
      if (page.done) break
      after = page.next
    }
  }
  assert.ok(blockReads < 1200, `block candidate page read ${blockReads} rows`)
  assert.ok(deltaPages.flatMap(page => page.blocks).reduce((sum, block) => sum + (block.data?.byteLength ?? 0), 0) < exported.flatMap(page => page.blocks).reduce((sum, block) => sum + block.data!.byteLength, 0))
  assert.ok(deltaPages.find(page => page.path === '/sparse')?.blocks.some(block => block.index === 2 && block.data === null))
  const unchangedFd = fs.open('/unchanged-00')
  write(unchangedFd, new Uint8Array([99]), 0)
  assert.deepEqual(new PhysicalSnapshots(sql, fn => storage.transactionSync(fn)).nodes(second.id, '', first.id), secondNodes)
  const reopened = fs.open('/renamed')
  write(reopened, new Uint8Array(8192).fill(88), 0)
  fs.truncate('/renamed', 0)
  assert.deepEqual(snapshots.blocks(second.id, '/renamed', -1, first.id), deltaPages.find(page => page.path === '/renamed'))
  image(second, '/renamed', secondExpected)
  image(first, '/data', original)
  assert.throws(() => SqliteFS.drop(sql), /release physical snapshots/)

  const rollback = new Error('rollback COW')
  const freshFd = fs.open('/new')
  snapshots.freeze('rollback', 'generation', fs.format)
  assert.throws(() => storage.transactionSync(() => { write(freshFd, new Uint8Array(8192).fill(99), 0); throw rollback }), error => error === rollback)
  assert.deepEqual(fs.readRange('/new', 0, patch.length), patch)
  assert.equal(sql.exec("SELECT 1 FROM fs_snapshot_block WHERE snapshot='rollback'").toArray().length, 0)
  snapshots.release('first'); snapshots.release('first')
  assert.equal(sql.exec("SELECT 1 FROM fs_snapshot_decision WHERE target='first' OR base='first'").toArray().length, 0)
  assert.throws(() => snapshots.blocks('first', '/data'), /unavailable/)
  assert.throws(() => snapshots.freeze('first', 'generation', fs.format), /released/)
  image(second, '/renamed', secondExpected)
  snapshots.release('second'); snapshots.release('rollback'); snapshots.release('one-change')
  assert.equal(sql.exec('SELECT 1 FROM fs_snapshot_node').toArray().length, 0)
  assert.equal(sql.exec('SELECT 1 FROM fs_snapshot_block').toArray().length, 0)
  SqliteFS.drop(sql); SqliteFS.schema(sql)

  const target = new PhysicalSnapshots(sql, fn => storage.transactionSync(fn))
  target.beginImport(first); target.beginImport(first)
  assert.throws(() => target.finishImport(first.id), /incomplete/)
  target.importNodes(nodes); target.importNodes(nodes)
  assert.throws(() => target.importNodes({ ...nodes, nodes: nodes.nodes.map((node, index) => index ? node : { ...node, mtime: node.mtime + 1 }) }), /differs/)
  for (const page of exported) {
    target.importBlocks(page); target.importBlocks(page)
    if (page.blocks.length) {
      const changed = structuredClone(page)
      new Uint8Array(changed.blocks[0].data!)[changed.blocks[0].data!.byteLength - 1] ^= 1
      assert.throws(() => target.importBlocks(changed))
    }
  }
  assert.equal(target.finishImport(first.id).complete, true)
  assert.equal(target.finishImport(first.id).complete, true)
  const completedSql = new Proxy(sql, { get: (target, key) => key === 'exec'
    ? (query: string, ...args: SqlStorageValue[]) => {
      assert.ok(!query.includes('fs_snapshot_import_file'), 'completed captures do not inspect transfer cursors on each source read')
      return target.exec(query, ...args)
    }
    : Reflect.get(target, key) })
  assert.equal(new PhysicalSnapshots(completedSql, fn => storage.transactionSync(fn)).importStatus()?.complete, true)
  const restored = new SqliteFS(sql)
  assert.deepEqual(restored.readRange('/data', 0, original.length), original)
  assert.deepEqual(restored.readRange('/sparse', 0, sparse.length), sparse)
  restored.unlink('/sparse')
  restored.writeFile('/local', patch)
  target.beginRestore(first.id)
  let calls = 0
  while (!new PhysicalSnapshots(sql, fn => storage.transactionSync(fn)).advanceRestore(first.id, 1)) calls++
  assert.ok(calls > 0)
  assert.equal(target.advanceRestore(first.id, 1), true)
  const pristine = new SqliteFS(sql)
  assert.deepEqual(pristine.readRange('/sparse', 0, sparse.length), sparse)
  assert.throws(() => pristine.readRange('/local', 0, patch.length))
  assert.equal(target.beginImport(second, first.id).baseId, first.id)
  assert.throws(() => target.importNodes({ ...secondNodes, baseId: 'wrong' }), /base differs/)
  assert.throws(() => target.importNodes({ ...secondNodes, nodes: secondNodes.nodes.map(({ needsBlocks: _needed, ...node }) => node) }), /block decision/)
  target.importNodes(secondNodes); target.importNodes(secondNodes)
  assert.throws(() => target.importNodes({ ...secondNodes, nodes: secondNodes.nodes.map(node => node.path === '/scan' ? { ...node, needsBlocks: false } : node) }), /differs/)
  let pruneReads = 0
  const measuredSql = new Proxy(sql, { get: (target, key) => key === 'exec'
    ? (query: string, ...args: SqlStorageValue[]) => {
      const cursor = target.exec(query, ...args)
      if (!query.startsWith('WITH removed AS MATERIALIZED')) return cursor
      return new Proxy(cursor, { get: (cursor, key) => key === 'toArray'
        ? () => { const rows = cursor.toArray(); pruneReads = Math.max(pruneReads, cursor.rowsRead); return rows }
        : Reflect.get(cursor, key) })
    }
    : Reflect.get(target, key) })
  const measured = new PhysicalSnapshots(measuredSql, fn => storage.transactionSync(fn))
  while (!measured.advanceImport(second.id, 1)) {}
  assert.ok(pruneReads < 400, `unchanged file blocks read during pruning: ${pruneReads}`)
  const requested: string[] = []
  while (target.importStatus()!.nextFile) {
    const next = target.importStatus()!.nextFile!
    requested.push(next.path)
    const page = deltaPages.find(page => page.path === next.path && page.after === next.after)!
    assert.ok(page)
    target.importBlocks(page); target.importBlocks(page)
  }
  assert.ok(requested.every(path => !path.startsWith('/unchanged-') || path === '/unchanged-01'))
  assert.deepEqual([...new Set(requested)].sort(), ['/grow', '/new', '/renamed', '/scan', '/sparse', '/unchanged-01'])
  target.finishImport(second.id)
  const imported = new SqliteFS(sql)
  assert.deepEqual(imported.readRange('/renamed', 0, secondExpected.length), secondExpected)
  assert.deepEqual(imported.readRange('/new', 0, patch.length), patch)
  assert.deepEqual(imported.readRange('/grow', size * 2 + 17, patch.length), patch)
  assert.deepEqual(imported.readRange('/sparse', size * 2, patch.length), new Uint8Array(patch.length))
  target.beginRestore(first.id)
  while (!target.advanceRestore(first.id, 1)) {}
  assert.deepEqual(new SqliteFS(sql).readRange('/data', 0, original.length), original)
  target.release(first.id); target.release(second.id)
  SqliteFS.drop(sql)
  sql.exec("DELETE FROM data_directory WHERE key IN ('complete','snapshot_restored')")
}
