import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { pg_ivm } from '@electric-sql/pglite-pg_ivm'
import { loadIncrementalViews } from '@mecha/incremental-views'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

export async function createDatabase<O extends PGliteOptions>(options: O) {
  return loadIncrementalViews(await PGlite.create({
    ...options,
    extensions: { pg_ivm, ...options.extensions },
    icuDataDir: options.icuDataDir ?? await icuDataDir(),
  }))
}
