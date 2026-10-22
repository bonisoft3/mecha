import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { applyScripts, ChangedScript, NoLedger, pgrollScripts, recordScripts, UnrunnableScript } from '../scripts.ts'

const tables = async (db: PGlite) => (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename)

Deno.test('a kept directory applies the scripts its ledger lacks, in name order, seeds never; a ledger-less one and a changed file are refused by name, before anything moves', async () => {
  const db = await PGlite.create()
  try {
    await assert.rejects(() => applyScripts(db, [{ name: '001.sql', sql: 'CREATE TABLE a (id int)' }], () => {}), NoLedger)
    await db.exec('CREATE TABLE a (id int PRIMARY KEY)')
    await recordScripts(db, [{ name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' }, { name: '900_seed.sql', sql: 'INSERT INTO a VALUES (0)' }])
    const applied = await applyScripts(db, [
      { name: '900_seed.sql', sql: 'INSERT INTO a VALUES (1)' },
      { name: '003_c.sql', sql: '-- tier: container\nCREATE PUBLICATION p FOR ALL TABLES;\n-- tier: any\nCREATE TABLE c (id int)' },
      { name: '002_b.sql', sql: 'CREATE TABLE b (a_id int REFERENCES a (id))' },
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' },
      { name: '801_schedule_seed.sql', sql: 'INSERT INTO a VALUES (2)' },
    ], () => {})
    assert.deepEqual(applied, ['002_b.sql', '003_c.sql'])
    assert.deepEqual(await tables(db), ['_pronto_migrations', 'a', 'b', 'c'])
    assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM a')).rows[0].n, 0)
    assert.deepEqual(await applyScripts(db, [{ name: '002_b.sql', sql: 'CREATE TABLE b (a_id int REFERENCES a (id))' }], () => {}), [])
    // The entity file a release regenerated with a new table in it sorts
    // after a new script: refused, and the new script not applied either.
    await assert.rejects(() => applyScripts(db, [
      { name: '004_d.sql', sql: 'CREATE TABLE d (id int)' },
      { name: '005_e.sql', sql: 'CREATE TABLE e (id int)' },
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE z (id int)' },
    ], () => {}), (error: Error) => error instanceof ChangedScript && /001_a\.sql changed/.test(error.message))
    assert.deepEqual(await tables(db), ['_pronto_migrations', 'a', 'b', 'c'])
    // A pgroll migration only pgroll runs: its name may be recorded, never applied here.
    await recordScripts(db, [{ name: '010_recorded', sql: null }])
    assert.deepEqual(await applyScripts(db, [{ name: '010_recorded', sql: null }], () => {}), [])
    await assert.rejects(() => applyScripts(db, [{ name: '011_owed', sql: null }], () => {}), UnrunnableScript)
  } finally {
    await db.close()
  }
})

Deno.test('a pgroll set becomes scripts of its raw SQL that run, and an operation of pgroll\'s own keeps its name and no SQL', async () => {
  const scripts = pgrollScripts({
    '010_x': { operations: [{ sql: { up: 'CREATE TABLE x (id int)' } }, { sql: { up: 'CREATE INDEX x_id ON x (id);' } }] },
    '011_y': { operations: [{ add_column: { table: 'x', column: { name: 'y', type: 'text' } } }] },
  })
  assert.deepEqual(scripts, [{ name: '010_x', sql: 'CREATE TABLE x (id int);\nCREATE INDEX x_id ON x (id);' }, { name: '011_y', sql: null }])
  const db = await PGlite.create()
  try {
    await db.exec(scripts[0].sql!)
    assert.deepEqual(await tables(db), ['x'])
  } finally {
    await db.close()
  }
})
