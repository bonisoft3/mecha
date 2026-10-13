import assert from 'node:assert/strict'
import { SqliteFS, type StorageFormat } from '../src/sqlite-fs.ts'

export function filesystemCases(sql: SqlStorage): void {
  for (const format of [
    { version: 1, blockSize: 8192, codec: 'raw' },
    { version: 1, blockSize: 8192, codec: 'deflate' },
    { version: 1, blockSize: 131072, codec: 'deflate' },
  ] as StorageFormat[]) {
    SqliteFS.schema(sql)
    SqliteFS.drop(sql)
    let fs = new SqliteFS(sql, format)
    const size = format.blockSize
    let expected = new Uint8Array(size * 3 + 123).fill(65)
    fs.importChunk('/data', 0, expected.subarray(0, 3000))
    fs = new SqliteFS(sql)
    fs.importChunk('/data', 3000, expected.subarray(3000))
    assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)
    if (format.codec === 'deflate') {
      const [{ bytes }] = sql.exec<{ bytes: number }>('SELECT sum(length(data)) AS bytes FROM fs_block').toArray()
      assert.ok(bytes < expected.length / 10)
    }

    const fd = fs.open('/data')
    const patch = crypto.getRandomValues(new Uint8Array(8192))
    fs.write(fd, patch.buffer as unknown as Uint8Array, 0, patch.length, size - 27)
    expected.set(patch, size - 27)
    assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)
    const buffer = new Uint8Array(size + 64).fill(255)
    const read = fs.read(fd, buffer, 11, size, size - 40)
    assert.equal(read, size)
    assert.deepEqual(buffer.subarray(11, 11 + size), expected.subarray(size - 40, size * 2 - 40))
    assert.equal(buffer[10], 255)
    assert.equal(buffer[11 + size], 255)

    fs.truncate('/data', size + 7)
    expected = expected.slice(0, size + 7)
    fs.truncate('/data', size * 2 + 19)
    const grown = new Uint8Array(size * 2 + 19)
    grown.set(expected)
    expected = grown
    assert.deepEqual(fs.readRange('/data', 0, expected.length), expected)
    fs.write(fd, patch.buffer as unknown as Uint8Array, 0, patch.length, size * 5 + 3)
    const sparse = new Uint8Array(size * 5 + 3 + patch.length)
    sparse.set(expected)
    sparse.set(patch, size * 5 + 3)
    fs.close(fd)
    fs = new SqliteFS(sql)
    assert.deepEqual(fs.readRange('/data', 0, sparse.length), sparse)
    fs.rename('/data', '/moved')
    assert.deepEqual(fs.readRange('/moved', 0, sparse.length), sparse)
    fs.writeFile('/moved', patch)
    assert.deepEqual(fs.readRange('/moved', 0, patch.length + size), patch)
    assert.throws(() => new SqliteFS(sql, { ...format, blockSize: size === 8192 ? 131072 : 8192 }), /format differs/)

    if (format.codec === 'raw') {
      sql.exec('DROP TABLE fs_format')
      assert.throws(() => new SqliteFS(sql, { ...format, codec: 'deflate' }), /format differs/)
      assert.deepEqual(new SqliteFS(sql).readRange('/moved', 0, patch.length), patch)
    } else {
      sql.exec("UPDATE fs_block SET data = x'02'")
      assert.throws(() => fs.readRange('/moved', 0, 1), /invalid filesystem block encoding/)
    }
  }
  SqliteFS.drop(sql)
}
