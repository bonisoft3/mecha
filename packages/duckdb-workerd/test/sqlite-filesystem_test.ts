import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { SqliteFilesystem } from '../src/sqlite-filesystem.js'

function fixture() {
  const database = new DatabaseSync(':memory:')
  const sql = { exec(query: string, ...bindings: (string | number | Uint8Array)[]) {
    const rows = database.prepare(query).all(...bindings)
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
  } }
  const options = { path: '/database.duckdb', temporaryDirectory: '/tmp', maxDatabaseBytes: 200_000, maxTemporaryBytes: 80_000 }
  return { database, sql, options }
}

Deno.test('SQLite blocks preserve sparse writes and truncation across reopen without a data cache', () => {
  const { database, sql, options } = fixture()
  let fs = new SqliteFilesystem(sql, options)
  try {
    sql.exec('INSERT INTO duckdb_file VALUES (?, 0, 0)', options.path)
    const bytes = Uint8Array.from({ length: 90_000 }, (_, i) => i % 251)
    fs.write(options.path, bytes, 60_000)
    const result = new Uint8Array(150_000)
    assert.equal(fs.read(options.path, result, 0), result.length)
    assert.deepEqual(result.subarray(0, 60_000), new Uint8Array(60_000))
    assert.deepEqual(result.subarray(60_000), bytes)
    fs.truncate(options.path, 70_003)
    fs.truncate(options.path, 150_000)
    fs.release()
    fs = new SqliteFilesystem(sql, options)
    fs.read(options.path, result, 0)
    assert.deepEqual(result.subarray(60_000, 70_003), bytes.subarray(0, 10_003))
    assert.deepEqual(result.subarray(70_003), new Uint8Array(79_997))
  } finally { fs.release(); database.close() }
})

Deno.test('database and temporary budgets reject growth before writes and ownership excludes a second runtime', () => {
  const { database, sql, options } = fixture()
  const fs = new SqliteFilesystem(sql, options)
  try {
    assert.throws(() => new SqliteFilesystem(sql, options), /already has an open runtime/)
    sql.exec('INSERT INTO duckdb_file VALUES (?, 0, 0)', options.path)
    sql.exec('INSERT INTO duckdb_file VALUES (?, 0, 0)', '/tmp/spill')
    fs.write(options.path, new Uint8Array(150_000), 0)
    fs.write('/tmp/spill', new Uint8Array(70_000), 0)
    assert.throws(() => fs.write(options.path, new Uint8Array(60_000), 150_000), /database storage budget exceeded/)
    assert.throws(() => fs.truncate('/tmp/spill', 80_001), /temporary storage budget exceeded/)
    assert.equal(fs.node(options.path).size, 150_000)
    assert.equal(fs.node('/tmp/spill').size, 70_000)
    fs.release()
    assert.throws(() => new SqliteFilesystem(sql, { ...options, temporaryDirectory: '/different' }), /format or paths differ/)
    const reopened = new SqliteFilesystem(sql, options)
    assert.equal(reopened.node('/tmp/spill'), undefined)
    assert.equal(reopened.node(options.path).size, 150_000)
    reopened.release()
  } finally { fs.release(); database.close() }
})

Deno.test('NULL_IF_NOT_EXISTS opens an existing WAL so crash recovery can replay it', () => {
  const { database, sql, options } = fixture()
  const fs = new SqliteFilesystem(sql, options)
  try {
    const wal = options.path + '.wal'
    sql.exec('INSERT INTO duckdb_file VALUES (?, 229, 0)', wal)
    let path = wal
    const runtime: { _fileInfoCache: Map<number, unknown>; _files: Map<string, unknown>; getFileInfo: () => { fileName: string }; openFile?: (mod: unknown, id: number, flags: number) => number } = { _fileInfoCache: new Map(), _files: new Map(), getFileInfo: () => ({ fileName: path }) }
    fs.install(runtime)
    const mod = { _malloc: () => 8, HEAPF64: new Float64Array(4) }
    assert.equal(runtime.openFile!(mod, 1, 1 | 128), 8)
    assert.equal(mod.HEAPF64[1], 229)
    path = options.path + '.missing'
    assert.equal(runtime.openFile!(mod, 2, 1 | 128), 0)
  } finally { fs.release(); database.close() }
})
