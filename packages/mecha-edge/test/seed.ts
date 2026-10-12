// The fixture's data directory, built on disk with npm's PGlite as a release
// builds one: rls.sql, then fixture.sql.
import { PGlite } from '@electric-sql/pglite'

export async function seed(pgdata: string) {
  Deno.mkdirSync(pgdata)
  const db = await PGlite.create({ dataDir: pgdata })
  await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
  await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
  await db.exec('CHECKPOINT')
  await db.close()
}
