import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { createDatabase } from '../../mecha-browser/src/database.ts'
import { createEdgeAirlock, type EdgeEffects } from './airlock.ts'

Deno.test('createEdgeAirlock drains airlock.external_effect_ledger via Cloudflare Workers AI binding and settles generation_draft', async () => {
  const db = await createDatabase({})
  try {
    const scheduleSql = await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url))
    const graphileSql = await Deno.readTextFile(new URL('../../../services/airlock/graphile.sql', import.meta.url))
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
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.status = 'idle' AND NEW.status = 'illustrating' THEN
          INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
          VALUES ('sdcpp-illustrate:' || NEW.id, 'sdcpp-illustrate', jsonb_build_object('id', NEW.id), jsonb_build_object('topic', NEW.topic, 'locale', NEW.locale, 'region', NEW.region, 'card_count', NEW.card_count));
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
        target: { kind: 'bifrost' },
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
        target: { kind: 'bifrost' },
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
            if (model.includes('gemma')) {
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
    assertEquals(settled, 2)
    assertEquals(aiCalls.map((c) => c.model), [
      '@cf/google/gemma-4-26b-a4b-it',
      '@cf/black-forest-labs/flux-2-klein-9b',
    ])

    const { rows } = await db.query<{ id: string; status: string; category: string }>(
      'SELECT id, status, category FROM generation_draft ORDER BY id',
    )
    assertEquals(rows, [
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
    const graphileSql = await Deno.readTextFile(new URL('../../../services/airlock/graphile.sql', import.meta.url))
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
        target: { kind: 'bifrost' },
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
    assertEquals(first, 0)
    assertEquals(retried, 1)
    assertEquals(typeof airlock.retryAt(), 'number')
  } finally {
    await db.close()
  }
})

