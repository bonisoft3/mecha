import { PGlite, type PGliteOptions } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

export async function createDatabase<O extends PGliteOptions>(options: O) {
  return PGlite.create({
    ...options,
    icuDataDir: options.icuDataDir ?? await icuDataDir(),
  })
}
