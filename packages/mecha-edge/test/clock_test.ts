import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createEdgeCluster } from '../src/cluster.ts'
import { hasSchedules, nextDue, serviceCrud, sweepDue } from '../src/clock.ts'
import type { Crud } from '../../../services/ticker/crud.ts'

// mecha's own table, as a release's data directory holds it.
const SCHEDULE_SQL = new URL('../../../services/ticker/schedule.sql', import.meta.url)

async function clockDb(): Promise<{ db: PGlite; crud: Crud }> {
  const db = await PGlite.create()
  await db.exec('CREATE ROLE service NOLOGIN BYPASSRLS; GRANT USAGE ON SCHEMA public TO service;')
  await db.exec(await Deno.readTextFile(SCHEDULE_SQL))
  await db.exec('CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text); GRANT ALL ON tick TO service;')
  const cluster = await createEdgeCluster({ db, tables: [], secret: 'clock-test', log: () => {}, fail: (error) => { throw error } })
  return { db, crud: serviceCrud(cluster.service) }
}

const at = (iso: string) => Date.parse(iso)
const ticks = async (db: PGlite) => (await db.query<{ schedule: string; tick_at: string; late: boolean; caller: string }>(`SELECT schedule, to_char(tick_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS tick_at, late, caller FROM tick ORDER BY tick_at`)).rows

Deno.test('edge deadlines persist their watermark, isolate failures, and safely retry partial delivery', async () => {
  const { db, crud } = await clockDb()
  try {
    await db.exec("INSERT INTO schedule (name, due_at, emits_entity) VALUES ('kept', '2026-10-19T10:00:00Z', 'tick')")
    const now = new Date('2026-10-19T12:00:00Z')
    assert.equal(await hasSchedules(db), true)
    assert.equal(await nextDue(db, now), at('2026-10-19T10:00:00Z'))
    const first = await sweepDue(crud, now, 'alarm')
    assert.deepEqual(first.schedules, [{ schedule: 'kept', emitted: 1, late: 0, held: 0, behind: false }])
    assert.equal(await nextDue(db, now), null)
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules[0].emitted, 0)
    assert.deepEqual(await ticks(db), [{ schedule: 'kept', tick_at: '2026-10-19T10:00:00Z', late: false, caller: 'alarm' }])

    await db.exec(`INSERT INTO schedule (name, due_at, emits_entity) VALUES
      ('broken', '2026-10-19T09:00:00Z', 'missing'), ('healthy', '2026-10-19T11:00:00Z', 'tick')`)
    const mixed = await sweepDue(crud, now, 'alarm')
    assert.match(mixed.schedules.find((s) => s.schedule === 'broken')!.error!, /crud POST \/missing/)
    assert.equal(mixed.schedules.find((s) => s.schedule === 'healthy')!.emitted, 1)
    assert.deepEqual((await db.query<{ name: string }>('SELECT name FROM schedule WHERE last_tick_at IS NOT NULL ORDER BY name')).rows.map((r) => r.name), ['healthy', 'kept'])
    // The failure stays due; a retry is owed at its instant, and an earlier
    // future deadline keeps its own.
    assert.equal(await nextDue(db, now), at('2026-10-19T09:00:00Z'))
    const retry = { through: now, at: new Date('2026-10-19T12:00:30Z') }
    assert.equal(await nextDue(db, now, retry), retry.at.getTime())
    await db.exec("INSERT INTO schedule (name, due_at, emits_entity) VALUES ('future', '2026-10-19T12:00:10Z', 'tick')")
    assert.equal(await nextDue(db, now, retry), at('2026-10-19T12:00:10Z'))
    await db.exec("DELETE FROM schedule WHERE name IN ('future', 'broken'); UPDATE schedule SET last_tick_at = NULL WHERE name = 'healthy'")

    // A watermark that could not be written leaves the tick owed: the retry
    // rewrites the same key and moves it.
    const writeFailure = new Error('watermark unavailable')
    const failing = await sweepDue(async (method, path, opts) => {
      if (method === 'PATCH') throw writeFailure
      return crud(method, path, opts)
    }, now, 'alarm')
    assert.equal(failing.schedules.find((r) => r.schedule === 'healthy')!.error, writeFailure.message)
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules.find((r) => r.schedule === 'healthy')!.emitted, 1)
    assert.equal((await ticks(db)).length, 2)
    assert.equal(await nextDue(db, now), null)

    await db.exec("UPDATE schedule SET due_at = '2026-10-19T13:00:00Z' WHERE name = 'healthy'")
    assert.equal(await nextDue(db, now), at('2026-10-19T13:00:00Z'))
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules.find((s) => s.schedule === 'healthy')!.emitted, 0)
    await db.exec("UPDATE schedule SET suspended = true WHERE name = 'healthy'")
    assert.equal(await nextDue(db, now), null)

    // Tick keys are kept to the millisecond; the alarm must agree on completion.
    await db.exec("INSERT INTO schedule (name, due_at, emits_entity) VALUES ('precise', '2026-10-19T10:00:00.123456Z', 'tick')")
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules.find((s) => s.schedule === 'precise')!.emitted, 1)
    assert.equal(await nextDue(db, now), null)
    await db.exec("UPDATE schedule SET due_at = '2026-10-19T10:00:00.123789Z' WHERE name = 'precise'")
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules.find((s) => s.schedule === 'precise')!.emitted, 0)
    assert.equal(await nextDue(db, now), null)

    // A deadline re-armed while its tick is written (a machine's settle
    // between the write and the watermark) stays owed at its new instant.
    await db.exec("UPDATE schedule SET suspended = false, due_at = '2026-10-19T11:00:00Z', last_tick_at = NULL WHERE name = 'healthy'")
    const rearming = await sweepDue(async (method, path, opts) => {
      const rows = await crud(method, path, opts)
      if (method === 'POST') await db.exec("UPDATE schedule SET due_at = '2026-10-19T14:00:00Z', last_tick_at = NULL WHERE name = 'healthy'")
      return rows
    }, now, 'alarm')
    assert.equal(rearming.schedules.find((s) => s.schedule === 'healthy')!.emitted, 1)
    assert.equal(await nextDue(db, now), at('2026-10-19T14:00:00Z'))
  } finally {
    await db.close()
  }
})

Deno.test('a cron schedule is the alarm too: owed at its occurrence, late behind its horizon, next after its watermark', async () => {
  const { db, crud } = await clockDb()
  try {
    assert.equal(await hasSchedules(db), true)
    await db.exec("INSERT INTO schedule (name, cron, time_zone, emits_entity) VALUES ('daily', '0 0 * * *', 'America/Sao_Paulo', 'tick')")
    // Half a minute past a Brasília midnight, inside the 300 s lateness budget.
    const now = new Date('2026-10-19T03:00:30Z')
    assert.equal(await nextDue(db, now), at('2026-10-19T03:00:00Z'))
    const report = await sweepDue(crud, now, 'cron-trigger')
    assert.deepEqual(report.schedules, [{ schedule: 'daily', emitted: 1, late: 0, held: 0, behind: false }])
    assert.deepEqual(await ticks(db), [{ schedule: 'daily', tick_at: '2026-10-19T03:00:00Z', late: false, caller: 'cron-trigger' }])
    assert.equal(await nextDue(db, now), at('2026-10-20T03:00:00Z'))
    assert.equal((await sweepDue(crud, now, 'alarm')).schedules[0].emitted, 0)

    // Behind by days, the schedule is owed at its first runnable occurrence,
    // not at the missed ones: the sweep records the first of those late and
    // not run, runs the runnable one, and the watermark moves past the span,
    // as the ticker's due() decides.
    await db.exec("DELETE FROM tick; UPDATE schedule SET last_tick_at = '2026-10-16T03:00:00Z'")
    assert.equal(await nextDue(db, now), at('2026-10-19T03:00:00Z'))
    assert.deepEqual((await sweepDue(crud, now, 'alarm')).schedules[0], { schedule: 'daily', emitted: 1, late: 1, held: 0, behind: false })
    assert.deepEqual((await ticks(db)).map((t) => [t.tick_at, t.late]), [['2026-10-17T03:00:00Z', true], ['2026-10-19T03:00:00Z', false]])
    assert.equal(await nextDue(db, now), at('2026-10-20T03:00:00Z'))

    // A row due.ts refuses arms no alarm and leaves the others' alone; the
    // sweep names it, as the ticker's would.
    await db.exec("INSERT INTO schedule (name, cron, emits_entity) VALUES ('six', '0 0 * * * *', 'tick')")
    assert.equal(await nextDue(db, now), at('2026-10-20T03:00:00Z'))
    assert.match((await sweepDue(crud, now, 'alarm')).schedules.find((s) => s.schedule === 'six')!.error!, /five-field cron/)
    await db.exec("UPDATE schedule SET suspended = true")
    assert.equal(await nextDue(db, now), null)
  } finally {
    await db.close()
  }
})

Deno.test('a data directory without the schedule table has no clock', async () => {
  const db = await PGlite.create()
  try {
    assert.equal(await hasSchedules(db), false)
  } finally {
    await db.close()
  }
})
