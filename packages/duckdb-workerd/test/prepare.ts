import { packageDuckDB } from '../build.ts'
const here = new URL('../', import.meta.url)
const packaged = await packageDuckDB(new URL('.build/duckdb', here).pathname)
await Deno.writeTextFile(new URL('.build/wrangler.json', here), JSON.stringify({
  name: 'duckdb-workerd-test',
  main: '../test/worker.js',
  compatibility_date: '2026-09-01',
  durable_objects: { bindings: [{ name: 'DISK', class_name: 'DiskFixture' }, { name: 'CRASH', class_name: 'CrashFixture' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['DiskFixture', 'CrashFixture'] }],
  assets: { directory: './duckdb/assets', binding: 'ASSETS', run_worker_first: true },
  rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
}, null, 2))
console.log(JSON.stringify(packaged))
