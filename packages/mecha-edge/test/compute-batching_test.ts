import assert from 'node:assert/strict'

Deno.test('coordinator batches durable steps within one shared alarm budget', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'compute-batching-' })
  const sourceUrl = new URL('../src/compute-coordinator.ts', import.meta.url)
  const source = (await Deno.readTextFile(sourceUrl))
    .replace("'cloudflare:workers'", "'./durable.ts'")
    .replace("'../../compute-snapshot/src/index.ts'", JSON.stringify(new URL('../../compute-snapshot/src/index.ts', sourceUrl).href))
    .replaceAll("'./compute.ts'", JSON.stringify(new URL('./compute.ts', sourceUrl).href))
    .replace("'./snapshot-program.ts'", JSON.stringify(new URL('./snapshot-program.ts', sourceUrl).href))
    .replace("'./paged-coordinator.ts'", "'./paged.ts'")
    .replace("'./paged-transport.ts'", JSON.stringify(new URL('./paged-transport.ts', sourceUrl).href))
  await Deno.writeTextFile(`${dir}/coordinator.ts`, source)
  await Deno.writeTextFile(`${dir}/durable.ts`, 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env} }')
  await Deno.writeTextFile(`${dir}/paged.ts`, `
export async function advancePaged(...args){return await globalThis.__batchHarness.advance(...args)}
export async function reclaimPaged(){}
export async function retainedPaged(){return []}
`)
  const { computeCoordinator } = await import(new URL(`file://${dir}/coordinator.ts`).href)
  const originalNow = Date.now
  const capture = { generation: 'generation', identity: { id: 'capture', name: 'copy', version: 'v1', revision: 1 } }
  try {
    for (const scenario of ['mixed', 'budget', 'prepare budget', 'time', 'failure', 'publication check failure', 'direct', 'nonphysical', 'invalid', 'no reader'] as const) {
      let now = 1000, prepare = 0, advance = 0, rejected = 0, published = false, alarm: number | null = null
      const calls: string[] = []
      const chunk = { rows: Array.from({ length: 128 }, (_, i) => ({ id: i, value: 'x'.repeat(1000) })), after: 128, done: false }
      assert.ok(new TextEncoder().encode(JSON.stringify(chunk)).length < 256 * 1024)
      const values = new Map<string, unknown>()
      const storage = {
        get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value) },
        delete: async (key: string | string[]) => { for (const k of typeof key === 'string' ? [key] : key) values.delete(k) },
        list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
        getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value }, deleteAlarm: async () => { alarm = null },
        transaction: async (fn: (tx: unknown) => Promise<void>) => await fn(storage),
      }
      const cluster = {
        computeClaim: async () => capture,
        computePrepare: async () => { prepare++; if (scenario === 'time') now += 10_000; return scenario !== 'prepare budget' && (scenario !== 'budget' || prepare === 3) },
        computePublication: async () => { if (scenario === 'publication check failure') throw new Error('publication unavailable'); return published ? 'published' : 'pending' },
        computeReject: async () => { rejected++ }, computeWakeAt: async () => 90_000,
        computeReaderName: async (value: unknown) => {
          assert.deepEqual(value, capture); calls.push('validate')
          if (scenario === 'invalid') throw new Error('the data directory was replaced')
          return scenario === 'nonphysical' ? null : 'reader'
        },
        computeChunk: async (value: unknown, source: string, after: number) => {
          assert.deepEqual([value, source, after], [capture, 'game', 0]); calls.push('source chunk'); return chunk
        },
      }
      ;(globalThis as any).__batchHarness = { advance: async (db: { computeChunk: (capture: unknown, source: string, after: number) => Promise<unknown> }) => {
        advance++
        if (['direct', 'nonphysical', 'invalid', 'no reader'].includes(scenario)) {
          assert.deepEqual(await db.computeChunk(capture, 'game', 0), chunk)
          if (scenario === 'direct') assert.deepEqual(await db.computeChunk(capture, 'game', 0), chunk)
          published = true; return 'published'
        }
        if (scenario === 'failure' || scenario === 'publication check failure') throw new Error('step failed')
        if (scenario === 'time') now += 10_000
        if (scenario === 'mixed' && advance === 4) { published = true; return 'published' }
        return advance % 2 ? 'query' : 'compute'
      } }
      Date.now = () => now
      const Coordinator = computeCoordinator(undefined, ['copy'], 'owner')
      const readers = { idFromName: (name: string) => { assert.equal(name, 'reader'); return name }, get: () => ({
        chunk: async (value: unknown, source: string, after: number) => {
          assert.deepEqual([value, source, after], [capture, 'game', 0]); calls.push('reader chunk'); return chunk
        },
      }) }
      const coordinator = new Coordinator({ storage }, { CLUSTER: { idFromName: () => 'cluster', get: () => cluster }, COMPUTE: {}, ...(scenario === 'no reader' ? {} : { COMPUTE_READER: readers }) })
      if (scenario === 'failure' || scenario === 'publication check failure' || scenario === 'invalid' || scenario === 'no reader') await assert.rejects(coordinator.alarm(), scenario === 'invalid' ? /directory was replaced/ : scenario === 'no reader' ? /physical snapshots require COMPUTE_READER/ : scenario === 'failure' ? /step failed/ : /step failed.*publication unavailable/)
      else await coordinator.alarm()
      if (scenario === 'direct') assert.deepEqual(calls, ['validate', 'reader chunk', 'validate', 'reader chunk'])
      if (scenario === 'nonphysical') assert.deepEqual(calls, ['validate', 'source chunk'])
      if (scenario === 'invalid') { assert.deepEqual(calls, ['validate']); assert.equal(rejected, 1) }
      if (scenario === 'no reader') { assert.deepEqual(calls, ['validate']); assert.equal(rejected, 1) }
      if (scenario === 'mixed') { assert.equal(prepare, 1); assert.equal(advance, 4); assert.equal(alarm, 90_000) }
      if (scenario === 'budget') { assert.equal(prepare, 3); assert.equal(advance, 125); assert.equal(alarm, now) }
      if (scenario === 'prepare budget') { assert.equal(prepare, 128); assert.equal(advance, 0); assert.equal(alarm, now) }
      if (scenario === 'time') { assert.equal(prepare, 1); assert.equal(advance, 1); assert.equal(alarm, now) }
      if (scenario === 'failure') { assert.equal(rejected, 1); assert.equal(alarm, 90_000); assert.ok([...values.keys()].some(key => key.startsWith('failure:'))) }
      if (scenario === 'publication check failure') {
        assert.equal(rejected, 0)
        assert.equal(alarm, 61_000)
        assert.match((values.get('failure') as { error: string }).error, /step failed.*publication unavailable/)
      }
    }
    const oldCapture = { ...capture, identity: { ...capture.identity, id: 'old' } }
    const progress = [{ owner: 'owner', capture, outputs: {} }, { owner: 'older', capture: oldCapture, outputs: {} }]
    const calls: unknown[] = []
    const storage = {
      getAlarm: async () => null, get: async () => undefined,
      list: async ({ prefix }: { prefix: string }) => prefix === 'paged:' ? new Map(progress.map((item, index) => [String(index), item])) : new Map(),
    }
    let fail = false
    const service = { fetch: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push(body)
      if (fail) return new Response('unavailable', { status: 503 })
      return Response.json({ manifest: { tables: { note: { rows: 11 } } }, sources: [{ name: 'note', position: 4 }],
        queries: ['one'], declaredQueries: ['one', 'two'], execution: { revision: 7, done: false, checkpoint: {
          group: 42, form: 17, after: 3, ready: false, empty: null, forms: { secret: 'do-not-return'.repeat(10_000) },
          text: 'do-not-return', [ 'x'.repeat(129) ]: 1, ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`extra${i}`, i])),
        } } })
    } }
    const Coordinator = computeCoordinator(undefined, ['copy'], 'owner')
    const coordinator = new Coordinator({ storage }, { COMPUTE: service })
    const basic = await coordinator.status()
    assert.equal(calls.length, 0)
    assert.equal('details' in basic, false)
    const detailed = await coordinator.status(true)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { capture, action: 'status' })
    assert.deepEqual(detailed.details[0].execution.checkpoint, {
      group: 42, form: 17, after: 3, ready: false, empty: null,
      ...Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`extra${i}`, i])),
    })
    assert.deepEqual({ ...detailed.details[0], execution: { revision: detailed.details[0].execution.revision, done: detailed.details[0].execution.done } },
      { capture, sources: [{ name: 'note', position: 4, total: 11 }], queries: { completed: 1, total: 2 }, execution: { revision: 7, done: false } })
    assert.doesNotMatch(JSON.stringify(detailed), /do-not-return/)
    fail = true
    await assert.rejects(coordinator.status(true), /503: unavailable/)
  } finally {
    Date.now = originalNow
    delete (globalThis as any).__batchHarness
    await Deno.remove(dir, { recursive: true })
  }
})
