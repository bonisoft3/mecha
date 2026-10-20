import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

Deno.test({ name: 'a failing deadline retries later while a future healthy deadline fires without requests', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-clock-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec(`
      CREATE ROLE service NOLOGIN;
      CREATE TABLE schedule (
        name text PRIMARY KEY, cron text, suspended boolean NOT NULL DEFAULT false,
        due_at timestamptz, last_tick_at timestamptz,
        emits_entity text NOT NULL, emits_values jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text);
      GRANT USAGE ON SCHEMA public TO service;
      GRANT ALL ON schedule, tick TO service;
      CHECKPOINT;
    `)
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const start = await fetch(at('/test/clock-start'))
    assert.equal(start.status, 200)
    const { future } = await start.json() as { future: string }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now()) + 1_000))
    const state = await (await fetch(at('/test/clock-state'))).json() as { alarm: number | null; ticks: { schedule: string }[] }
    assert.deepEqual(state.ticks, [{ schedule: 'healthy' }])
    assert.ok(state.alarm !== null && state.alarm > Date.now() + 20_000, `failed deadline retries later: ${state.alarm}`)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test({ name: 'a frozen archive preserves active cron history and clears standing alarms', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-archive-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec(`CREATE TABLE schedule (name text PRIMARY KEY, cron text, suspended boolean NOT NULL);
      INSERT INTO schedule VALUES ('archived-day', '0 0 * * *', false); CHECKPOINT;`)
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('archive-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    assert.equal((await fetch(at('/test/set-alarm'))).status, 200)
    const state = await fetch(at('/test/state'))
    assert.equal(state.status, 200)
    assert.deepEqual(await state.json(), { alarm: null, schedules: [{ name: 'archived-day', cron: '0 0 * * *', suspended: false }] })
    assert.equal((await fetch(at('/test/set-alarm'))).status, 200)
    assert.deepEqual(await (await fetch(at('/test/alarm'))).json(), { alarm: null })
    assert.equal((await fetch(at('/test/set-alarm'))).status, 200)
    assert.deepEqual(await (await fetch(at('/test/rearm'))).json(), { alarm: null })
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
