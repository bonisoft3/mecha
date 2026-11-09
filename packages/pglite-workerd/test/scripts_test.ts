import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { appliedPgroll, applyScripts, ChangedScript, digest, isSeedScript, NoLedger, OutOfOrderScript, pgrollScripts, recordArchive, recordScripts, UnrunnableScript } from '../scripts.ts'

const tables = async (db: PGlite) => (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename)

// The order is the release's, not the names': sorting every name as bytes ran
// an effect step the program placed at 060 after a pgroll migration 052 that
// a fresh directory runs after it, and the reducer actors at 063 before the
// pgroll migrations named 20261108_* that make the tables they drive.
Deno.test('a kept directory applies the scripts its ledger lacks, in the order given, seeds never; a ledger-less one and a changed file are refused by name, before anything moves', async () => {
  const db = await PGlite.create()
  try {
    await assert.rejects(() => applyScripts(db, [{ name: '001.sql', sql: 'CREATE TABLE a (id int)' }], () => {}), NoLedger)
    await db.exec('CREATE TABLE a (id int PRIMARY KEY)')
    await recordScripts(db, [{ name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' }, { name: '900_seed.sql', sql: 'INSERT INTO a VALUES (0)' }])
    const applied = await applyScripts(db, [
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' },
      { name: '900_seed.sql', sql: 'INSERT INTO a VALUES (1)' },
      { name: '060_c.sql', sql: '-- tier: container\nCREATE PUBLICATION p FOR ALL TABLES;\n-- tier: any\nCREATE TABLE c (id int PRIMARY KEY)' },
      { name: '801_schedule_seed.sql', sql: 'INSERT INTO a VALUES (2)' },
      { name: '052_b', sql: 'CREATE TABLE b (c_id int REFERENCES c (id))' },
    ], () => {})
    assert.deepEqual(applied, ['060_c.sql', '052_b'])
    assert.deepEqual(await tables(db), ['_pronto_migrations', 'a', 'b', 'c'])
    assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM a')).rows[0].n, 0)
    assert.deepEqual(await applyScripts(db, [{ name: '052_b', sql: 'CREATE TABLE b (c_id int REFERENCES c (id))' }], () => {}), [])
    // The entity file a release regenerated with a new table in it comes
    // after a new script: refused, and the new script not applied either.
    await assert.rejects(() => applyScripts(db, [
      { name: '004_d.sql', sql: 'CREATE TABLE d (id int)' },
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE z (id int)' },
      { name: '005_e.sql', sql: 'CREATE TABLE e (id int)' },
    ], () => {}), (error: Error) => error instanceof ChangedScript && /001_a\.sql changed/.test(error.message))
    assert.deepEqual(await tables(db), ['_pronto_migrations', 'a', 'b', 'c'])
    // A pgroll migration only pgroll runs: its name may be recorded, never applied here.
    await recordScripts(db, [{ name: '010_recorded', sql: null }])
    assert.deepEqual(await applyScripts(db, [{ name: '010_recorded', sql: null }], () => {}), [])
    await assert.rejects(() => applyScripts(db, [{ name: '053_owed', sql: null }], () => {}), UnrunnableScript)
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

// A migration with "seed" anywhere in its name counted as a seed, so a kept directory never ran it.
// A fresh directory ran the set in the order the program's export spelled it,
// so a migration granting on a table ran before the one creating it.
Deno.test('a pgroll set runs in key order, whatever order it was spelled in', () => {
  const sql = (up: string) => ({ operations: [{ sql: { up } }] })
  const names = pgrollScripts({ '021_guards': sql('SELECT 2'), '009_order': sql('SELECT 1'), '20261028_locks': sql('SELECT 3') }).map((s) => s.name)
  assert.deepEqual(names, ['009_order', '021_guards', '20261028_locks'])
})

Deno.test('a seed is a script named so, not one that mentions the word', () => {
  assert.deepEqual(['900_seed.sql', '801_schedule_seed.sql', '20261102_seed_pictures_are_objects.sql'].map(isSeedScript), [true, true, false])
})

// The carry once ran the pgroll set from the archive's pgroll ledger, which
// refused a migration sorting before the latest applied as migrate.sh does;
// the one ledger lost that, so with 002 applied a release adding 001 ran it
// after, and noncommutative migrations left a carried database unlike a fresh
// one. Files are unaffected: they precede the pgroll stream by rule.
Deno.test('a pgroll migration owed that sorts before one the directory applied is refused, naming both, before anything moves', async () => {
  const db = await PGlite.create()
  try {
    await db.exec('CREATE TABLE a (id int PRIMARY KEY)')
    await recordScripts(db, [{ name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' }, { name: '002_widen', sql: 'ALTER TABLE a ADD COLUMN w int' }])
    await assert.rejects(() => applyScripts(db, [
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' },
      { name: '003_b.sql', sql: 'CREATE TABLE b (id int)' },
      { name: '001_narrow', sql: 'ALTER TABLE a ADD COLUMN n int' },
      { name: '002_widen', sql: 'ALTER TABLE a ADD COLUMN w int' },
    ], () => {}), (error: Error) => error instanceof OutOfOrderScript && /001_narrow sorts before 002_widen/.test(error.message))
    assert.deepEqual(await tables(db), ['_pronto_migrations', 'a'])
    assert.deepEqual(await applyScripts(db, [
      { name: '001_a.sql', sql: 'CREATE TABLE a (id int PRIMARY KEY)' },
      { name: '001_b.sql', sql: 'CREATE TABLE b (id int)' },
      { name: '002_widen', sql: 'ALTER TABLE a ADD COLUMN w int' },
      { name: '003_narrow', sql: 'ALTER TABLE a ADD COLUMN n int' },
    ], () => {}), ['001_b.sql', '003_narrow'])
  } finally {
    await db.close()
  }
})

// pgroll keeps the text each migration ran in its own ledger, so an archive
// establishes its pgroll entries from itself, and a release whose text moved
// since is refused as changed, as a kept directory refuses one.
Deno.test('an archive records the release\'s files as given and its own pgroll ledger by the text it applied, and refuses another release\'s scripts', async () => {
  const db = await PGlite.create()
  const migration = (up: string) => ({ operations: [{ sql: { up, onComplete: true } }] })
  try {
    assert.deepEqual(await appliedPgroll(db), [])
    await db.exec(`CREATE SCHEMA pgroll;
      CREATE TABLE pgroll.migrations (schema text, name text, migration jsonb, done boolean, migration_type text);
      CREATE TABLE team (id int PRIMARY KEY, city text)`)
    await db.query('INSERT INTO pgroll.migrations VALUES ($1, $2, $3, true, $4), ($1, $5, $6, true, $7), ($1, $8, $9, false, $4), ($10, $11, $12, true, $4)', [
      'public', '00_initdb', JSON.stringify({ operations: [] }), 'baseline',
      '001_add_city', JSON.stringify(migration('ALTER TABLE team ADD COLUMN city text')), 'pgroll',
      '002_undone', JSON.stringify(migration('SELECT 2')), 'legacy',
      '00000_initial', JSON.stringify(migration('CREATE SCHEMA legacy')),
    ])
    assert.deepEqual(await appliedPgroll(db), [{ name: '001_add_city', sql: 'ALTER TABLE team ADD COLUMN city text' }])
    const files = [{ name: '003_rls.sql', sql: 'SELECT 3' }, { name: '005_create_tables.sql', sql: 'CREATE TABLE team (id int PRIMARY KEY)' }, { name: '900_seed.sql', sql: 'INSERT INTO team VALUES (1)' }]
    await assert.rejects(() => recordArchive(db, files), /the archive completed 001_add_city, which it does not name/)
    await assert.rejects(() => recordArchive(db, [...files, { name: '001_add_city', sql: 'x' }, { name: '002_undone', sql: 'SELECT 2' }]), /it names 002_undone, which the archive's pgroll ledger never completed/)
    assert.equal((await db.query<{ ok: boolean }>("SELECT to_regclass('public._pronto_migrations') IS NOT NULL AS ok")).rows[0].ok, false)
    // The release's text for the migration is not what the archive ran: the archive's is recorded.
    const recorded = await recordArchive(db, [...files, { name: '001_add_city', sql: 'ALTER TABLE team ADD COLUMN city text; SELECT 1' }])
    assert.deepEqual(recorded.map((s) => s.name), ['003_rls.sql', '005_create_tables.sql', '900_seed.sql', '001_add_city'])
    const ledger = (await db.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM public._pronto_migrations ORDER BY name')).rows
    assert.deepEqual(ledger.map((r) => r.name), ['001_add_city', '003_rls.sql', '005_create_tables.sql', '900_seed.sql'])
    assert.equal(ledger[0].sha256, await digest('ALTER TABLE team ADD COLUMN city text'))
    const release = [...files, { name: '001_add_city', sql: 'ALTER TABLE team ADD COLUMN city text' }, { name: '002_add_country', sql: "ALTER TABLE team ADD COLUMN country text NOT NULL DEFAULT 'Brazil'" }]
    assert.deepEqual(await applyScripts(db, release, () => {}), ['002_add_country'])
    await assert.rejects(() => applyScripts(db, [...files, { name: '001_add_city', sql: 'ALTER TABLE team ADD COLUMN city text; SELECT 1' }], () => {}), (error: Error) => error instanceof ChangedScript && /001_add_city changed/.test(error.message))
  } finally {
    await db.close()
  }
})
