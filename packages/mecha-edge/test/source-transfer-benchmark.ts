import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { packageDuckDB } from '../../duckdb-workerd/build.ts'

// Opt-in local Workerd benchmark; reports wall time without a performance assertion.
await packageDuckDB(new URL('../../duckdb-workerd/.build/duckdb', import.meta.url).pathname)
const state = await Deno.makeTempDir({ prefix: 'source-transfer-workerd-' })
let worker: Awaited<ReturnType<typeof startWorker>> | undefined
const results = []
try {
  worker = await startWorker(new URL('./source-transfer-wrangler.jsonc', import.meta.url), state)
  const origin = worker.origin
  for (const size of [128, 1024]) {
    const post = async (body: unknown, expected = 200) => {
      const response = await fetch(origin + '/' + size, { method: 'POST', body: JSON.stringify(body) })
      const text = await response.text()
      assert.equal(response.status, expected, text)
      return expected === 200 ? JSON.parse(text) : text
    }
    await post({ init: true })
    const identity = { id: 'capture', name: 'probe', version: 'v', revision: 1, table: 'source' }
    const invalid = { ...identity, after: 0, next: 1025, done: false, rows: Array.from({ length: 1025 }, () => ({ value: '1' })) }
    assert.match(await post({ chunk: invalid }, 400), /exceeds limits/)
    assert.match(await post({ chunk: { ...invalid, next: 1, rows: [{ value: 'é'.repeat(131072) }] } }, 400), /exceeds limits/)
    const chunk = (after: number) => ({ ...identity, after, next: after + size, done: after + size === 16384, rows: Array.from({ length: size }, (_, i) => ({ value: String(after + i) })) })
    const start = performance.now()
    for (let after = 0; after < 16384; after += size) await post({ chunk: chunk(after) })
    const ms = performance.now() - start
    const first = chunk(0)
    await post({ chunk: first })
    assert.match(await post({ chunk: { ...first, rows: first.rows.map((r, i) => i ? r : { value: '-1' }) } }, 400), /replay differs/)
    const result = await post({ finish: true })
    assert.deepEqual(result.rows, [{ n: 16384, total: 134209536 }])
    results.push({ size, requests: 16384 / size, ms, ...result })
  }
  console.log(JSON.stringify({ scope: 'local Workerd and native storage-backed DuckDB; 32MiB SQL budget; wall time, not hosted CPU', results }, null, 2))
} finally {
  await worker?.stop()
  await Deno.remove(state, { recursive: true })
}
