import assert from 'node:assert/strict'
import { type EdgeEffect, performEffect } from './dispatch.ts'

const acquire = (issue: EdgeEffect['issue']): EdgeEffect => ({
  declaration: {
    table: 'sofa_request', field: 'status', state: 'acquiring', onDone: 'applied', onError: 'failed',
    row: ['id'], key: ['id'], idempotent: false, reentry: 'repeat', attempts: 5, handler: 'effects/acquire.js',
    bridge: { name: 'sofascore', targets: ['cloudflare'], simulated: true },
  },
  target: { kind: 'container', bridge: 'sofascore', binding: 'BRIDGE_SOFASCORE' },
  issue,
})

/** A binding whose one stub records what it is asked and answers as told. */
function binding(answer: () => Promise<Response>) {
  const seen: { name: string; request: Request }[] = []
  return {
    seen,
    namespace: { getByName: (name: string) => ({ fetch: (request: Request) => { seen.push({ name, request }); return answer() } }) },
  }
}

const judge: EdgeEffect['issue'] = async (input, sink) => {
  const res = await sink.fetch('/acquire', { method: 'POST', body: input })
  return res.status === 200 ? { done: res.body } : { failed: { status: res.status, reason: res.body } }
}

// A bridge on cloudflare is its container's Durable Object: the sink's call
// goes to the binding's stub under the bridge's name, on the port the stub's
// class holds, with the same headers every sink gets, and the stub's answer
// comes back as any sink's.
Deno.test('a container target is called through its binding, as the origin it stands for', async () => {
  const { seen, namespace } = binding(() => Promise.resolve(new Response(JSON.stringify({ accepted: true }), { status: 200 })))
  const got = await performEffect(acquire(judge), { key: 'acquire:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_SOFASCORE: namespace }, log: () => {} })
  assert.deepEqual(got, { target: 'applied', kind: 'done', data: { accepted: true }, reconciled: false })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, 'sofascore')
  assert.equal(seen[0].request.url, 'http://sofascore/acquire')
  assert.equal(seen[0].request.method, 'POST')
  assert.equal(seen[0].request.headers.get('Idempotency-Key'), encodeURIComponent('acquire:r1'))
  assert.deepEqual(await seen[0].request.json(), { id: 'r1' })
})

// What the container itself answers is the sink's refusal for the handler to
// judge; what the stub rejects, as bridge.ts rejects an instance the
// infrastructure could not provide, is the run's error and no outcome.
Deno.test("a container's own 500 is the sink's answer, and the stub's rejection the run's error", async () => {
  const { seen, namespace } = binding(() => Promise.resolve(new Response('no such page', { status: 500 })))
  const got = await performEffect(acquire(judge), { key: 'acquire:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_SOFASCORE: namespace }, log: () => {} })
  assert.deepEqual(got, { target: 'failed', kind: 'failed', data: { status: 500, reason: 'no such page' }, reconciled: false })
  assert.equal(seen.length, 1)
  const provisioning = binding(() => Promise.reject(new Error('there is no container instance that can be provided to this durable object')))
  await assert.rejects(
    performEffect(acquire(judge), { key: 'acquire:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_SOFASCORE: provisioning.namespace }, log: () => {} }),
    /no container instance that can be provided/,
  )
  assert.equal(provisioning.seen.length, 1)
})

Deno.test('a container target whose binding the dispatcher lacks is the run\'s error', async () => {
  await assert.rejects(
    performEffect(acquire(judge), { key: 'acquire:r1', entered: 1 }, { id: 'r1' }, { env: {}, log: () => {} }),
    /BRIDGE_SOFASCORE is not a Durable Object binding of this dispatcher/,
  )
})
