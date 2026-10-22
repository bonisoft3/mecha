import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

// mecha's own table, as a release's data directory holds it, and a tick table.
async function withSchedules(pgdata: string) {
  const db = await PGlite.create({ dataDir: pgdata })
  try {
    await db.exec('CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;')
    await db.exec(await Deno.readTextFile(new URL('../../../services/ticker/schedule.sql', import.meta.url)))
    await db.exec('CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text); GRANT ALL ON tick TO service; CHECKPOINT;')
  } finally {
    await db.close()
  }
}

Deno.test({ name: 'a failing deadline retries later while a future healthy deadline fires without requests', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-clock-' })
  await seed(`${tmp}/pgdata`)
  await withSchedules(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    const start = await fetch(at('/test/clock-start'))
    assert.equal(start.status, 200)
    const { future } = await start.json() as { future: string }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(future) - Date.now()) + 1_000))
    const state = await (await fetch(at('/test/clock-state'))).json() as { alarm: number | null; ticks: { schedule: string }[] }
    assert.deepEqual(state.ticks, [{ schedule: 'healthy', caller: 'alarm' }])
    assert.ok(state.alarm !== null && state.alarm > Date.now() + 20_000, `failed deadline retries later: ${state.alarm}`)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test({ name: 'the Cron Trigger and a publish poke the object, which sweeps a cron schedule and arms its next occurrence', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-cron-' })
  await seed(`${tmp}/pgdata`)
  await withSchedules(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const at = (path: string) => `${worker.origin}${path}`
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })
    assert.equal((await fetch(at('/test/cron-start'))).status, 200)
    // wrangler's --test-scheduled: the Cron Trigger's scheduled() runs.
    const triggered = await fetch(at('/__scheduled?cron=0+*+*+*+*'))
    assert.equal(triggered.status, 200, await triggered.text())
    const before = Date.now()
    const state = await (await fetch(at('/test/clock-state'))).json() as { alarm: number | null; ticks: { schedule: string; caller: string }[] }
    // The alarm may mint the next minute's tick before this read.
    assert.ok(state.ticks.some((t) => t.caller === 'cron-trigger') && state.ticks.every((t) => t.schedule === 'minutely' && ['cron-trigger', 'alarm'].includes(t.caller)), JSON.stringify(state.ticks))
    assert.ok(state.alarm !== null && state.alarm > before - 60_000 && state.alarm <= before + 60_000, `the alarm stands at the next minute: ${state.alarm}`)

    const unauthorized = await fetch(at('/poke?caller=publish'), { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.equal((await fetch(at('/poke'), { headers: { authorization: 'Bearer test-import' } })).status, 405)
    const poked = await fetch(at('/poke?caller=publish'), { method: 'POST', headers: { authorization: 'Bearer test-import' } })
    const report = await poked.json() as { caller: string; schedules: { schedule: string; emitted: number }[] }
    assert.equal(poked.status, 200, JSON.stringify(report))
    assert.equal(report.caller, 'publish')
    assert.deepEqual(report.schedules.map((s) => s.schedule), ['minutely'])
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
    await db.exec(`CREATE TABLE schedule (name text PRIMARY KEY, cron text, suspended boolean NOT NULL, emits_entity text NOT NULL DEFAULT 'tick');
      INSERT INTO schedule (name, cron, suspended) VALUES ('archived-day', '0 0 * * *', false); CHECKPOINT;`)
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
    assert.deepEqual(await state.json(), { alarm: null, schedules: [{ name: 'archived-day', cron: '0 0 * * *', suspended: false, emits_entity: 'tick' }] })
    assert.equal((await fetch(at('/test/set-alarm'))).status, 200)
    assert.deepEqual(await (await fetch(at('/test/alarm'))).json(), { alarm: null })
    assert.equal((await fetch(at('/test/set-alarm'))).status, 200)
    assert.deepEqual(await (await fetch(at('/test/rearm'))).json(), { alarm: null })
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
})
