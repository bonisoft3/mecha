import assert from 'node:assert/strict'
import { edgeWorker } from '../src/worker.ts'
import type { EdgeEnv } from '../src/object.ts'

Deno.test('reset acknowledgement leaves the object before the Worker restarts it', async () => {
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { default: { put: async () => {}, delete: async () => true } },
  })
  let body!: ReadableStreamDefaultController<Uint8Array>
  let drained = false
  let restarted = false
  const env = {
    JWT_SECRET: 'test-secret',
    IMPORT_TOKEN: 'import-secret',
    CF_VERSION_METADATA: { id: 'v1' },
    CLUSTER: {
      idFromName: () => 'cluster',
      get: () => ({
        fetch(req: Request) {
          if (new URL(req.url).pathname === '/import/restart') {
            restarted = true
            if (!drained) body.error(new Error('object ended before acknowledgement was read'))
            return Promise.reject(new Error('asked by the Worker'))
          }
          return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(controller) { body = controller },
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('{"reset":true}'))
              controller.close()
              drained = true
            },
          }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json', 'x-import': 'reset' } }))
        },
      }),
    },
  } as unknown as EdgeEnv
  try {
    const response = await edgeWorker.fetch(new Request('https://app.example/import/reset', {
      method: 'POST', headers: { authorization: 'Bearer import-secret' },
    }), env, {} as ExecutionContext)
    assert.equal(restarted, true)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-import'), 'reset')
    assert.deepEqual(await response.json(), { reset: true })
  } finally {
    if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches)
    else delete (globalThis as { caches?: unknown }).caches
  }
})
