import type { PGlite } from '@electric-sql/pglite'

export interface PGliteCollectionConfig {
  /** PGlite instance (must have `live` extension loaded). */
  pglite: PGlite
  /** Table name to subscribe to. */
  table: string
  /** Primary key column name. */
  key: string
  /** Optional SQL WHERE clause for source-level filtering. */
  where?: string
}

/**
 * Creates TanStack DB collection options backed by PGlite live queries.
 *
 * Read path: PGlite `live.changes()` detects inserts/updates/deletes
 * and feeds them into TanStack DB's differential dataflow via the
 * begin/write/commit protocol.
 */
export function pgliteCollectionOptions(config: PGliteCollectionConfig) {
  const sql = config.where
    ? `SELECT * FROM "${config.table}" WHERE ${config.where}`
    : `SELECT * FROM "${config.table}"`

  return {
    getKey: (item: any) => item[config.key],

    sync: (params: {
      collection: any
      begin: (options?: { immediate?: boolean }) => void
      write: (message: any) => void
      commit: () => void
      markReady: () => void
      truncate: () => void
    }) => {
      const { begin, write, commit, markReady } = params

      const subscriptionPromise = (config.pglite as any).live
        .changes(sql, [], config.key, (changes: any[]) => {
          if (changes.length === 0) return
          begin()
          for (const c of changes) {
            const op = c.__op__
            if (op === 'DELETE') {
              write({ type: 'delete', key: c[config.key] })
            } else {
              const value = { ...c }
              delete value.__op__
              delete value.__changed_columns__
              delete value.__after__
              write({
                type: op === 'INSERT' ? 'insert' : 'update',
                value,
              })
            }
          }
          commit()
        })
        .then((sub: any) => {
          if (sub.initialChanges && sub.initialChanges.length > 0) {
            begin()
            for (const c of sub.initialChanges) {
              const value = { ...c }
              delete value.__op__
              delete value.__changed_columns__
              delete value.__after__
              write({ type: 'insert', value })
            }
            commit()
          }

          markReady()
          return sub
        })

      return () => {
        subscriptionPromise.then((sub: any) => sub?.unsubscribe())
      }
    },
  }
}
