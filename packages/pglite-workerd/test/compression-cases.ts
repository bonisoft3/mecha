import assert from 'node:assert/strict'
import { DataDirectory, type Assets } from '../src/data-directory.ts'
import { SqliteFS } from '../src/sqlite-fs.ts'
import { checkFormat, type StorageFormat } from '../src/storage-block.ts'

export const compressionTarget: StorageFormat = { version: 1, blockSize: 8192, codec: 'deflate' }
const generation = 'compression-fixture-generation'
const contents = () => Uint8Array.from({ length: 24593 }, (_, index) => (index * 37) % 256)
const incompressible = () => {
  let state = 123456789
  return Uint8Array.from({ length: 8192 }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255 })
}

function prepare(storage: DurableObjectStorage) {
  const directory = new DataDirectory(storage, compressionTarget)
  SqliteFS.schema(storage.sql)
  SqliteFS.drop(storage.sql)
  const fs = new SqliteFS(storage.sql)
  fs.importDir('/base')
  fs.importChunk('/base/relation', 0, contents())
  fs.importChunk('/random', 0, incompressible())
  fs.importChunk('/wal', 0, new Uint8Array())
  const tail = Uint8Array.of(0, 1, 255)
  fs.write(fs.open('/wal'), tail.buffer as unknown as Uint8Array, 0, tail.length, 16384)
  fs.importChunk('/empty', 0, new Uint8Array())
  storage.sql.exec('INSERT INTO data_directory VALUES(?,?)', 'generation', generation)
  storage.sql.exec("INSERT INTO data_directory VALUES('complete','kept-completion-time')")
  return directory
}

export function compressionCases(storage: DurableObjectStorage) {
  const directory = prepare(storage)
  const sql = storage.sql
  const nodes = sql.exec('SELECT * FROM fs_node ORDER BY path').toArray()
  const blocks = sql.exec('SELECT id,idx FROM fs_block ORDER BY id,idx').toArray()
  assert.equal(directory.storageReady, false)
  assert.throws(() => directory.open({} as Assets), /storage is not ready/)
  assert.throws(() => directory.beginCompression('different-generation', compressionTarget), /generation differs/)
  assert.throws(() => directory.beginCompression(generation, { ...compressionTarget, blockSize: 131072 }), /only supports/)
  sql.exec("INSERT INTO fs_snapshot VALUES('pin','{}')")
  assert.throws(() => directory.beginCompression(generation, compressionTarget), /unpinned/)
  sql.exec('DELETE FROM fs_snapshot')
  sql.exec('INSERT INTO fs_recompress VALUES(1,0)')
  assert.throws(() => directory.beginCompression(generation, compressionTarget), /pending writes/)
  sql.exec('DELETE FROM fs_recompress')
  sql.exec("INSERT INTO fs_snapshot_import VALUES(1,'{}','',0,0)")
  assert.throws(() => directory.beginCompression(generation, compressionTarget), /pending physical import/)
  sql.exec('DELETE FROM fs_snapshot_import')
  assert.equal(directory.beginCompression(generation, compressionTarget).maintenance?.converted, 0)
  assert.equal(directory.beginCompression(generation, compressionTarget).maintenance?.converted, 0)
  // The persisted sentinel is also rejected by workers that predate maintenance.
  assert.throws(() => checkFormat(JSON.parse(sql.exec<{ value: string }>('SELECT value FROM fs_format').toArray()[0].value)), /unsupported/)
  assert.throws(() => new SqliteFS(sql), /unsupported/)
  assert.throws(() => directory.reset(), /maintenance/)
  assert.throws(() => directory.snapshots(), /maintenance/)
  assert.throws(() => directory.advanceCompression(generation, 2049), /batch size/)
  assert.throws(() => directory.advanceCompression('different-generation'), /generation differs/)

  const before = sql.exec('SELECT id,idx,hex(data) AS data FROM fs_block ORDER BY id,idx').toArray()
  sql.exec("CREATE TRIGGER fail_compression BEFORE UPDATE ON fs_block WHEN OLD.idx=1 BEGIN SELECT RAISE(ABORT,'injected conversion failure'); END")
  assert.throws(() => directory.advanceCompression(generation, 3), /injected conversion failure/)
  assert.deepEqual(sql.exec('SELECT id,idx,hex(data) AS data FROM fs_block ORDER BY id,idx').toArray(), before)
  assert.equal(directory.storageStatus().maintenance?.converted, 0)
  sql.exec('DROP TRIGGER fail_compression')
  assert.equal(directory.advanceCompression(generation, 2).maintenance?.converted, 2)
  const resumed = new DataDirectory(storage, compressionTarget)
  while (resumed.storageStatus().maintenance) resumed.advanceCompression(generation, 2)
  assert.equal(resumed.storageReady, true)
  assert.equal(resumed.beginCompression(generation, compressionTarget).maintenance, null)
  assert.equal(resumed.advanceCompression(generation).maintenance, null)
  assert.deepEqual(sql.exec('SELECT * FROM fs_node ORDER BY path').toArray(), nodes)
  assert.deepEqual(sql.exec('SELECT id,idx FROM fs_block ORDER BY id,idx').toArray(), blocks)
  assert.equal(resumed.generation, generation)
  assert.equal(sql.exec<{ value: string }>("SELECT value FROM data_directory WHERE key='complete'").toArray()[0].value, 'kept-completion-time')
  const fs = new SqliteFS(sql, compressionTarget)
  assert.deepEqual(fs.readRange('/base/relation', 0, contents().length), contents())
  assert.deepEqual(fs.readRange('/random', 0, 8192), incompressible())
  assert.deepEqual(fs.readRange('/wal', 0, 16387), Uint8Array.from({ length: 16387 }, (_, i) => i === 16385 ? 1 : i === 16386 ? 255 : 0))
  assert.equal(fs.readRange('/empty', 0, 1).length, 0)
}

export function compressionCrash(storage: DurableObjectStorage, recover: boolean) {
  if (!recover) {
    const directory = prepare(storage)
    directory.beginCompression(generation, compressionTarget)
    directory.advanceCompression(generation, 1)
    return
  }
  const directory = new DataDirectory(storage, compressionTarget)
  assert.equal(directory.storageStatus().maintenance?.converted, 1)
  assert.equal(directory.storageReady, false)
  while (directory.storageStatus().maintenance) directory.advanceCompression(generation, 1)
  assert.deepEqual(new SqliteFS(storage.sql).readRange('/base/relation', 0, contents().length), contents())
  assert.equal(directory.generation, generation)
}
