import assert from 'node:assert/strict'
import { SqliteFS } from '../src/sqlite-fs.ts'
import { PhysicalSnapshots, type SnapshotBlocks, type PhysicalSnapshot } from '../src/physical-snapshot.ts'
import { decodeBlock } from '../src/storage-block.ts'

export async function physicalSnapshotCases(storage: DurableObjectStorage): Promise<void> {
  const sql = storage.sql
  SqliteFS.schema(sql); SqliteFS.drop(sql)
  let fs = new SqliteFS(sql, { version: 1, blockSize: 131072, codec: 'deflate' })
  const snapshots = new PhysicalSnapshots(sql, fn => storage.transactionSync(fn))
  const size = fs.format.blockSize
  const original = new Uint8Array(size * 3 + 31)
  for (let offset = 0; offset < original.length; offset += 65536) crypto.getRandomValues(original.subarray(offset, offset + 65536))
  fs.importChunk('/data', 0, original)
  fs.writeFile('/sparse', new Uint8Array())
  const sparseFd = fs.open('/sparse')
  const patch = Uint8Array.from({ length: 8192 }, (_, i) => i % 256)
  const write = (fd: number, bytes: Uint8Array, at: number) => fs.write(fd, bytes.buffer as unknown as Uint8Array, bytes.byteOffset, bytes.length, at)
  write(sparseFd, patch, size * 2 + 17)
  await fs.syncToFs()
  const sparse = fs.readRange('/sparse', 0, size * 3)
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
      assert.ok(page.blocks.reduce((n, b) => n + b.data.byteLength, 8192) <= 256 * 1024)
      if (save) exported.push(page)
      for (const block of page.blocks) bytes.set(decodeBlock(new Uint8Array(block.data), manifest.format), block.index * size)
      if (page.done) break
      assert.ok(page.next > after); after = page.next
    }
    assert.deepEqual(bytes, expected)
  }
  image(first, '/data', original, true)
  image(first, '/sparse', sparse, true)
  write(sparseFd, patch, 0)
  const fd = fs.open('/data')
  write(fd, patch, 0)
  await fs.syncToFs()
  fs.truncate('/data', size + 13)
  fs.rename('/data', '/renamed')
  fs.unlink('/sparse')
  fs = new SqliteFS(sql)
  fs.writeFile('/new', patch)
  const frozenId = nodes.nodes.find(node => node.path === '/sparse')!.id!
  assert.throws(() => sql.exec('INSERT INTO fs_node VALUES(?,32768,0,0,?)', '/reused', frozenId), /pinned/)
  image(first, '/data', original)
  image(first, '/sparse', sparse)
  const secondExpected = fs.readRange('/renamed', 0, size * 2)
  const second = snapshots.freeze('second', 'generation', fs.format)
  const reopened = fs.open('/renamed')
  write(reopened, new Uint8Array(8192).fill(88), 0)
  fs.truncate('/renamed', 0)
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
  assert.throws(() => snapshots.blocks('first', '/data'), /unavailable/)
  assert.throws(() => snapshots.freeze('first', 'generation', fs.format), /released/)
  image(second, '/renamed', secondExpected)
  snapshots.release('second'); snapshots.release('rollback')
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
      new Uint8Array(changed.blocks[0].data)[changed.blocks[0].data.byteLength - 1] ^= 1
      assert.throws(() => target.importBlocks(changed))
    }
  }
  assert.equal(target.finishImport(first.id).complete, true)
  assert.equal(target.finishImport(first.id).complete, true)
  const restored = new SqliteFS(sql)
  assert.deepEqual(restored.readRange('/data', 0, original.length), original)
  assert.deepEqual(restored.readRange('/sparse', 0, sparse.length), sparse)
  SqliteFS.drop(sql)
  sql.exec("DELETE FROM data_directory WHERE key='complete'")
}
