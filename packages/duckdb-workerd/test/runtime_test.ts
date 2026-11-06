import assert from 'node:assert/strict'

const globals = globalThis as typeof globalThis & { DUCKDB_RUNTIME?: unknown; duckdbWorkerdFixture?: unknown }

async function fixtureRuntime(fixture: unknown, label: string) {
  globals.duckdbWorkerdFixture = fixture
  const runtimeSource = await Deno.readTextFile(new URL('../src/runtime.js', import.meta.url))
  const source = runtimeSource.replace("import * as duckdb from './duckdb.mjs'\nimport wasm from './duckdb.wasm'", 'const {duckdb,wasm}=globalThis.duckdbWorkerdFixture')
    .replace("import { installHeapStrings } from './heap-strings.js'", 'const installHeapStrings=()=>{}')
    .replace("import { SqliteFilesystem } from './sqlite-filesystem.js'", 'const SqliteFilesystem=globalThis.duckdbWorkerdFixture.SqliteFilesystem')
  return await import(`data:text/javascript,${encodeURIComponent(source + `\n// ${label}`)}`)
}

Deno.test('initialization is serialized and synchronous calls restore an initializing instance after success or failure', async () => {
  const previous = globals.DUCKDB_RUNTIME
  const marker = {}
  globals.DUCKDB_RUNTIME = marker
  let nextId = 0
  let active = 0
  let maxActive = 0
  const created: number[] = []
  let releaseSecond!: () => void
  let secondStarted!: () => void
  const started = new Promise<void>((resolve) => { secondStarted = resolve })
  const suspended = new Promise<void>((resolve) => { releaseSecond = resolve })
  let assetsReads = 0
  globals.duckdbWorkerdFixture = {
    duckdb: {
      VoidLogger: class {},
      setExtensions() {},
      createWorkerdRuntime: () => ({ id: ++nextId }),
      createDuckDB(_bundles: unknown, _logger: unknown, runtime: { id: number }) {
        created.push(runtime.id)
        const correctRuntime = () => assert.equal(globals.DUCKDB_RUNTIME, runtime)
        const connection = {
          query(sql: string) { correctRuntime(); if (sql === 'fail') throw new Error('query failed'); return runtime.id },
          close: correctRuntime,
          prepare() { correctRuntime(); return { query: connection.query, close: correctRuntime } },
        }
        return {
          async instantiate() {
            correctRuntime()
            maxActive = Math.max(maxActive, ++active)
            if (runtime.id === 2) { secondStarted(); await suspended; correctRuntime() }
            active--
          },
          connect() { correctRuntime(); return connection },
          getVersion() { correctRuntime(); return runtime.id },
          mod: { HEAPU8: new Uint8Array(3) },
        }
      },
    },
    wasm: null,
  }
  const { createDuckDB } = await fixtureRuntime(globals.duckdbWorkerdFixture, 'serialized initialization')
  const assets = { fetch() { assetsReads++; return Promise.resolve(new Response(new Uint8Array(1))) } }
  try {
    const first = await createDuckDB(assets)
    assert.equal(globals.DUCKDB_RUNTIME, marker)
    const connection = first.connect()
    const statement = connection.prepare('select ?')
    const second = createDuckDB(assets)
    await started
    const third = createDuckDB(assets)
    const initializingRuntime = globals.DUCKDB_RUNTIME
    assert.equal(connection.query('select 1'), 1)
    assert.equal(statement.query(42), 1)
    assert.throws(() => statement.query('fail'), /query failed/)
    statement.close()
    connection.close()
    assert.equal(first.getVersion(), 1)
    assert.equal(first.memoryBytes, 3)
    assert.equal(globals.DUCKDB_RUNTIME, initializingRuntime)
    assert.deepEqual(created, [1, 2])
    assert.equal(assetsReads, 4)
    releaseSecond()
    const [b, c] = await Promise.all([second, third])
    assert.equal(b.connect().query('select 2'), 2)
    assert.equal(c.connect().query('select 3'), 3)
    assert.equal(maxActive, 1)
    assert.equal(globals.DUCKDB_RUNTIME, marker)
  } finally {
    releaseSecond()
    globals.DUCKDB_RUNTIME = previous
    delete globals.duckdbWorkerdFixture
  }
})

Deno.test('an asset failure releases queued initialization but a partial engine failure poisons it', async () => {
  const previous = globals.DUCKDB_RUNTIME
  try {
    for (const failureStage of ['assets', 'engine']) {
      let assetReads = 0
      let engineStarts = 0
      const failure = new Error('partial engine initialization')
      const connection = { query() {}, close() {} }
      const fixture = {
        wasm: null,
        duckdb: {
          VoidLogger: class {},
          setExtensions() {},
          createWorkerdRuntime: () => ({}),
          createDuckDB: () => ({
            instantiate() {
              engineStarts++
              if (failureStage === 'engine') throw failure
            },
            connect: () => connection,
            mod: { HEAPU8: new Uint8Array(3) },
          }),
        },
      }
      const { createDuckDB } = await fixtureRuntime(fixture, `failed ${failureStage}`)
      const assets = { fetch() {
        assetReads++
        return Promise.resolve(failureStage === 'assets' && assetReads === 1
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array(1)))
      } }
      const first = createDuckDB(assets)
      const queued = createDuckDB(assets)
      if (failureStage === 'assets') {
        await assert.rejects(() => first, /Missing bundled DuckDB json: 503/)
        const db = await queued
        assert.equal(db.memoryBytes, 3)
        assert.equal(engineStarts, 1)
        assert.equal(assetReads, 4)
      } else {
        await assert.rejects(() => first, (error) => error === failure)
        await assert.rejects(() => queued, (error) => error === failure)
        await assert.rejects(() => createDuckDB(assets), (error) => error === failure)
        assert.equal(engineStarts, 1)
        assert.equal(assetReads, 2)
      }
      assert.equal(globals.DUCKDB_RUNTIME, previous)
    }
  } finally {
    globals.DUCKDB_RUNTIME = previous
    delete globals.duckdbWorkerdFixture
  }
})
