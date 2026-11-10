import assert from 'node:assert/strict'
import { edgeWorker } from '../src/worker.ts'
import type { EdgeEnv } from '../src/object.ts'
import { signJwt } from '../../../services/auth/jwt.ts'

Deno.test('shape GET retries only explicitly retryable non-overload failures', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  let epochPresent = false
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (req: Request) => epochPresent && req.url.endsWith('/epoch') ? new Response('old') : undefined, put: async () => {},
  } } })
  const retryable = () => Object.assign(new Error('disconnected'), { retryable: true })
  const overloaded = () => Object.assign(new Error('overloaded'), { retryable: true, overloaded: true })
  const ctx = { waitUntil() {} } as unknown as ExecutionContext
  try {
    for (const scenario of ['reset', 'restart', 'reset overloaded', 'unmarked restart', 'success', 'cached', 'exhausted', 'overloaded', 'unmarked', 'http', 'aborted', 'abort delay', 'preaborted', 'post'] as const) {
      epochPresent = scenario === 'cached'
      const calls: number[] = []
      const controller = new AbortController()
      const env = {
        JWT_SECRET: 'secret', IMPORT_TOKEN: 'secret', CF_VERSION_METADATA: { id: 'v1' },
        CLUSTER: { idFromName: () => 'cluster', get: () => {
          const stub = calls.length
          return { fetch: async (req: Request) => {
            calls.push(stub)
            assert.equal(req.method, scenario === 'post' ? 'POST' : 'GET')
            if (scenario === 'http') return new Response('failure', { status: 500 })
            if (scenario === 'post') throw retryable()
            if (scenario === 'overloaded') throw overloaded()
            if (scenario === 'unmarked') throw new Error('other failure')
            if (scenario === 'reset overloaded') throw Object.assign(new Error('reset overloaded'), { durableObjectReset: true, overloaded: true })
            if (scenario === 'unmarked restart') throw new Error('asked by the Worker')
            if (scenario === 'aborted') { controller.abort(); throw retryable() }
            if (scenario === 'abort delay') { setTimeout(() => controller.abort(), 10); throw retryable() }
            if (scenario === 'restart' && calls.length === 1) throw Object.assign(new Error('asked by the Worker'), { durableObjectReset: true })
            if (scenario === 'exhausted' || calls.length === 1) throw retryable()
            return new Response('ok', { status: scenario === 'reset' || scenario === 'restart' || scenario === 'cached' ? 409 : 200, headers: { 'electric-handle': 'table-new' } })
          } }
        } },
      } as unknown as EdgeEnv
      const token = await signJwt('secret', { typ: 'shape', table: 'note', where: 'true', exp: Math.floor(Date.now() / 1000) + 60 })
      if (scenario === 'preaborted') controller.abort()
      const req = new Request(`https://app.example/electric/v1/shape?table=note&where=true${scenario === 'cached' ? '' : '&live=true'}`, {
        method: scenario === 'post' ? 'POST' : 'GET', signal: controller.signal,
        headers: { authorization: `Bearer ${token}` },
      })
      if (scenario === 'reset' || scenario === 'restart' || scenario === 'success' || scenario === 'http' || scenario === 'cached') {
        const result = await edgeWorker.fetch(req, env, ctx)
        assert.equal(result.status, scenario === 'reset' || scenario === 'restart' || scenario === 'cached' ? 409 : scenario === 'http' ? 500 : 200)
        assert.equal(result.headers.get('cache-control'), 'no-store')
      } else await assert.rejects(edgeWorker.fetch(req, env, ctx))
      assert.deepEqual(calls, scenario === 'preaborted' ? [] : scenario === 'exhausted' ? [0, 1, 2] : scenario === 'reset' || scenario === 'restart' || scenario === 'success' || scenario === 'cached' ? [0, 1] : [0])
    }
  } finally {
    if (old) Object.defineProperty(globalThis, 'caches', old)
    else Reflect.deleteProperty(globalThis, 'caches')
  }
})

Deno.test('entity GET retries reset without retrying writes, RPCs or HTTP errors', async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async () => undefined, put: async () => {},
  } } })
  const token = await signJwt('secret', { role: 'app_user', sub: 'user', exp: Math.floor(Date.now() / 1000) + 60 })
  try {
    for (const scenario of ['read', 'guest read', 'post', 'rpc', 'http', 'abort', 'overloaded', 'unmarked'] as const) {
      let calls = 0, stubs = 0
      const controller = new AbortController()
      const session = scenario === 'guest read'
        ? await signJwt('secret', { role: 'app_user', sub: 'user', guest: true, exp: Math.floor(Date.now() / 1000) + 60 })
        : token
      const env = { JWT_SECRET: 'secret', IMPORT_TOKEN: 'secret', CF_VERSION_METADATA: { id: 'v1' }, CLUSTER: {
        idFromName: () => 'cluster', get: () => { stubs++; return { fetch: async () => {
          calls++
          if (scenario === 'http') return new Response('failure', { status: 500 })
          if (scenario === 'abort') { controller.abort(); throw Object.assign(new Error('reset'), { durableObjectReset: true }) }
          if (scenario === 'overloaded') throw Object.assign(new Error('overload'), { durableObjectReset: true, overloaded: true })
          if (scenario === 'unmarked') throw new Error('reset')
          if (calls === 1) throw Object.assign(new Error('reset'), { durableObjectReset: true })
          return Response.json([{ id: 'user' }], { headers: { 'x-mecha-scope': 'private' } })
        } } },
      } } as unknown as EdgeEnv
      const req = new Request(`https://app.example/crud/${scenario === 'rpc' ? 'rpc/function' : 'app_user'}?select=id`, {
        method: scenario === 'post' ? 'POST' : 'GET', signal: controller.signal, headers: { authorization: `Bearer ${session}` },
      })
      const ctx = { waitUntil() {} } as unknown as ExecutionContext
      if (scenario === 'read' || scenario === 'guest read') {
        const res = await edgeWorker.fetch(req, env, ctx)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), [{ id: 'user' }])
        assert.equal(calls, 2)
      } else if (scenario === 'http') {
        assert.equal((await edgeWorker.fetch(req, env, ctx)).status, 500)
        assert.equal(calls, 1)
      } else {
        await assert.rejects(edgeWorker.fetch(req, env, ctx))
        assert.equal(calls, 1)
      }
      assert.equal(stubs, calls)
    }
  } finally {
    if (old) Object.defineProperty(globalThis, 'caches', old)
    else Reflect.deleteProperty(globalThis, 'caches')
  }
})
