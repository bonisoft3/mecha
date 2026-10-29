// The scripts a data directory applied, as the docker appliance's entrypoint
// records them (pronto's builders/bayt.cue): a ledger of names,
// `_pronto_migrations`, written when a directory is built and read when a
// later release reaches a directory the object kept — here with each
// script's digest beside its name. A script the ledger lacks is applied in
// name order, through the tier fence, and recorded; a seed is not, since it
// belongs to a directory being built; a recorded script whose text the
// release changed is refused by name, before anything is applied, because a
// live schema moves only by a pgroll migration (pronto's
// docs/schema-change-admission.md), never by a file the directory already
// ran. A directory without the ledger predates it: nothing says what it
// holds, so it is refused, and a reset loads one that carries it.
import type { PGlite } from '@electric-sql/pglite'
import { browserTier } from '../mecha-browser/fence.ts'

/** A script by name; `sql` is null for a pgroll migration whose operations
 * only pgroll runs, which a ledger can hold but a directory here cannot apply. */
export interface Script { name: string; sql: string | null }

/** mecha's own steps, named as its cluster names them (cluster.cue's
 * #TenancyMigration, #GraphileMigration, #AirlockMigration and
 * #ScheduleMigration), so a directory restored from a container's database and
 * one built here read one ledger. */
export const TENANCY_SCRIPT = '003_rls.sql'
export const GRAPHILE_SCRIPT = '011_graphile_worker.sql'
export const AIRLOCK_SCRIPT = '012_airlock.sql'
export const SCHEDULE_SCRIPT = '800_schedule.sql'

/** A directory built before the ledger existed: what it holds is unknown. */
export class NoLedger extends Error {
  constructor() { super("the data directory carries no migration ledger: it predates one, so reset to load this release's") }
}
/** A script the directory applied, with other text now. */
export class ChangedScript extends Error {
  constructor(name: string) { super(`${name} changed since the data directory applied it: a change to a live schema is a pgroll migration, folded into the entities once every directory has run it; or reset`) }
}
/** A pgroll migration with an operation only pgroll runs, owed here. */
export class UnrunnableScript extends Error {
  constructor(name: string, op: string) { super(`${name}: ${op} is pgroll's to run, and pgroll does not run here`) }
}

const seed = (name: string) => name.includes('seed')
export const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function digest(sql: string | null): Promise<string | null> {
  return sql === null ? null : hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql)))
}

export interface PgRollMigration { operations: Record<string, unknown>[] }

/** One pgroll migration as SQL: each operation's raw `up`, a statement after
 * another; any other operation is pgroll's to run. */
export function pgrollSql(name: string, { operations }: PgRollMigration): string {
  return operations.map((op) => {
    const raw = op.sql as { up?: string } | undefined
    if (Object.keys(op).length !== 1 || typeof raw?.up !== 'string') throw new UnrunnableScript(name, Object.keys(op)[0])
    return raw.up
  }).join(';\n')
}

/** The pgroll set as scripts; one pgroll alone runs keeps its name and no SQL. */
export function pgrollScripts(set: Record<string, PgRollMigration>): Script[] {
  return Object.entries(set).map(([name, migration]) => {
    try {
      return { name, sql: pgrollSql(name, migration) }
    } catch (error) {
      if (error instanceof UnrunnableScript) return { name, sql: null }
      throw error
    }
  })
}

async function ledger(db: PGlite): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS public._pronto_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now());
ALTER TABLE public._pronto_migrations ADD COLUMN IF NOT EXISTS sha256 text`)
}

async function record(db: PGlite, script: Script): Promise<void> {
  await db.query('INSERT INTO public._pronto_migrations (name, sha256) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256', [script.name, await digest(script.sql)])
}

/** What a directory being built applied, by name and digest. */
export async function recordScripts(db: PGlite, scripts: Script[]): Promise<void> {
  await ledger(db)
  for (const script of scripts) await record(db, script)
}

/** The scripts a kept directory lacks, applied and recorded; their names.
 * Every recorded script is checked first, so a refusal moves nothing. */
export async function applyScripts(db: PGlite, scripts: Script[], log: (line: string) => void = console.log): Promise<string[]> {
  const present = await db.query<{ ok: boolean }>("SELECT to_regclass('public._pronto_migrations') IS NOT NULL AS ok")
  if (!present.rows[0].ok) throw new NoLedger()
  // An appliance's archive carries the ledger without digests: its scripts
  // are refused as changed until a build records them.
  await ledger(db)
  const recorded = new Map((await db.query<{ name: string; sha256: string | null }>('SELECT name, sha256 FROM public._pronto_migrations')).rows.map((r) => [r.name, r.sha256]))
  // Byte order, as a directory being built applies them.
  const owed = [...scripts].filter((s) => !seed(s.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const script of owed) {
    if (recorded.has(script.name) && recorded.get(script.name) !== await digest(script.sql)) throw new ChangedScript(script.name)
  }
  const applied: string[] = []
  for (const script of owed) {
    if (recorded.has(script.name)) continue
    if (script.sql === null) throw new UnrunnableScript(script.name, 'an operation')
    await db.exec(browserTier(script.sql))
    await record(db, script)
    log(`applied ${script.name}`)
    applied.push(script.name)
  }
  return applied
}
