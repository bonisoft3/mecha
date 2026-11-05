import assert from 'node:assert/strict'
import { startWorker } from '../wrangler-dev.ts'
import { seed } from './seed.ts'
import { load } from '../load.ts'

Deno.test({ name: 'static pg_ivm maintains transactional aggregates in workerd and after eviction', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'pglite-ivm-' })
  await seed(`${tmp}/empty`, false)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  const call = async (route: string, body: string) => {
    const res = await fetch(`${worker.origin}/${route}?do=ivm&codec=raw`, { method: 'POST', body })
    const text = await res.text()
    assert.equal(res.status, 200, text.slice(0, 1000))
    return JSON.parse(text)
  }
  try {
    await load(`${tmp}/empty`, (route, init) => fetch(`${worker.origin}/import/${route}${route.includes('?') ? '&' : '?'}do=ivm&codec=raw`, init), { log: () => {} })
    const sql = await Deno.readTextFile(new URL('../../incremental-views/proof.sql', import.meta.url))
    await call('exec', sql)
    assert.deepEqual(await call('sql', JSON.stringify({ sql: "SELECT extversion FROM pg_extension WHERE extname='pg_ivm'" })), [{ extversion: '1.13' }])
    const aborted = await fetch(`${worker.origin}/abort?do=ivm&codec=raw`, { method: 'POST' })
    await aborted.body?.cancel()
    assert.equal(aborted.ok, false)
    await call('exec', "UPDATE ivm_art SET status='drawn' WHERE id='c:2'")
    assert.deepEqual(await call('sql', JSON.stringify({ sql: "SELECT drawn::integer, failed::integer FROM ivm_counts WHERE set_id='other'" })), [{ drawn: 1, failed: 0 }])
  } finally {
    await worker.stop()
  }
})
