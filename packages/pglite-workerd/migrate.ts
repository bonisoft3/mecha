// The pgroll migrations a data directory restored from a mecha database lacks,
// applied as mecha's migrate step applies them (services/migrate/migrate.sh):
// read from the directory's own ledger, in name order, each recorded before the
// next. pgroll itself does not run in PGlite, so a migration is applied when
// all its operations are raw SQL, and refused otherwise; its `up` passes the
// tier fence, as the page's migrations do.
import type { PGlite } from '@electric-sql/pglite'
import { browserTier } from '../mecha-browser/fence.ts'
import { pgrollSql } from './scripts.ts'

export interface Migration { operations: Record<string, unknown>[] }

export async function migrate(db: PGlite, migrations: Record<string, Migration>, log: (line: string) => void = console.log): Promise<string[]> {
  const ledger = await db.query<{ ok: boolean }>("SELECT to_regclass('pgroll.migrations') IS NOT NULL AS ok")
  if (!ledger.rows[0].ok) throw new Error('the directory has no pgroll ledger: dump its database with --schema=pgroll')
  const done = new Set((await db.query<{ name: string }>(
    "SELECT name FROM pgroll.migrations WHERE schema = 'public' AND migration_type = 'pgroll' AND done",
  )).rows.map((r) => r.name))
  const latestOf = async () => (await db.query<{ name: string }>(
    `SELECT coalesce(max(name COLLATE "C"), '') AS name FROM pgroll.migrations WHERE schema = 'public' AND migration_type = 'pgroll'`,
  )).rows[0].name
  let latest = await latestOf()
  const applied: string[] = []
  // Byte order, as migrate.sh's LC_ALL=C glob.
  for (const name of Object.keys(migrations).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (done.has(name)) continue
    // A fresh volume applies it before `latest`, and this one would after.
    if (name < latest) throw new Error(`${name} sorts before ${latest}, which this directory already applied`)
    const ops = migrations[name].operations
    await db.exec(browserTier(pgrollSql(name, migrations[name])))
    // The row `pgroll start --complete` leaves: its parent is the schema's
    // latest migration of any kind, which keeps the history linear.
    await db.query(
      `INSERT INTO pgroll.migrations (schema, name, migration, parent, done, resulting_schema, migration_type)
       VALUES ('public', $1, $2, pgroll.latest_migration('public'), true, pgroll.read_schema('public'), 'pgroll')`,
      [name, JSON.stringify({ name, operations: ops })],
    )
    log(`migrated ${name}`)
    applied.push(name)
    latest = name
  }
  return applied
}
