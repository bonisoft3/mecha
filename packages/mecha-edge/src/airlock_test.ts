import assert from 'node:assert/strict'
import { createDatabase } from '../../mecha-browser/src/database.ts'
import { createEdgeAirlock, type EdgeEffects } from './airlock.ts'

Deno.test('createEdgeAirlock drains airlock.external_effect_ledger via Cloudflare Workers AI binding and settles generation_draft', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE generation_draft (
        id text PRIMARY KEY,
        topic text NOT NULL,
        category text NOT NULL,
        locale text NOT NULL,
        region text NOT NULL,
        card_count integer NOT NULL,
        status text NOT NULL DEFAULT 'idle'
      );
      CREATE OR REPLACE FUNCTION trg_generation_draft_status_machine() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        outcome jsonb;
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.status = 'idle' AND NEW.status = 'drafting' THEN
          INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
          VALUES ('smollm3-draft:' || NEW.id, 'smollm3-draft', jsonb_build_object('id', NEW.id), jsonb_build_object('topic', NEW.topic, 'locale', NEW.locale, 'region', NEW.region, 'card_count', NEW.card_count));
          PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || NEW.id), job_key => 'smollm3-draft:' || NEW.id);
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'idle' AND NEW.status = 'illustrating' THEN
          INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
          VALUES ('sdcpp-illustrate:' || NEW.id, 'sdcpp-illustrate', jsonb_build_object('id', NEW.id), jsonb_build_object('topic', NEW.topic, 'locale', NEW.locale, 'region', NEW.region, 'card_count', NEW.card_count));
          PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'sdcpp-illustrate:' || NEW.id), job_key => 'sdcpp-illustrate:' || NEW.id);
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'drafting' AND NEW.status = 'done' THEN
          SELECT l.outcome INTO outcome FROM airlock.external_effect_ledger l WHERE l.key = 'smollm3-draft:' || OLD.id;
          NEW.category := COALESCE(outcome->'data'->>'cards_json', NEW.category);
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'illustrating' AND NEW.status = 'done' THEN
          SELECT l.outcome INTO outcome FROM airlock.external_effect_ledger l WHERE l.key = 'sdcpp-illustrate:' || OLD.id;
          NEW.category := COALESCE(outcome->'data'->>'image_url', NEW.category);
          RETURN NEW;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER trg_generation_draft_status_machine
        BEFORE UPDATE ON generation_draft
        FOR EACH ROW EXECUTE FUNCTION trg_generation_draft_status_machine();

      INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status) VALUES
        ('draft-cheap', 'animais', 'Geral', 'pt-BR', 'Brasil', 2, 'idle'),
        ('draft-heavy', 'animais', 'Geral', 'pt-BR', 'Brasil', 2, 'idle');
    `)

    const aiCalls: Array<{ model: string; input: Record<string, unknown> }> = []
    const effects: EdgeEffects = {
      'smollm3-draft': {
        declaration: {
          table: 'generation_draft',
          field: 'status',
          state: 'drafting',
          onDone: 'done',
          onError: 'failed',
          row: ['id'],
          idempotent: true,
          attempts: 3,
          handler: 'effects/smollm3-draft.js',
        },
        target: { kind: 'tsbifrost' },
        async issue(input, sink) {
          const res = await sink.fetch('/v1/chat/completions', {
            method: 'POST',
            body: {
              tier: 'cheap',
              messages: [{ role: 'user', content: `Topic: ${(input as { topic: string }).topic}` }],
            },
          })
          const content = (res.body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content
          return { done: { cards_json: content } }
        },
      },
      'sdcpp-illustrate': {
        declaration: {
          table: 'generation_draft',
          field: 'status',
          state: 'illustrating',
          onDone: 'done',
          onError: 'failed',
          row: ['id'],
          idempotent: true,
          attempts: 3,
          handler: 'effects/sdcpp-illustrate.js',
        },
        target: { kind: 'tsbifrost' },
        async issue(_input, sink) {
          const res = await sink.fetch('/v1/images/generations', {
            method: 'POST',
            body: {
              tier: 'heavy',
              prompt: 'Jaguar in white background',
              size: '1024x1024',
              steps: 4,
            },
          })
          const b64 = (res.body as { data: Array<{ b64_json: string }> }).data[0].b64_json
          return { done: { image_url: `data:image/png;base64,${b64}` } }
        },
      },
    }

    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }

    const airlock = createEdgeAirlock({
      db,
      serialize,
      effects,
      env: {
        AI: {
          async run(model: string, input: Record<string, unknown>) {
            aiCalls.push({ model, input })
            if ('messages' in input) {
              return { response: '[{"word":"Onça"},{"word":"Arara"}]' }
            }
            return new Uint8Array([137, 80, 78, 71])
          },
        },
      },
    })

    await db.exec(`
      UPDATE generation_draft SET status = 'drafting' WHERE id = 'draft-cheap';
      UPDATE generation_draft SET status = 'illustrating' WHERE id = 'draft-heavy';
    `)

    const settled = await airlock.drain()
    assert.deepEqual(settled, 2)
    assert.deepEqual(aiCalls.map((c) => c.model), [
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/leonardo/phoenix-1.0',
    ])

    const { rows } = await db.query<{ id: string; status: string; category: string }>(
      'SELECT id, status, category FROM generation_draft ORDER BY id',
    )
    assert.deepEqual(rows, [
      { id: 'draft-cheap', status: 'done', category: '[{"word":"Onça"},{"word":"Arara"}]' },
      { id: 'draft-heavy', status: 'done', category: 'data:image/png;base64,iVBORw==' },
    ])
  } finally {
    await db.close()
  }
})

Deno.test('createEdgeAirlock schedules backoff retry when an attempt fails before exhausting attempts', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE generation_draft (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'drafting'
      );
      INSERT INTO generation_draft (id, status) VALUES ('d1', 'drafting');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
      VALUES ('k1', 'flaky-effect', '{"id":"d1"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k1'), job_key => 'k1');
    `)

    let calls = 0
    let retried = 0
    const effects: EdgeEffects = {
      'flaky-effect': {
        declaration: {
          table: 'generation_draft',
          field: 'status',
          state: 'drafting',
          onDone: 'done',
          onError: 'failed',
          row: ['id'],
          idempotent: true,
          attempts: 2,
          handler: 'effects/flaky.js',
        },
        target: { kind: 'tsbifrost' },
        issue() {
          calls++
          if (calls === 1) return { retry: 'temporary upstream 503' }
          return { done: { ok: true } }
        },
      },
    }

    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }

    const airlock = createEdgeAirlock({
      db,
      serialize,
      effects,
      log: () => {},
      retry: () => { retried++ },
    })

    const first = await airlock.drain()
    assert.deepEqual(first, 0)
    assert.deepEqual(retried, 1)
    assert.deepEqual(typeof airlock.retryAt(), 'number')
    // The failure is Graphile's to record and to schedule: the queue's own
    // attempt, error and later run_at, the lock let go.
    const { rows: [job] } = await db.query<{ attempts: number; last_error: string; later: boolean; locked: boolean }>(
      `SELECT attempts, last_error, run_at > now() AS later, locked_at IS NOT NULL AS locked FROM graphile_worker._private_jobs WHERE key = 'k1'`)
    assert.deepEqual({ ...job, last_error: job.last_error.includes('temporary upstream 503') }, { attempts: 1, last_error: true, later: true, locked: false })
    await db.query(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = 'k1'`)
    assert.deepEqual(await airlock.drain(), 1)
    assert.deepEqual((await db.query<{ status: string }>(`SELECT status FROM generation_draft WHERE id = 'd1'`)).rows[0].status, 'done')
    assert.deepEqual((await db.query(`SELECT 1 FROM graphile_worker._private_jobs WHERE key = 'k1'`)).rows.length, 0)
  } finally {
    await db.close()
  }
})


// A Workers AI call that never answered held its key in flight while the object
// lived: every drain skipped it without a word and the deck stayed drafting.
Deno.test('createEdgeAirlock fails an attempt that gives no answer, and retries it', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
      INSERT INTO generation_draft (id, status) VALUES ('d1', 'drafting');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('k1', 'silent-effect', '{"id":"d1"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k1'), job_key => 'k1');
    `)
    let calls = 0
    const effects: EdgeEffects = {
      'silent-effect': {
        declaration: {
          table: 'generation_draft', field: 'status', state: 'drafting', onDone: 'done', onError: 'failed',
          row: ['id'], idempotent: true, attempts: 3, handler: 'effects/silent.js',
        },
        target: { kind: 'tsbifrost' },
        issue() {
          calls++
          return calls === 1 ? new Promise(() => {}) : { done: { ok: true } }
        },
      },
    }
    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }
    const lines: string[] = []
    const airlock = createEdgeAirlock({ db, serialize, effects, log: (l) => lines.push(l), retry: () => {}, handlerTimeoutMs: 20 })
    assert.deepEqual(await airlock.drain(), 0)
    assert.ok(lines.some((l) => l.includes('gave no answer in 20ms')), JSON.stringify(lines))
    assert.equal(typeof airlock.retryAt(), 'number')
  } finally {
    await db.close()
  }
})

// A job the queue gave up on settles as the container airlock settles it: unknown,
// the queue's last error as its data, and the row moved out of its invoking state.
Deno.test('createEdgeAirlock settles a job Graphile gave up on as unknown', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
      INSERT INTO generation_draft (id, status) VALUES ('d1', 'drafting');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('k1', 'dead-effect', '{"id":"d1"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k1'), job_key => 'k1', max_attempts => 1);
      UPDATE graphile_worker._private_jobs SET attempts = 1, last_error = 'the database went away' WHERE key = 'k1';
    `)
    const effects: EdgeEffects = {
      'dead-effect': {
        declaration: {
          table: 'generation_draft', field: 'status', state: 'drafting', onDone: 'done', onError: 'failed',
          row: ['id'], idempotent: true, attempts: 3, handler: 'effects/dead.js',
        },
        target: { kind: 'tsbifrost' },
        issue() { throw new Error('a job past its attempts is never run') },
      },
    }
    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }
    const airlock = createEdgeAirlock({ db, serialize, effects, log: () => {}, retry: () => {} })
    assert.deepEqual(await airlock.drain(), 1)
    const { rows: [l] } = await db.query<{ outcome: { kind: string; data: { dead: string } } }>(`SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'k1'`)
    assert.deepEqual([l.outcome.kind, l.outcome.data.dead], ['unknown', 'the database went away'])
    assert.deepEqual((await db.query<{ status: string }>(`SELECT status FROM generation_draft WHERE id = 'd1'`)).rows[0].status, 'failed')
  } finally {
    await db.close()
  }
})

// A job a drain or a settle enqueued, with no write after it, waited for the
// next write or the hourly cron: the object drains on Graphile's own insert
// notice instead, and every insert asks for a drain, a deck's fan-out twenty
// at once, so the asks share one pass.
Deno.test('Graphile announces each insert on "jobs:insert", and drains asked for during a pass share it', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    const heard: string[] = []
    await db.listen('"jobs:insert"', () => heard.push('insert'))
    await db.exec(`
      CREATE TABLE generation_draft (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drafting');
      INSERT INTO generation_draft (id) VALUES ('d1'), ('d2');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES
        ('k1', 'slow', '{"id":"d1"}', '{}'), ('k2', 'slow', '{"id":"d2"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k1'), job_key => 'k1');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k2'), job_key => 'k2');
    `)
    await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(heard, ['insert', 'insert'])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let runs = 0
    const effects: EdgeEffects = {
      slow: {
        declaration: {
          table: 'generation_draft', field: 'status', state: 'drafting', onDone: 'done', onError: 'failed',
          row: ['id'], idempotent: true, attempts: 3, handler: 'effects/slow.js',
        },
        target: { kind: 'tsbifrost' },
        async issue() {
          runs++
          await gate
          return { done: {} }
        },
      },
    }
    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }
    const airlock = createEdgeAirlock({ db, serialize, effects, log: () => {}, retry: () => {} })
    const first = airlock.drain()
    while (runs < 2) await new Promise((r) => setTimeout(r, 5))
    const asked = [airlock.drain(), airlock.drain()]
    assert.ok(asked.every((p) => p === first))
    release()
    assert.equal(await first, 2)
    assert.equal(runs, 2)
    assert.deepEqual((await db.query<{ status: string }>(`SELECT status FROM generation_draft ORDER BY id`)).rows.map((r) => r.status), ['done', 'done'])
    assert.equal(await airlock.drain(), 0)
  } finally {
    await db.close()
  }
})

// A level's pictures settled inline as data URLs: the ledger and the row each
// held every one, and the database, held in the object's memory, outgrew the
// object. The airlock stores an answer's bytes in the blob plane and settles
// the URL the plane serves them at.
Deno.test('an answer\'s bytes go to the blob plane, and the ledger and the row hold their URL', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/durex/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE card (id text PRIMARY KEY, status text NOT NULL DEFAULT 'drawing', back text NOT NULL DEFAULT '');
      INSERT INTO card (id) VALUES ('c1');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('k1', 'draw', '{"id":"c1"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'k1'), job_key => 'k1');
    `)
    const objects = new Map<string, Uint8Array>()
    const effects: EdgeEffects = {
      draw: {
        declaration: {
          table: 'card', field: 'status', state: 'drawing', onDone: 'drawn', onError: 'failed',
          row: ['id'], idempotent: true, attempts: 3, handler: 'effects/draw.js',
        },
        target: { kind: 'tsbifrost' },
        issue: () => ({ done: { image: { $blob: { base64: btoa('jpeg bytes'), type: 'image/jpeg' } } } }),
      },
    }
    const airlock = createEdgeAirlock({
      db, serialize: (fn) => fn(), effects, log: () => {}, retry: () => {},
      blobs: { put: (key, bytes) => Promise.resolve(void objects.set(key, bytes)), url: (key) => `/img/insecure/plain/s3://bucket/${key}` },
    })
    assert.equal(await airlock.drain(), 1)
    const { rows: [l] } = await db.query<{ outcome: { data: { image: string } } }>(`SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'k1'`)
    const url = l.outcome.data.image
    assert.match(url, /^\/img\/insecure\/plain\/s3:\/\/bucket\/effects\/[0-9a-f]{64}\.jpg$/)
    assert.equal(new TextDecoder().decode(objects.get(url.slice('/img/insecure/plain/s3://bucket/'.length))!), 'jpeg bytes')
    assert.equal((await db.query<{ status: string }>(`SELECT status FROM card WHERE id = 'c1'`)).rows[0].status, 'drawn')
  } finally {
    await db.close()
  }
})

// A bridge is a container the edge does not run: its effect settles failed at
// once, saying which bridge is not deployed here, and nothing is dialed.
Deno.test('a bridge not deployed on cloudflare settles onError without a handler or fetch', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/airlock/graphile.sql', import.meta.url))
    const airlockSql = await Deno.readTextFile(new URL('../../../services/airlock/airlock.sql', import.meta.url))
    await db.exec(graphileSql)
    await db.exec(`${scheduleSql}\n${airlockSql}`)
    await db.exec(`
      CREATE TABLE sofa_request (id text PRIMARY KEY, status text NOT NULL DEFAULT 'acquiring');
      INSERT INTO sofa_request (id, status) VALUES ('r1', 'acquiring');
      INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('acquire:r1', 'acquire', '{"id":"r1"}', '{}');
      SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'acquire:r1'), job_key => 'acquire:r1');
    `)
    let issued = 0
    let dialed = 0
    const effects: EdgeEffects = {
      acquire: {
        declaration: {
          table: 'sofa_request', field: 'status', state: 'acquiring', onDone: 'applied', onError: 'failed',
          row: ['id'], idempotent: false, reentry: 'repeat', attempts: 5, handler: 'effects/acquire.js',
          bridge: { name: 'sofascore', targets: [], simulated: true },
        },
        target: { kind: 'bridge', bridge: 'sofascore' },
        issue() {
          issued++
          return { done: {} }
        },
      },
    }
    let chain = Promise.resolve()
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn)
      chain = next.then(() => {}, () => {})
      return next
    }
    const fetcher = (() => {
      dialed++
      throw new Error('dialed')
    }) as unknown as typeof fetch
    const airlock = createEdgeAirlock({ db, serialize, effects, fetcher, log: () => {}, retry: () => {} })
    assert.equal(await airlock.drain(), 1)
    const { rows: [row] } = await db.query<{ status: string; entered: number; kind: string; data: unknown }>(
      `SELECT r.status, l.entered, l.outcome->>'kind' AS kind, l.outcome->'data' AS data
         FROM sofa_request r JOIN airlock.external_effect_ledger l ON l.key = 'acquire:' || r.id WHERE r.id = 'r1'`,
    )
    assert.deepEqual(row, { status: 'failed', entered: 0, kind: 'failed', data: { bridge: 'sofascore', target: 'cloudflare', reason: 'not deployed' } })
    assert.equal(issued, 0)
    assert.equal(dialed, 0)
  } finally {
    await db.close()
  }
})
