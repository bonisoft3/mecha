import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createEdgeCluster } from '../src/cluster.ts'
import { hasSchedules, nextDue, serviceCrud, sweepDue } from '../src/clock.ts'

Deno.test('edge deadlines persist their watermark, isolate failures, and safely retry partial delivery', async () => {
  const db = await PGlite.create()
  try {
    await db.exec(`
      CREATE ROLE service NOLOGIN;
      CREATE TABLE schedule (
        name text PRIMARY KEY, cron text, suspended boolean NOT NULL DEFAULT false,
        due_at timestamptz, last_tick_at timestamptz,
        emits_entity text NOT NULL DEFAULT 'tick', emits_values jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE tick (id uuid PRIMARY KEY, schedule text, tick_at timestamptz, late boolean, caller text);
      GRANT USAGE ON SCHEMA public TO service;
      GRANT ALL ON schedule, tick TO service;
      INSERT INTO schedule (name, due_at) VALUES ('kept', '2026-10-19T10:00:00Z');
    `)
    const cluster = await createEdgeCluster({ db, tables: [], secret: 'clock-test', log: () => {}, fail: error => { throw error } })
    const crud = serviceCrud(cluster.service)
    const now = new Date('2026-10-19T12:00:00Z')
    assert.equal(await hasSchedules(db), true)
    assert.equal(await nextDue(db), Date.parse('2026-10-19T10:00:00Z'))
    assert.equal(await sweepDue(crud, now), 1)
    assert.equal(await nextDue(db), null)
    assert.equal(await sweepDue(crud, now), 0)
    assert.equal((await db.query('SELECT * FROM tick')).rows.length, 1)

    await db.exec(`
      INSERT INTO schedule (name, due_at, emits_entity) VALUES
        ('broken', '2026-10-19T09:00:00Z', 'missing'),
        ('healthy', '2026-10-19T11:00:00Z', 'tick');
    `)
    await assert.rejects(() => sweepDue(crud, now), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 1)
      assert.match(error.errors[0].message, /broken/)
      assert.match(error.errors[0].cause.message, /crud POST \/missing/)
      return true
    })
    assert.deepEqual((await db.query<{ name: string }>('SELECT name FROM schedule WHERE last_tick_at IS NOT NULL ORDER BY name')).rows.map(r => r.name), ['healthy', 'kept'])
    assert.equal(await nextDue(db), Date.parse('2026-10-19T09:00:00Z'))
    const retry = { through: now, at: new Date('2026-10-19T12:00:30Z') }
    assert.equal(await nextDue(db, retry), retry.at.getTime())
    await db.exec("INSERT INTO schedule (name, due_at) VALUES ('future', '2026-10-19T12:00:10Z')")
    assert.equal(await nextDue(db, retry), Date.parse('2026-10-19T12:00:10Z'))
    await db.exec("DELETE FROM schedule WHERE name = 'future'")
    await db.exec("DELETE FROM schedule WHERE name = 'broken'; UPDATE schedule SET last_tick_at = NULL WHERE name = 'healthy'")
    const writeFailure = new Error('watermark unavailable')
    await assert.rejects(() => sweepDue(async (method, path, opts) => {
      if (method === 'PATCH') throw writeFailure
      return crud(method, path, opts)
    }, now), error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors[0].cause, writeFailure)
      return true
    })
    assert.equal(await sweepDue(crud, now), 1)
    assert.equal((await db.query('SELECT * FROM tick')).rows.length, 2)
    assert.equal(await nextDue(db), null)

    await db.exec("UPDATE schedule SET due_at = '2026-10-19T13:00:00Z' WHERE name = 'healthy'")
    assert.equal(await nextDue(db), Date.parse('2026-10-19T13:00:00Z'))
    assert.equal(await sweepDue(crud, now), 0)
    await db.exec("UPDATE schedule SET suspended = true WHERE name = 'healthy'")
    assert.equal(await nextDue(db), null)

    // Tick IDs normalize to milliseconds; the alarm must agree on completion.
    await db.exec("INSERT INTO schedule (name, due_at) VALUES ('precise', '2026-10-19T10:00:00.123456Z')")
    assert.equal(await sweepDue(crud, now), 1)
    assert.equal(await nextDue(db), null)
    await db.exec("UPDATE schedule SET due_at = '2026-10-19T10:00:00.123789Z' WHERE name = 'precise'")
    assert.equal(await sweepDue(crud, now), 0)
    assert.equal(await nextDue(db), null)

    await db.exec("UPDATE schedule SET suspended = false, due_at = '2026-10-19T11:00:00Z', last_tick_at = NULL WHERE name = 'healthy'")
    assert.equal(await sweepDue(async (method, path, opts) => {
      const rows = await crud(method, path, opts)
      if (method === 'POST') {
        await db.exec("UPDATE schedule SET due_at = '2026-10-19T14:00:00Z', last_tick_at = NULL WHERE name = 'healthy'")
      }
      return rows
    }, now), 1)
    assert.equal((await db.query<{ last_tick_at: string | null }>("SELECT last_tick_at FROM schedule WHERE name = 'healthy'")).rows[0].last_tick_at, null)
    assert.equal(await nextDue(db), Date.parse('2026-10-19T14:00:00Z'))
  } finally {
    await db.close()
  }
})

Deno.test('edge clock permits suspended cron history but rejects active cron schedules', async () => {
  const db = await PGlite.create()
  try {
    assert.equal(await hasSchedules(db), false)
    await db.exec(`CREATE TABLE schedule (name text PRIMARY KEY, cron text, suspended boolean NOT NULL);
      INSERT INTO schedule VALUES ('archived-day', '0 0 * * *', true)`)
    assert.equal(await hasSchedules(db), true)
    await db.exec("UPDATE schedule SET suspended = false")
    await assert.rejects(() => hasSchedules(db), /schedule archived-day is cron/)
  } finally {
    await db.close()
  }
})
