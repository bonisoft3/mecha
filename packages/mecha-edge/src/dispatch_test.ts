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

const render = (issue: EdgeEffect['issue']): EdgeEffect => ({
  declaration: {
    table: 'receipt', field: 'status', state: 'rendering', onDone: 'rendered', onError: 'failed',
    row: ['id'], key: ['id'], idempotent: false, reentry: 'repeat', attempts: 3, handler: 'effects/render.js',
    bridge: { name: 'pdf', targets: ['cloudflare'], simulated: false },
  },
  target: { kind: 'isolate', bridge: 'pdf', binding: 'BRIDGE_PDF' },
  issue,
})

// An isolate on cloudflare is a Worker of its own: the sink's call goes to its
// service binding under the bridge's name, with the headers every sink gets;
// what it answers is the sink's answer, and what the binding rejects, as a
// Worker past its limits is, is the run's error.
Deno.test('an isolate target is called through its service binding, as the container it stands for', async () => {
  const seen: Request[] = []
  const answering = (answer: () => Promise<Response>) => ({ fetch: (request: Request) => { seen.push(request); return answer() } })
  const ok = await performEffect(render(judge), { key: 'render:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_PDF: answering(() => Promise.resolve(Response.json({ pages: 1 }))) }, log: () => {} })
  assert.deepEqual(ok, { target: 'rendered', kind: 'done', data: { pages: 1 }, reconciled: false })
  assert.equal(seen[0].url, 'http://pdf/acquire')
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].headers.get('Idempotency-Key'), encodeURIComponent('render:r1'))
  assert.deepEqual(await seen[0].json(), { id: 'r1' })
  const refused = await performEffect(render(judge), { key: 'render:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_PDF: answering(() => Promise.resolve(new Response('bad definition', { status: 400 }))) }, log: () => {} })
  assert.deepEqual(refused, { target: 'failed', kind: 'failed', data: { status: 400, reason: 'bad definition' }, reconciled: false })
  await assert.rejects(
    performEffect(render(judge), { key: 'render:r1', entered: 1 }, { id: 'r1' }, { env: { BRIDGE_PDF: answering(() => Promise.reject(new Error('Worker exceeded memory limit'))) }, log: () => {} }),
    /exceeded memory limit/,
  )
  await assert.rejects(
    performEffect(render(judge), { key: 'render:r1', entered: 1 }, { id: 'r1' }, { env: {}, log: () => {} }),
    /BRIDGE_PDF is not a service binding of this dispatcher/,
  )
})

const quote = (secret: string): EdgeEffect => ({
  declaration: {
    table: 'print_order', field: 'status', state: 'quoting', onDone: 'quoted', onError: 'failed',
    row: ['id'], key: ['id'], idempotent: true, attempts: 5, handler: 'effects/quote.js',
    credential: { header: 'X-API-Key', secret: 'VENDOR_KEY' },
  },
  target: { kind: 'origin', secret },
  issue: async (_input, sink) => ({ done: (await sink.fetch('/v4.0/quotes', { method: 'POST', body: {} })).body }),
})

// Regression: the origin was compiled into the release, so staging and
// production could not reach a vendor's sandbox and its live API from one
// tree. A named origin is this deployment's, read at each run.
Deno.test("an origin named by a secret is this deployment's, read at the run", async () => {
  const asked: string[] = []
  const fetcher = ((url: string) => { asked.push(url); return Promise.resolve(new Response('{"ok":true}')) }) as unknown as typeof fetch
  for (const origin of ['https://api.sandbox.vendor.example', 'https://api.vendor.example']) {
    const got = await performEffect(quote('VENDOR_ORIGIN'), { key: 'quote:o1', entered: 1 }, {}, { env: { VENDOR_ORIGIN: origin, VENDOR_KEY: 'k' }, fetcher, log: () => {} })
    assert.deepEqual(got, { target: 'quoted', kind: 'done', data: { ok: true }, reconciled: false })
  }
  assert.deepEqual(asked, ['https://api.sandbox.vendor.example/v4.0/quotes', 'https://api.vendor.example/v4.0/quotes'])
})

// An unset or malformed origin fails the run before the handler calls
// anywhere, and the value is never echoed: a key set in the wrong secret
// would otherwise land in the log.
Deno.test("an origin secret unset, or no https origin without a path, is the run's error before any call", async () => {
  const fetcher = (() => { throw new Error('called') }) as unknown as typeof fetch
  const run = (env: Record<string, string>) => performEffect(quote('VENDOR_ORIGIN'), { key: 'quote:o1', entered: 1 }, {}, { env: { VENDOR_KEY: 'k', ...env }, fetcher, log: () => {} })
  await assert.rejects(run({}), /origin secret VENDOR_ORIGIN is not set on this deployment/)
  for (const bad of ['http://api.vendor.example', 'https://api.vendor.example/', 'https://api.vendor.example/v4.0', 'sk_live_leaked']) {
    await assert.rejects(run({ VENDOR_ORIGIN: bad }), (e: Error) => /VENDOR_ORIGIN is not an https origin without a path/.test(e.message) && !e.message.includes(bad))
  }
})

const illustrate: EdgeEffect = {
  declaration: {
    table: 'card', field: 'art', state: 'drawing', onDone: 'drawn', onError: 'failed',
    row: ['id'], key: ['id'], idempotent: true, attempts: 5, handler: 'effects/illustrate.js',
  },
  target: { kind: 'tsbifrost' },
  issue: async (_input, sink) => ({ done: (await sink.fetch('/v1/images/generations', { method: 'POST', body: { tier: 'heavy', prompt: 'a paca' } })).body }),
}
const routedAi = {
  image: ['cheap' as const, 'heavy' as const],
  targets: { cloudflare: { image: { heavy: { secret: 'AI_IMAGE_HEAVY', routes: { google: { provider: 'google' as const, model: 'gemini-3.1-flash-lite-image' }, cloudflare: { provider: 'cloudflare' as const, model: '@cf/black-forest-labs/flux-1-schnell' } } } } } },
}

// Regression: level 3 was compiled to Gemini, so staging called Gemini with
// production's key or not at all. Each deployment's setting picks the route
// at the run: staging draws on Workers AI and holds no Gemini key.
Deno.test("a routed AI tier calls the route this deployment's setting names", async () => {
  const drawn: string[] = []
  const AI = { run: (model: string) => (drawn.push(model), Promise.resolve({ image: 'AQID' })) }
  const fetcher = ((url: string) => { drawn.push(url); return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'AQID' } }] } }] }))) }) as unknown as typeof fetch
  await performEffect(illustrate, { key: 'illustrate:c1', entered: 1 }, {}, { ai: routedAi, env: { AI, AI_IMAGE_HEAVY: 'cloudflare' }, fetcher, log: () => {} })
  await performEffect(illustrate, { key: 'illustrate:c1', entered: 1 }, {}, { ai: routedAi, env: { AI, AI_IMAGE_HEAVY: 'google', GEMINI_API_KEY: 'k' }, fetcher, log: () => {} })
  assert.deepEqual(drawn, ['@cf/black-forest-labs/flux-1-schnell', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent'])
})

// A deployment with no setting, one naming no route, or a route whose key it
// does not hold fails the run before the handler calls anything, and never
// echoes the value.
Deno.test("an AI setting unset, undeclared, or selecting an unkeyed route is the run's error before any call", async () => {
  const AI = { run: () => { throw new Error('called') } }
  const fetcher = (() => { throw new Error('called') }) as unknown as typeof fetch
  const run = (env: Record<string, string>) => performEffect(illustrate, { key: 'illustrate:c1', entered: 1 }, {}, { ai: routedAi, env: { AI, ...env }, fetcher, log: () => {} })
  await assert.rejects(run({}), /AI setting AI_IMAGE_HEAVY is not set on this deployment/)
  await assert.rejects(run({ AI_IMAGE_HEAVY: 'AIzaLeaked' }), (e: Error) => /AI_IMAGE_HEAVY is not one of google, cloudflare/.test(e.message) && !e.message.includes('AIzaLeaked'))
  await assert.rejects(run({ AI_IMAGE_HEAVY: 'google' }), /reads GEMINI_API_KEY or GOOGLE_API_KEY, and this deployment holds none/)
})

// Regression: every routed tier was checked before any AI run, so an unkeyed
// level 3 also refused level 2, which calls Workers AI and needs no key.
Deno.test("an unkeyed route refuses only the tier it routes", async () => {
  const drawn: string[] = []
  const AI = { run: (model: string) => (drawn.push(model), Promise.resolve({ image: 'AQID' })) }
  const fetcher = (() => { throw new Error('called') }) as unknown as typeof fetch
  const sketch: EdgeEffect = { ...illustrate, issue: async (_input, sink) => ({ done: (await sink.fetch('/v1/images/generations', { method: 'POST', body: { tier: 'cheap', prompt: 'a paca' } })).body }) }
  const env = { AI, AI_IMAGE_HEAVY: 'google' }
  await performEffect(sketch, { key: 'sketch:c1', entered: 1 }, {}, { ai: routedAi, env, fetcher, log: () => {} })
  assert.equal(drawn.length, 1, 'level 2 ran on Workers AI')
  await assert.rejects(performEffect(illustrate, { key: 'illustrate:c1', entered: 1 }, {}, { ai: routedAi, env, fetcher, log: () => {} }), /reads GEMINI_API_KEY or GOOGLE_API_KEY, and this deployment holds none/)
})
