import assert from 'node:assert/strict'
import { serviceExecutor, type ComputeService } from '../src/compute.ts'

Deno.test('private compute binding carries the retained capture and fences mismatched answers', async () => {
  const snapshot = { id: 'capture', name: 'total', version: 'v1', revision: 2, tables: {} }
  const service: ComputeService = {
    fetch(input, init) {
      assert.equal(input, 'https://compute/execute')
      assert.deepEqual(JSON.parse(String(init!.body)), snapshot)
      return Promise.resolve(Response.json({ ...snapshot, sinks: { total: [{ id: 'one', value: '9007199254740993' }] } }))
    },
  }
  assert.deepEqual(await serviceExecutor(service)(snapshot), { total: [{ id: 'one', value: '9007199254740993' }] })
  for (const patch of [{ id: 'other' }, { version: 'old' }, { revision: 1 }, { name: 'other' }]) {
    service.fetch = () => Promise.resolve(Response.json({ ...snapshot, ...patch, sinks: {} }))
    await assert.rejects(() => serviceExecutor(service)(snapshot), /different capture/)
  }
  service.fetch = () => Promise.resolve(new Response('query worker rejected version', { status: 500 }))
  await assert.rejects(() => serviceExecutor(service)(snapshot), /query worker rejected version/)
})
