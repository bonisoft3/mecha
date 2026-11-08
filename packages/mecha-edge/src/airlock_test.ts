import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from '../../mecha-browser/src/database.ts'
import { createEdgeAirlock, type EdgeAirlock, type EdgeEffects } from './airlock.ts'
import { type ClaimedRun, type DispatchedRun, dispatchRun, HANDLER_TIMEOUT_MS, type PerformConfig, runBoundMs } from './dispatch.ts'

const sql = (file: string) => Deno.readTextFile(new URL(`../../../services/${file}`, import.meta.url))

async function ledger(setup: string): Promise<PGlite> {
  const db = await createDatabase({})
  await db.exec(await sql('durex/graphile.sql'))
  await db.exec(`${await sql('ticker/schedule.sql')}\n${await sql('airlock/airlock.sql')}`)
  await db.exec(setup)
  return db
}

function serialized(priorities: string[] = []) {
  let chain = Promise.resolve()
  return <T>(fn: () => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> => {
    priorities.push(priority)
    const next = chain.then(fn, fn)
    chain = next.then(() => {}, () => {})
    return next
  }
}

// The object enqueues; this plays the dispatcher Worker, reaching the object
// through the same two calls its RPC stub makes.
function harness(db: PGlite, effects: EdgeEffects, cfg: PerformConfig = {}, gate?: Promise<void>, lease: { leaseMs?: number; leaseCapMs?: number; handlerTimeoutMs?: number; send?: (run: DispatchedRun) => void } = {}) {
  const queued: DispatchedRun[] = []
  const lines: string[] = []
  const priorities: string[] = []
  let retried = 0
  const airlock: EdgeAirlock = createEdgeAirlock({
    db, serialize: serialized(priorities), effects,
    dispatch: async (run) => {
      await gate
      lease.send?.(run)
      queued.push(run)
    },
    log: (l) => lines.push(l),
    retry: () => { retried++ },
    leaseMs: lease.leaseMs,
    leaseCapMs: lease.leaseCapMs,
    handlerTimeoutMs: lease.handlerTimeoutMs,
  })
  const cluster = { effectClaim: airlock.claim, effectAnswer: airlock.answer }
  const deliver = async () => {
    const runs = queued.splice(0)
    return await Promise.all(runs.map(run => dispatchRun(cluster, effects, run, { log: (l) => lines.push(l), ...cfg })))
  }
  return { airlock, queued, lines, priorities, deliver, retried: () => retried }
}

// A claim's run without the instant its lease ends, which moves with the clock.
const counted = (claimed: ClaimedRun | null) => {
  if (claimed === null) return null
  const { until: _until, ...run } = claimed
  return run
}
const status = async (db: PGlite, table: string, id: string) =>
  (await db.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])).rows[0].status
const entered = async (db: PGlite, key: string) =>
  (await db.query<{ entered: number }>('SELECT entered FROM airlock.external_effect_ledger WHERE key = $1', [key])).rows[0].entered
const job = async (db: PGlite, key: string) =>
  (await db.query<{ attempts: number; later: boolean }>(`SELECT attempts, run_at > now() AS later FROM graphile_worker._private_jobs WHERE key = $1`, [key])).rows[0]

const draft = (attempts: number, issue: EdgeEffects[string]['issue'], extra: Partial<EdgeEffects[string]['declaration']> = {}): EdgeEffects[string] => ({
  declaration: {
    table: 'generation_draft', field: 'status', state: 'drafting', onDone: 'done', onError: 'failed',
    row: ['id'], key: ['id'], idempotent: true, attempts, handler: 'effects/draft.js', ...extra,
  },
  target: { kind: 'tsbifrost' },
  issue,
})
const ONE_DRAFT = `
  CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
  INSERT INTO generation_draft (id) VALUES ('d1');
  INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('e:d1', 'e', '{"id":"d1"}', '{}');
  SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'e:d1'), job_key => 'e:d1');
`

Deno.test('the object hands each run to the dispatcher and settles its answer: Workers AI through tsbifrost', async () => {
  const db = await ledger(`
    CREATE TABLE generation_draft (id text PRIMARY KEY, topic text NOT NULL, status text NOT NULL DEFAULT 'idle', category text NOT NULL DEFAULT '');
    INSERT INTO generation_draft (id, topic, status) VALUES ('draft-cheap', 'animais', 'drafting'), ('draft-heavy', 'animais', 'illustrating');
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES
      ('smollm3-draft:draft-cheap', 'smollm3-draft', '{"id":"draft-cheap"}', '{"topic":"animais"}'),
      ('sdcpp-illustrate:draft-heavy', 'sdcpp-illustrate', '{"id":"draft-heavy"}', '{}');
    SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:draft-cheap'), job_key => 'smollm3-draft:draft-cheap');
    SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'sdcpp-illustrate:draft-heavy'), job_key => 'sdcpp-illustrate:draft-heavy');
  `)
  try {
    const aiCalls: string[] = []
    const effects: EdgeEffects = {
      'smollm3-draft': {
        ...draft(3, async (input, sink) => {
          const res = await sink.fetch('/v1/chat/completions', { method: 'POST', body: { tier: 'cheap', messages: [{ role: 'user', content: `Topic: ${(input as { topic: string }).topic}` }] } })
          return { done: { cards_json: (res.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content } }
        }),
      },
      'sdcpp-illustrate': {
        ...draft(3, async (_input, sink) => {
          const res = await sink.fetch('/v1/images/generations', { method: 'POST', body: { tier: 'heavy', prompt: 'Jaguar in white background', size: '1024x1024', steps: 4 } })
          return { done: { image_url: `data:image/png;base64,${(res.body as { data: Array<{ b64_json: string }> }).data[0].b64_json}` } }
        }, { state: 'illustrating' }),
      },
    }
    const ai = {
      async run(model: string, input: Record<string, unknown>) {
        aiCalls.push(model)
        return 'messages' in input ? { response: '[{"word":"Onça"}]' } : new Uint8Array([137, 80, 78, 71])
      },
    }
    const { airlock, queued, deliver } = harness(db, effects, { env: { AI: ai } })
    // The drain returns with both runs enqueued and nothing called: the object
    // never waits on an effect's network.
    assert.equal(await airlock.drain(), 0)
    assert.deepEqual(queued.map(r => r.key).sort(), ['sdcpp-illustrate:draft-heavy', 'smollm3-draft:draft-cheap'])
    assert.deepEqual(aiCalls, [])
    assert.equal(await entered(db, 'smollm3-draft:draft-cheap'), 0, 'a sent run is counted only when claimed')
    assert.deepEqual(await job(db, 'smollm3-draft:draft-cheap'), { attempts: 0, later: true })
    assert.equal(typeof airlock.retryAt(), 'number')
    assert.deepEqual((await deliver()).sort(), ['answered', 'answered'])
    assert.deepEqual(aiCalls.sort(), ['@cf/google/gemma-4-26b-a4b-it', '@cf/leonardo/phoenix-1.0'])
    assert.deepEqual((await db.query(`SELECT id, status FROM generation_draft ORDER BY id`)).rows, [
      { id: 'draft-cheap', status: 'done' }, { id: 'draft-heavy', status: 'done' },
    ])
    // A settled key leaves no lease to run out.
    assert.equal((await db.query(`SELECT 1 FROM graphile_worker._private_jobs`)).rows.length, 0)
  } finally {
    await db.close()
  }
})

Deno.test('a run\'s error schedules the next run after a backoff, which the drain dispatches', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    let calls = 0
    const { airlock, queued, deliver, lines } = harness(db, { e: draft(2, () => ++calls === 1 ? { retry: 'temporary upstream 503' } : { done: { ok: true } }) })
    await airlock.drain()
    await deliver()
    assert.ok(lines.some(l => l.includes('run 1 failed') && l.includes('temporary upstream 503')), JSON.stringify(lines))
    assert.deepEqual(await job(db, 'e:d1'), { attempts: 0, later: true })
    assert.equal(await status(db, 'generation_draft', 'd1'), 'drafting')
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    await airlock.drain()
    assert.deepEqual(queued.map(r => r.key), ['e:d1'])
    await deliver()
    assert.equal(await entered(db, 'e:d1'), 2)
    assert.equal(await status(db, 'generation_draft', 'd1'), 'done')
  } finally {
    await db.close()
  }
})

// A Workers AI call that never answered held its key while the object lived;
// now the dispatcher bounds the run and answers its timeout as the run's error.
Deno.test('a run that gives no answer is bounded in the dispatcher and answered as an error', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, deliver, lines } = harness(db, { e: draft(3, () => new Promise(() => {})) }, { handlerTimeoutMs: 20 })
    await airlock.drain()
    await deliver()
    assert.ok(lines.some((l) => l.includes('gave no answer in 20ms')), JSON.stringify(lines))
    assert.deepEqual(await job(db, 'e:d1'), { attempts: 0, later: true })
  } finally {
    await db.close()
  }
})

Deno.test('the error of an effect\'s last run settles unknown, with no lease left behind', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, deliver } = harness(db, { e: draft(1, () => { throw new Error('upstream down') }) })
    await airlock.drain()
    await deliver()
    const { rows: [l] } = await db.query<{ kind: string }>(`SELECT outcome->>'kind' AS kind FROM airlock.external_effect_ledger WHERE key = 'e:d1'`)
    assert.equal(l.kind, 'unknown')
    assert.equal(await status(db, 'generation_draft', 'd1'), 'failed')
    assert.equal(await job(db, 'e:d1'), undefined)
  } finally {
    await db.close()
  }
})

// At-least-once delivery, the ledger as the truth: an answer delivered again
// finds the outcome recorded, a superseded run's claim and error change
// nothing, and a superseded run's late outcome settles the key once.
Deno.test('a lease that runs out dispatches the next run, and late or repeated answers settle once', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(5, () => ({ done: {} })) })
    await airlock.drain()
    const [first] = queued.splice(0)
    assert.deepEqual(counted(await airlock.claim('e:d1', first.token, crypto.randomUUID())), { effect: 'e', input: {}, entered: 1 })
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    await airlock.drain()
    const [second] = queued.splice(0)
    assert.notEqual(second.token, first.token)
    assert.equal(await airlock.claim('e:d1', first.token, crypto.randomUUID()), null, 'the first run is superseded')
    assert.deepEqual(counted(await airlock.claim('e:d1', second.token, crypto.randomUUID())), { effect: 'e', input: {}, entered: 2 })
    await airlock.answer('e:d1', 1, { error: 'a late error of the first run' })
    assert.deepEqual(await job(db, 'e:d1'), { attempts: 0, later: true }, 'a superseded error reschedules nothing')
    const done = { target: 'done', kind: 'done' as const, data: { from: 'first' }, reconciled: false }
    await airlock.answer('e:d1', 1, { outcome: done })
    await airlock.answer('e:d1', 2, { outcome: { ...done, data: { from: 'second' } } })
    await airlock.answer('e:d1', 1, { outcome: done })
    const { rows: [l] } = await db.query<{ data: unknown }>(`SELECT outcome->'data' AS data FROM airlock.external_effect_ledger WHERE key = 'e:d1'`)
    assert.deepEqual(l.data, { from: 'first' })
    assert.equal(await status(db, 'generation_draft', 'd1'), 'done')
    assert.equal(await job(db, 'e:d1'), undefined)
    assert.equal(await airlock.claim('e:d1', second.token, crypto.randomUUID()), null, 'a settled key is claimed by no run')
  } finally {
    await db.close()
  }
})

Deno.test('a run the reentry policy settles unknown is settled in the object without dispatch', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} }), { idempotent: false, reentry: 'unknown' }) })
    await airlock.drain()
    // The first run was claimed, so it may have reached the sink; it never answered.
    assert.ok(await airlock.claim('e:d1', queued.splice(0)[0].token, crypto.randomUUID()))
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    assert.equal(await airlock.drain(), 1)
    assert.deepEqual(queued, [])
    assert.equal(await status(db, 'generation_draft', 'd1'), 'failed')
  } finally {
    await db.close()
  }
})

// A job the queue gave up on settles as the container airlock settles it: unknown,
// the queue's last error as its data, and the row moved out of its invoking state.
Deno.test('a job Graphile gave up on settles unknown without dispatch', async () => {
  const db = await ledger(`
    CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
    INSERT INTO generation_draft (id) VALUES ('d1');
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('e:d1', 'e', '{"id":"d1"}', '{}');
    SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'e:d1'), job_key => 'e:d1', max_attempts => 1);
    UPDATE graphile_worker._private_jobs SET attempts = 1, last_error = 'the database went away' WHERE key = 'e:d1';
  `)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => { throw new Error('a job past its attempts is never run') }) })
    assert.equal(await airlock.drain(), 1)
    assert.deepEqual(queued, [])
    const { rows: [l] } = await db.query<{ outcome: { kind: string; data: { dead: string } } }>(`SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'e:d1'`)
    assert.deepEqual([l.outcome.kind, l.outcome.data.dead], ['unknown', 'the database went away'])
    assert.equal(await status(db, 'generation_draft', 'd1'), 'failed')
  } finally {
    await db.close()
  }
})

// A job a drain or a settle enqueued, with no write after it, waited for the
// next write or the hourly cron: the object drains on Graphile's own insert
// notice instead, and every insert asks for a drain, a deck's fan-out twenty
// at once, so the asks share one pass.
Deno.test('Graphile announces each insert on "jobs:insert", and drains asked for during a pass share it', async () => {
  const db = await ledger('')
  try {
    const heard: string[] = []
    await db.listen('"jobs:insert"', () => heard.push('insert'))
    await db.exec(`
      CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
      INSERT INTO generation_draft (id) VALUES ('d1'), ('d2');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('e:d1', 'e', '{"id":"d1"}', '{}'), ('e:d2', 'e', '{"id":"d2"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'e:d1'), job_key => 'e:d1');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'e:d2'), job_key => 'e:d2');
    `)
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(heard, ['insert', 'insert'])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { airlock, queued, deliver } = harness(db, { e: draft(3, () => ({ done: {} })) }, {}, gate)
    const first = airlock.drain()
    const asked = [airlock.drain(), airlock.drain()]
    assert.ok(asked.every((p) => p === first))
    release()
    await first
    assert.equal(queued.length, 2)
    await deliver()
    assert.deepEqual((await db.query<{ status: string }>(`SELECT status FROM generation_draft ORDER BY id`)).rows.map((r) => r.status), ['done', 'done'])
  } finally {
    await db.close()
  }
})

// A level's pictures settled inline as data URLs: the ledger and the row each
// held every one, and the database, held in the object's memory, outgrew the
// object. The dispatcher stores an answer's bytes in the blob plane and the
// object settles the URL the plane serves them at.
Deno.test('an answer\'s bytes go to the blob plane, and the ledger and the row hold their URL', async () => {
  const db = await ledger(`
    CREATE TABLE card (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drawing');
    INSERT INTO card (id) VALUES ('c1');
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('draw:c1', 'draw', '{"id":"c1"}', '{}');
    SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'draw:c1'), job_key => 'draw:c1');
  `)
  try {
    const objects = new Map<string, Uint8Array>()
    const effects: EdgeEffects = {
      draw: {
        ...draft(3, () => ({ done: { image: { $blob: { base64: btoa('jpeg bytes'), type: 'image/jpeg' } } } }), { table: 'card', state: 'drawing', onDone: 'drawn' }),
      },
    }
    const { airlock, deliver } = harness(db, effects, {
      blobs: { put: (key, bytes) => Promise.resolve(void objects.set(key, bytes)), url: (key) => `/img/insecure/plain/s3://bucket/${key}` },
    })
    await airlock.drain()
    await deliver()
    const { rows: [l] } = await db.query<{ outcome: { data: { image: string } } }>(`SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'draw:c1'`)
    const url = l.outcome.data.image
    assert.match(url, /^\/img\/insecure\/plain\/s3:\/\/bucket\/effects\/[0-9a-f]{64}\.jpg$/)
    assert.equal(new TextDecoder().decode(objects.get(url.slice('/img/insecure/plain/s3://bucket/'.length))!), 'jpeg bytes')
    assert.equal(await status(db, 'card', 'c1'), 'drawn')
  } finally {
    await db.close()
  }
})

// A bridge is a container the edge does not run: its effect settles failed at
// once, saying which bridge is not deployed here, and nothing is dispatched.
Deno.test('a bridge not deployed on cloudflare settles onError without dispatch', async () => {
  const db = await ledger(`
    CREATE TABLE sofa_request (id text PRIMARY KEY, status text NOT NULL DEFAULT 'acquiring');
    INSERT INTO sofa_request (id) VALUES ('r1');
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('acquire:r1', 'acquire', '{"id":"r1"}', '{}');
    SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'acquire:r1'), job_key => 'acquire:r1');
  `)
  try {
    const effects: EdgeEffects = {
      acquire: {
        declaration: {
          table: 'sofa_request', field: 'status', state: 'acquiring', onDone: 'applied', onError: 'failed',
          row: ['id'], key: ['id'], idempotent: false, reentry: 'repeat', attempts: 5, handler: 'effects/acquire.js',
          bridge: { name: 'sofascore', targets: [], simulated: true },
        },
        target: { kind: 'bridge', bridge: 'sofascore' },
        issue: () => { throw new Error('never issued') },
      },
    }
    const { airlock, queued } = harness(db, effects)
    assert.equal(await airlock.drain(), 1)
    assert.deepEqual(queued, [])
    const { rows: [row] } = await db.query<{ status: string; entered: number; kind: string; data: unknown }>(
      `SELECT r.status, l.entered, l.outcome->>'kind' AS kind, l.outcome->'data' AS data
         FROM sofa_request r JOIN airlock.external_effect_ledger l ON l.key = 'acquire:' || r.id WHERE r.id = 'r1'`,
    )
    assert.deepEqual(row, { status: 'failed', entered: 0, kind: 'failed', data: { bridge: 'sofascore', target: 'cloudflare', reason: 'not deployed' } })
  } finally {
    await db.close()
  }
})

// A bridge on cloudflare is the dispatcher's own container: the object counts
// and sends its run like any sink's, and the dispatcher's answer settles it.
const SOFA_REQUEST = `
  CREATE TABLE sofa_request (id text PRIMARY KEY, status text NOT NULL DEFAULT 'acquiring');
  INSERT INTO sofa_request (id) VALUES ('r1');
  INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('acquire:r1', 'acquire', '{"id":"r1"}', '{}');
  SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'acquire:r1'), job_key => 'acquire:r1');
`
const acquire = (attempts: number, issue: EdgeEffects[string]['issue']): EdgeEffects => ({
  acquire: {
    declaration: {
      table: 'sofa_request', field: 'status', state: 'acquiring', onDone: 'applied', onError: 'failed',
      row: ['id'], key: ['id'], idempotent: false, reentry: 'repeat', attempts, handler: 'effects/acquire.js',
      bridge: { name: 'sofascore', targets: ['cloudflare'], simulated: true },
    },
    target: { kind: 'container', bridge: 'sofascore', binding: 'BRIDGE_SOFASCORE' },
    issue,
  },
})
/** A container binding whose one stub answers every call as told. */
const stub = (answer: () => Promise<Response>, asked: string[] = []) => ({
  getByName: (name: string) => ({ fetch: (request: Request) => { asked.push(`${name} ${request.method} ${request.url}`); return answer() } }),
})
const judge: EdgeEffects[string]['issue'] = async (_input, sink) => {
  const res = await sink.fetch('/acquire', { method: 'POST', body: { path: '/x' } })
  return res.status === 200 ? { done: res.body } : { failed: { status: res.status } }
}

Deno.test('a bridge deployed on cloudflare as a container is dispatched', async () => {
  const db = await ledger(SOFA_REQUEST)
  try {
    const asked: string[] = []
    const { airlock, queued, deliver } = harness(db, acquire(5, judge), { env: { BRIDGE_SOFASCORE: stub(() => Promise.resolve(new Response('{"accepted":true}', { status: 200 })), asked) } })
    await airlock.drain()
    assert.equal(queued.length, 1)
    assert.equal(await status(db, 'sofa_request', 'r1'), 'acquiring')
    await deliver()
    assert.deepEqual(asked, ['sofascore POST http://sofascore/acquire'])
    assert.equal(await status(db, 'sofa_request', 'r1'), 'applied')
    assert.equal(await entered(db, 'acquire:r1'), 1)
  } finally {
    await db.close()
  }
})

// @cloudflare/containers answered a first deploy's provisioning as a 503 the
// handler judged, so the effect settled failed on its first run; the stub
// (bridge.ts) now rejects what the infrastructure fails at, and the object
// treats it as an origin's transport error: counted, backed off, run again,
// unknown when the attempts run out.
Deno.test("a container the infrastructure cannot provide is the run's error, retried and unknown at the last attempt", async () => {
  const db = await ledger(SOFA_REQUEST)
  try {
    let calls = 0
    const provisioning = stub(() => { calls++; return Promise.reject(new Error('there is no container instance that can be provided to this durable object')) })
    const { airlock, deliver, lines } = harness(db, acquire(2, judge), { env: { BRIDGE_SOFASCORE: provisioning } })
    await airlock.drain()
    await deliver()
    assert.equal(calls, 1)
    assert.ok(lines.some(l => l.includes('run 1 failed') && l.includes('no container instance that can be provided')), JSON.stringify(lines))
    assert.deepEqual(await job(db, 'acquire:r1'), { attempts: 0, later: true })
    assert.equal(await status(db, 'sofa_request', 'r1'), 'acquiring')
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'acquire:r1'`)
    await airlock.drain()
    await deliver()
    assert.equal(calls, 2)
    const { rows: [l] } = await db.query<{ kind: string; entered: number }>(`SELECT outcome->>'kind' AS kind, entered FROM airlock.external_effect_ledger WHERE key = 'acquire:r1'`)
    assert.deepEqual(l, { kind: 'unknown', entered: 2 })
    assert.equal(await status(db, 'sofa_request', 'r1'), 'failed')
    assert.equal(await job(db, 'acquire:r1'), undefined)
  } finally {
    await db.close()
  }
})

// What the container itself answers is the sink's answer, for the handler to
// judge as it judges any sink's.
Deno.test("a container's own 500 is the handler's to judge", async () => {
  const db = await ledger(SOFA_REQUEST)
  try {
    const { airlock, deliver } = harness(db, acquire(5, judge), { env: { BRIDGE_SOFASCORE: stub(() => Promise.resolve(new Response('no such page', { status: 500 }))) } })
    await airlock.drain()
    await deliver()
    const { rows: [l] } = await db.query<{ kind: string; data: unknown; entered: number }>(`SELECT outcome->>'kind' AS kind, outcome->'data' AS data, entered FROM airlock.external_effect_ledger WHERE key = 'acquire:r1'`)
    assert.deepEqual(l, { kind: 'failed', data: { status: 500 }, entered: 1 })
    assert.equal(await status(db, 'sofa_request', 'r1'), 'failed')
    assert.equal(await job(db, 'acquire:r1'), undefined)
  } finally {
    await db.close()
  }
})

const secondsLeft = async (db: PGlite, key: string) =>
  (await db.query<{ s: number }>(`SELECT extract(epoch FROM run_at - now())::float AS s FROM graphile_worker._private_jobs WHERE key = $1`, [key])).rows[0].s

// The lease used to run out at the handler's bound and a minute from the
// send, while a claimed run could still be reconciling, issuing and storing
// bytes: the next run was dispatched over it, and a non-idempotent call was
// made twice.
Deno.test('a claim leases its run for as long as the run can still call its sink', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} })) }, {}, undefined, { leaseMs: 1_000, handlerTimeoutMs: 10_000 })
    await airlock.drain()
    assert.equal(queued.length, 1)
    assert.ok(await secondsLeft(db, 'e:d1') <= 1, 'unclaimed, the run holds the key for its delivery')
    assert.deepEqual(counted(await airlock.claim('e:d1', queued[0].token, crypto.randomUUID())), { effect: 'e', input: {}, entered: 1 })
    assert.ok(await secondsLeft(db, 'e:d1') > 60, 'claimed, it holds the key for its own bound')
    assert.equal(runBoundMs(draft(3, () => ({ done: {} })).declaration, 1), 2 * HANDLER_TIMEOUT_MS, 'issue and storing')
    assert.equal(runBoundMs(draft(3, () => ({ done: {} }), { idempotent: false, reentry: 'reconcile' }).declaration, 2), 3 * HANDLER_TIMEOUT_MS, 'reconcile, issue and storing')
  } finally {
    await db.close()
  }
})

// A lease that fires while its run is being claimed is a job Graphile already
// holds: the claim's renewal takes the key from it, and that job, running on,
// would have counted and sent a second run beside the claimed one.
Deno.test('a lease that fired while its run was claimed sends no second run', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} })) })
    await airlock.drain()
    assert.ok(await airlock.claim('e:d1', queued.splice(0)[0].token, crypto.randomUUID()))
    // The fired lease, as Graphile leaves it once a renewal took its key.
    await db.query(`SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'e:d1'))`)
    await airlock.drain()
    assert.equal(queued.length, 0)
    assert.equal(await entered(db, 'e:d1'), 1)
  } finally {
    await db.close()
  }
})

// A run used to be counted as it was sent, inside a transaction held across
// the queue's round-trip: the object's database waited on the network, and a
// send that never arrived spent an attempt. Now the lease is committed first
// and the run counted when claimed, so a lost send costs only a resend.
Deno.test('a send that fails counts no run, and its lease sends it again under a new token', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    let refuse = true
    const { airlock, queued } = harness(db, { e: draft(1, () => ({ done: {} })) }, {}, undefined, {
      send: () => { if (refuse) { refuse = false; throw new Error('the queue refused the send') } },
    })
    await airlock.drain()
    assert.equal(queued.length, 0)
    assert.equal(await entered(db, 'e:d1'), 0)
    assert.deepEqual(await job(db, 'e:d1'), { attempts: 0, later: true }, 'the committed lease holds the key')
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    await airlock.drain()
    assert.equal(queued.length, 1)
    assert.deepEqual(counted(await airlock.claim('e:d1', queued[0].token, crypto.randomUUID())), { effect: 'e', input: {}, entered: 1 }, 'a one-attempt effect still runs')
  } finally {
    await db.close()
  }
})

// An object evicted after the commit and before the send leaves the lease and
// no message: the lease fires and sends one, and nothing was counted.
Deno.test('a commit whose send never happened is sent again by its lease', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} })) })
    await airlock.drain()
    const [lost] = queued.splice(0)
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    await airlock.drain()
    const [resent] = queued.splice(0)
    assert.equal(await airlock.claim('e:d1', lost.token, crypto.randomUUID()), null, 'the lost send names a stale dispatch')
    assert.deepEqual(counted(await airlock.claim('e:d1', resent.token, crypto.randomUUID())), { effect: 'e', input: {}, entered: 1 })
  } finally {
    await db.close()
  }
})

// The queue delivers at least once: the same message twice is one run.
Deno.test('a message delivered twice is claimed once', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} })) })
    await airlock.drain()
    const [run] = queued.splice(0)
    assert.ok(await airlock.claim('e:d1', run.token, crypto.randomUUID()))
    assert.equal(await airlock.claim('e:d1', run.token, crypto.randomUUID()), null)
    assert.equal(await entered(db, 'e:d1'), 1)
  } finally {
    await db.close()
  }
})

// A message sent before a reset names a key the loaded ledger may not hold.
Deno.test("a claim for a key the ledger does not hold is no run's", async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock } = harness(db, { e: draft(3, () => ({ done: {} })) })
    assert.equal(await airlock.claim('gone', '1:0', crypto.randomUUID()), null)
  } finally {
    await db.close()
  }
})

// Claims and answers share the object's one connection with its readers; at
// the default priority a deck's fan-out queued ahead of them.
Deno.test('claims and answers wait behind the online path, and an answer re-arms the clock', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, deliver, priorities, retried } = harness(db, { e: draft(3, () => ({ done: {} })) })
    await airlock.drain()
    const before = retried()
    priorities.splice(0)
    await deliver()
    assert.equal(await status(db, 'generation_draft', 'd1'), 'done')
    assert.ok(priorities.length > 0 && priorities.every((p) => p === 'low'), priorities.join(','))
    // A settle may arm a machine's deadline although no job is due.
    assert.ok(retried() > before, 'the clock is re-read after an answer')
  } finally {
    await db.close()
  }
})

// A transient failure reaching the object used to drop the run's answer: it
// waited out the lease, and an effect settling unknown on its next run was
// settled unknown for nothing.
Deno.test("the dispatcher retries reaching the object on what Cloudflare marks retryable, and on nothing else", async () => {
  const transient = () => Object.assign(new Error('Durable Object reset because its code was updated'), { retryable: true })
  let claims = 0
  const answers: unknown[] = []
  const cluster = {
    effectClaim: async () => {
      if (++claims < 3) throw transient()
      return { effect: 'e', input: {}, entered: 1, until: Infinity }
    },
    effectAnswer: async (_k: string, _n: number, a: unknown) => { answers.push(a) },
  }
  assert.equal(await dispatchRun(cluster, { e: draft(3, () => ({ done: { ok: true } })) }, { key: 'e:d1', token: '1:0' }, { rpcBackoffMs: 1 }), 'answered')
  assert.equal(claims, 3)
  assert.equal(answers.length, 1)
  let refused = 0
  const refusing = { ...cluster, effectClaim: async () => { refused++; throw new Error('the data directory is loading') } }
  await assert.rejects(dispatchRun(refusing, {}, { key: 'e:d1', token: '1:0' }, { rpcBackoffMs: 1 }), /loading/)
  assert.equal(refused, 1)
})

// While a publish deploys the object before its dispatcher, the old
// dispatcher can claim a run for an effect only the new one knows: it threw
// past its answer, and the run waited out its lease.
Deno.test("an effect the dispatcher does not know is answered as the run's error", async () => {
  const answers: unknown[] = []
  const cluster = {
    effectClaim: async () => ({ effect: 'new', input: {}, entered: 1, until: Infinity }),
    effectAnswer: async (_k: string, _n: number, a: unknown) => { answers.push(a) },
  }
  assert.equal(await dispatchRun(cluster, {}, { key: 'e:d1', token: '1:0' }), 'answered')
  assert.match((answers[0] as { error: string }).error, /not in this dispatcher's effects\.json/)
})

// A claim counts its run and renews the lease, which makes its token stale: a
// reply lost on the way back, asked again, found the token stale and dropped
// a counted run, which then settled unknown for an effect with no second try.
Deno.test('a claim asked again by its own claimant, after a lost reply, returns the run it counted', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(1, () => ({ done: {} })) })
    await airlock.drain()
    const [run] = queued.splice(0)
    const claimant = crypto.randomUUID()
    const first = await airlock.claim('e:d1', run.token, claimant)
    const again = await airlock.claim('e:d1', run.token, claimant)
    assert.deepEqual(again, first)
    assert.equal(await entered(db, 'e:d1'), 1, 'counted once')
    assert.equal(await airlock.claim('e:d1', run.token, crypto.randomUUID()), null, 'another delivery of the message claims nothing')
  } finally {
    await db.close()
  }
})

// A row the machine put back into the invoking state for another invocation
// was moved by a late answer for the first: the second's outcome then found
// the row gone from its state and its move was dropped.
Deno.test("a late answer moves only the invocation its key names, never the row's next one", async () => {
  const db = await ledger(`
    CREATE TABLE generation_draft (id text PRIMARY KEY, round int NOT NULL, status text NOT NULL DEFAULT 'drafting');
    INSERT INTO generation_draft (id, round) VALUES ('d1', 2);
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input, outcome) VALUES
      ('e:["d1", "1"]', 'e', '{"id":"d1"}', '{}', '{"target":"done","kind":"done","data":{},"reconciled":false}');
  `)
  try {
    const { airlock } = harness(db, { e: draft(3, () => ({ done: {} }), { key: ['id', 'round'] }) })
    await airlock.answer('e:["d1", "1"]', 1, { outcome: { target: 'done', kind: 'done', data: {}, reconciled: false } })
    assert.equal(await status(db, 'generation_draft', 'd1'), 'drafting', "round 2's invocation keeps its state")
  } finally {
    await db.close()
  }
})

// The lease owns the retry once it is committed: the job that sent it used to
// throw on a failed send and stay behind as a dead job no sweep could see,
// one more each lease for every key the queue refused.
Deno.test('a send the queue refuses leaves no failed job behind, and says so', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, lines } = harness(db, { e: draft(3, () => ({ done: {} })) }, {}, undefined, {
      send: () => { throw new Error('the queue refused the send') },
    })
    await airlock.drain()
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key IS NULL OR attempts > 0`)
    assert.equal(rows[0].n, 0, 'only the lease remains')
    assert.ok(lines.some((l) => l.includes("the dispatcher's queue refused run 1")), JSON.stringify(lines))
  } finally {
    await db.close()
  }
})

// Nothing is counted before a claim, so a queue backlog longer than the
// lease kept a run re-sent behind itself forever: each unclaimed send now
// waits twice as long as the last, up to the cap.
Deno.test('an unclaimed run is sent again after a lease that doubles each time, up to its cap', async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, queued } = harness(db, { e: draft(3, () => ({ done: {} })) }, {}, undefined, { leaseMs: 10_000, leaseCapMs: 30_000 })
    const leases: number[] = []
    for (let send = 0; send < 3; send++) {
      await airlock.drain()
      leases.push(Math.round(await secondsLeft(db, 'e:d1')))
      await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'e:d1'`)
    }
    assert.deepEqual(leases, [10, 20, 30])
    assert.equal(queued.length, 3)
  } finally {
    await db.close()
  }
})

// A wake that found nothing due re-read the clock on every insert's notice;
// it is re-read only when a lease or retry moved, or something settled.
Deno.test("a pass re-reads the clock when what is due moves, and leaves it when nothing did", async () => {
  const db = await ledger(ONE_DRAFT)
  try {
    const { airlock, retried } = harness(db, { e: draft(3, () => ({ done: {} })) })
    await airlock.drain()
    const leased = retried()
    assert.ok(leased > 0, 'the lease moved what is due')
    await airlock.drain()
    assert.equal(retried(), leased, 'a wake that changed nothing leaves the clock')
  } finally {
    await db.close()
  }
})

// An answer the object refused while its directory loaded was dropped: a
// paid call, its bytes already stored, was made again after the lease.
Deno.test('an answer refused while the directory loads is held until the run\'s lease would end, then fails loudly', async () => {
  const loading = () => new Error('the data directory is loading')
  let now = 0
  let refusals = 2
  const answers: unknown[] = []
  const cluster = {
    effectClaim: async () => ({ effect: 'e', input: {}, entered: 1, until: 1_000 }),
    effectAnswer: async (_k: string, _n: number, a: unknown) => {
      now += 100
      if (refusals-- > 0) throw loading()
      answers.push(a)
    },
  }
  assert.equal(await dispatchRun(cluster, { e: draft(3, () => ({ done: { ok: true } })) }, { key: 'e:d1', token: '1:0' }, { rpcBackoffMs: 1, now: () => now }), 'answered')
  assert.equal(answers.length, 1)
  const stuck = { ...cluster, effectAnswer: async () => { now += 400; throw loading() } }
  now = 0
  await assert.rejects(dispatchRun(stuck, { e: draft(3, () => ({ done: {} })) }, { key: 'e:d1', token: '1:0' }, { rpcBackoffMs: 1, now: () => now }), /loading/)
})
