// Data directories built on disk with npm's PGlite, the same Postgres 18 the
// package builds: initdb's alone, or with fixture.sql applied.
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

export const fixture = new URL('fixture.sql', import.meta.url)

export async function seed(pgdata: string, withFixture: boolean) {
  // A fresh directory: PGlite runs initdb into it.
  Deno.mkdirSync(pgdata)
  const db = await PGlite.create({ dataDir: pgdata, icuDataDir: await icuDataDir() })
  if (withFixture) await db.exec(await Deno.readTextFile(fixture))
  await db.exec('CHECKPOINT')
  await db.close()
}
