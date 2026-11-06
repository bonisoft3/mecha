import assert from 'node:assert/strict'
import { SqliteFS } from '../src/sqlite-fs.ts'

const format = { version: 1, blockSize: 131072, codec: 'deflate' } as const
const page = Uint8Array.from({ length: 8192 }, (_, index) => (index * 37) % 256)
const pending = (sql: SqlStorage) => sql.exec<{ count: number }>('SELECT count(*) AS count FROM fs_recompress').toArray()[0].count
const write = (fs: SqliteFS, fd: number, data: Uint8Array, offset: number) => fs.write(fd, data.buffer as unknown as Uint8Array, data.byteOffset, data.byteLength, offset)

export async function recompressionCases(storage: DurableObjectStorage): Promise<void> {
  const sql = storage.sql
  SqliteFS.schema(sql)
  SqliteFS.drop(sql)
  let fs = new SqliteFS(sql, format)
  const expected = new Uint8Array(format.blockSize * 40).fill(65)
  fs.importChunk('/data', 0, expected)
  const fd = fs.open('/data')
  for (let i = 0; i < 40; i++) {
    write(fs, fd, page, i * format.blockSize)
    expected.set(page, i * format.blockSize)
    assert.equal(pending(sql), Math.min(i + 1, 32))
  }
  assert.equal(sql.exec<{ n: number }>("SELECT count(*) AS n FROM fs_block WHERE substr(data,1,1)=x'00'").toArray()[0].n, 32)
  assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)

  const rollback = new Error('rollback partial write')
  assert.throws(() => storage.transactionSync(() => {
    write(fs, fd, new Uint8Array(8192).fill(67), 0)
    throw rollback
  }), error => error === rollback)
  assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)
  assert.equal(pending(sql), 32)

  fs = new SqliteFS(sql)
  assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)
  await fs.initialSyncFs()
  assert.equal(pending(sql), 0)
  assert.ok(sql.exec<{ n: number }>('SELECT sum(length(data)) AS n FROM fs_block').toArray()[0].n < expected.length / 10)

  const reopened = fs.open('/data')
  for (let i = 0; i < 16; i++) {
    write(fs, reopened, page, i * page.length)
    expected.set(page, i * page.length)
    assert.deepEqual(fs.readRange('/data', 0, format.blockSize), expected.subarray(0, format.blockSize))
    assert.equal(pending(sql), 1)
    assert.equal(new Uint8Array(sql.exec<{ data: ArrayBuffer }>('SELECT data FROM fs_block WHERE idx=0').toArray()[0].data)[0], 0)
  }
  await fs.syncToFs()
  assert.equal(pending(sql), 0)
  write(fs, reopened, page, 39 * format.blockSize)
  fs.truncate('/data', 1000)
  assert.equal(pending(sql), 0)
  write(fs, reopened, page, 0)
  fs.unlink('/data')
  assert.equal(pending(sql), 0)
  await fs.syncToFs()
  assert.equal(sql.exec('SELECT 1 FROM fs_block').toArray().length, 0)

  fs.writeFile('/gap', Uint8Array.of(128))
  const gapFd = fs.open('/gap')
  write(fs, gapFd, page, 8192)
  const gap = new Uint8Array(16384)
  gap[0] = 128
  gap.set(page, 8192)
  assert.deepEqual(fs.readRange('/gap', 0, gap.length), gap)
  assert.equal(sql.exec<{ kind: string }>('SELECT typeof(data) AS kind FROM fs_block').toArray()[0].kind, 'blob')
  write(fs, gapFd, new Uint8Array(format.blockSize).fill(90), 0)
  assert.equal(pending(sql), 0)
  assert.deepEqual(fs.readRange('/gap', 0, format.blockSize), new Uint8Array(format.blockSize).fill(90))
  SqliteFS.drop(sql)
}

export async function recompressionCrash(storage: DurableObjectStorage, recover: boolean): Promise<void> {
  const fs = new SqliteFS(storage.sql, format)
  if (!recover) {
    fs.importChunk('/pending', 0, new Uint8Array(format.blockSize).fill(65))
    write(fs, fs.open('/pending'), page, 8192)
    assert.equal(pending(storage.sql), 1)
    return
  }
  assert.equal(pending(storage.sql), 1)
  const expected = new Uint8Array(format.blockSize).fill(65)
  expected.set(page, 8192)
  assert.deepEqual(fs.readRange('/pending', 0, expected.length), expected)
  await fs.initialSyncFs()
  assert.equal(pending(storage.sql), 0)
  assert.deepEqual(fs.readRange('/pending', 0, expected.length), expected)
}
