import type { PGlite } from '@electric-sql/pglite'
import { readRest, type ReadSchema } from '@mecha/postgrest-js'

export class PublicSnapshotCapacity extends Error {}

export interface PublicSnapshot {
  revision: string
  read(path: string): Promise<unknown[]>
}

const revisions = new WeakMap<PGlite, { revision: string; owner: object }>()

/** PGlite has one connection. Its owner must serialize this with every other use.
 * Generation changes when the data directory is replaced, even by an older copy. */
export async function publicSnapshot<T>(
  db: PGlite,
  generation: string,
  use: (snapshot: PublicSnapshot) => Promise<T>,
  schema?: ReadSchema,
): Promise<T> {
  if (!generation) throw new Error('snapshot requires a database generation')
  const result = await db.transaction(async tx => {
    // No subject and no session lookup: policies see exactly the public scope.
    const [, { rows }] = await tx.exec(`
      SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
      SELECT pg_current_snapshot()::text AS revision,
             set_config('request.jwt.claims', '{"role":"app_user"}', true),
             set_config('app.scopes', 'public:', true);
      SET LOCAL ROLE app_user;
    `) as [unknown, { rows: { revision: string }[] }]
    const revision = JSON.stringify([generation, rows[0].revision])
    let cached = revisions.get(db)
    if (cached?.revision !== revision) {
      cached = { revision, owner: {} }
      revisions.set(db, cached)
    }
    const cacheOwner = cached.owner
    let active = true
    const reads: Promise<{ error: unknown } | undefined>[] = []
    const read = (path: string): Promise<unknown[]> => {
      if (!active) throw new Error('snapshot is closed')
      if (!/^\/[A-Za-z_][A-Za-z0-9_]*(\?|$)/.test(path)) throw new Error('invalid snapshot read path')
      const pending = (async () => {
        const response = await readRest(tx, new Request('https://snapshot.invalid' + path), schema, cacheOwner)
        if (!response.ok) throw new Error(`snapshot read ${response.status}: ${await response.text()}`)
        return await response.json() as unknown[]
      })()
      // Attach settlement immediately: a caller can issue reads concurrently.
      reads.push(pending.then(() => undefined, error => ({ error })))
      return pending
    }
    try {
      return { value: await use({ revision, read }) }
    } finally {
      active = false
      // A detached failed read must roll back rather than let the transaction commit.
      for (const outcome of await Promise.all(reads)) {
        if (outcome) throw outcome.error
      }
    }
  })
  if (!result) throw new Error('public snapshot transaction rolled back')
  return result.value
}
