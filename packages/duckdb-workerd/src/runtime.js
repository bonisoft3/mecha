import * as duckdb from './duckdb.mjs'
import wasm from './duckdb.wasm'
import { installHeapStrings } from './heap-strings.js'
import { SqliteFilesystem } from './sqlite-filesystem.js'

let initialization = Promise.resolve()
let poisonedInitialization

function withRuntime(runtime, operation) {
  const previous = globalThis.DUCKDB_RUNTIME
  globalThis.DUCKDB_RUNTIME = runtime
  try { return operation() } finally { globalThis.DUCKDB_RUNTIME = previous }
}

function methods(target, names, runtime, check = () => {}) {
  return Object.fromEntries(names.map((name) => [name, (...args) => { check(); return withRuntime(runtime, () => target[name](...args)) }]))
}

function connectionFacade(connection, runtime, check, onClose) {
  return Object.freeze({
    ...methods(connection, ['query', 'getTableNames', 'insertArrowTable', 'insertArrowFromIPCStream', 'insertCSVFromPath', 'insertJSONFromPath'], runtime, check),
    close() { check(); withRuntime(runtime, () => connection.close()); onClose() },
    prepare(sql) {
      check()
      const statement = withRuntime(runtime, () => connection.prepare(sql))
      return Object.freeze(methods(statement, ['query', 'close'], runtime, check))
    },
  })
}

/** SQL, file IO and connection lifecycle are synchronous after initialization. */
export function createDuckDB(assets, { storage, path = '/database.duckdb', temporaryDirectory = '/tmp',
  maxDatabaseBytes, maxTemporaryBytes, memoryLimit = storage ? '32MB' : '64MB' } = {}) {
  if (!/^\d+(?:MB|GB)$/.test(memoryLimit)) throw new Error('Invalid DuckDB memory limit')
  if (storage) {
    if (![path, temporaryDirectory].every((value) => /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value)) || path.startsWith(temporaryDirectory + '/') || path === temporaryDirectory) throw new Error('Invalid DuckDB storage paths')
    for (const value of [maxDatabaseBytes, maxTemporaryBytes]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('DuckDB storage budgets must be positive safe integers')
  }
  let engineStarted = false
  let filesystem
  const ready = initialization.then(async () => {
    if (poisonedInitialization) throw poisonedInitialization.error
    const bytes = await Promise.all(['json', 'icu'].map(async (name) => {
      const response = await assets.fetch(`https://assets.invalid/${name}.bin`)
      if (!response.ok) throw new Error(`Missing bundled DuckDB ${name}: ${response.status}`)
      return response.arrayBuffer()
    }))
    duckdb.setExtensions(...bytes)
    const runtime = duckdb.createWorkerdRuntime()
    if (storage) {
      filesystem = new SqliteFilesystem(storage, { path, temporaryDirectory, maxDatabaseBytes, maxTemporaryBytes })
      filesystem.install(runtime)
    }
    const db = await duckdb.createDuckDB(
      { mvp: { mainModule: 'unused' }, eh: { mainModule: 'unused' } },
      new duckdb.VoidLogger(), runtime,
    )
    db.instantiateWasm = (imports, success) => {
      const instance = new WebAssembly.Instance(wasm, imports)
      success(instance, wasm)
      return instance.exports
    }
    let configure
    const previous = globalThis.DUCKDB_RUNTIME
    globalThis.DUCKDB_RUNTIME = runtime
    try {
      engineStarted = true
      await db.instantiate()
      installHeapStrings(db.mod)
      configure = () => {
        if (storage) db.open({ path, accessMode: 3, maximumThreads: 1, useDirectIO: true })
        const connection = db.connect()
        try {
          connection.query(`LOAD '/json.duckdb_extension.wasm'; LOAD '/icu.duckdb_extension.wasm';
          SET autoinstall_known_extensions=false; SET autoload_known_extensions=false;
          ${storage ? `SET temp_directory='${temporaryDirectory}'; SET max_temp_directory_size='${maxTemporaryBytes}B'; SET disabled_optimizers='window_self_join'; SET checkpoint_threshold='1MB';` : ''}
          SET enable_external_access=false; SET preserve_insertion_order=${storage ? 'false' : 'true'};
          SET TimeZone='UTC'; SET memory_limit='${memoryLimit}'; SET threads=1;`)
        } finally { connection.close() }
      }
      configure()
    } finally { globalThis.DUCKDB_RUNTIME = previous }
    let closed = false
    let generation = 0
    const connections = new Set()
    const check = () => { if (closed) throw new Error('DuckDB database is closed') }
    return Object.freeze({
      ...methods(db, ['getVersion', 'getFeatureFlags', 'registerFileBuffer', 'registerFileText', 'dropFile', 'dropFiles', 'flushFiles', 'copyFileToBuffer'], runtime, check),
      connect() {
        check()
        const token = {}
        const current = generation
        const valid = () => { check(); if (current !== generation || !connections.has(token)) throw new Error('DuckDB connection is closed') }
        const connection = withRuntime(runtime, () => db.connect())
        connections.add(token)
        return connectionFacade(connection, runtime, valid, () => connections.delete(token))
      },
      close() {
        check()
        if (connections.size) throw new Error('Close DuckDB connections before closing the database')
        withRuntime(runtime, () => db.open({ path: ':memory:', maximumThreads: 1 }))
        filesystem?.clearTemporary()
        filesystem?.release()
        closed = true
        generation++
      },
      reopen() {
        if (!closed) throw new Error('DuckDB database is already open')
        filesystem?.claim()
        withRuntime(runtime, configure)
        closed = false
      },
      get memoryBytes() { return db.mod.HEAPU8.byteLength },
    })
  })
  // The caller receives every failure; only partial engine initialization prevents subsequent attempts.
  initialization = ready.then(() => undefined, (error) => {
    filesystem?.release()
    if (engineStarted) poisonedInitialization = { error }
  })
  return ready
}
