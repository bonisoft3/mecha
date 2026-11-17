import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { unaccent } from '@electric-sql/pglite/contrib/unaccent'
import { pg_ivm } from '@electric-sql/pglite-pg_ivm'
import { loadIncrementalViews } from '@mecha/incremental-views'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

// unaccent because a schema may search text with its accents ignored, as the
// cluster's PostgreSQL and the edge's PGlite both can; a migration's
// CREATE EXTENSION finds it installed.
export async function createDatabase<O extends PGliteOptions>(options: O) {
  return loadIncrementalViews(await PGlite.create({
    ...options,
    extensions: { pg_ivm, unaccent, ...options.extensions },
    icuDataDir: options.icuDataDir ?? await icuDataDir(),
  }))
}
