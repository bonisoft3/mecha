// A PGlite data directory from a plain pg_dump of a Postgres database, for a
// database too big to rebuild from its migrations (an archive): the roles its
// grants and policies name first — a dump carries none — then the dump. psql's
// `COPY … FROM stdin` blocks become COPY from PGlite's /dev/blob, a batch of
// rows at a time; pg_dump's \restrict and \unrestrict guards are psql's alone.
// Runs npm's PGlite with the full ICU set: a directory on disk needs Node's
// filesystem, which the workerd build leaves out, and it is the same Postgres.
//
//   deno run -A restore.ts <dump.sql> <pgdata-dir> [--roles <sql>]…
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

/** Closes a data directory for shipping: a checkpoint recycles the spent WAL
 * segments into pre-allocated future ones (a GiB after a restore), which no
 * checkpoint removes, so with the server stopped every segment past the one
 * holding the insert position goes; Postgres makes them as it needs them. */
export async function closeTrimmed(db: PGlite, pgdata: string) {
  await db.exec('CHECKPOINT')
  const current = (await db.query<{ f: string }>('SELECT pg_walfile_name(pg_current_wal_insert_lsn()) f')).rows[0].f
  await db.close()
  for (const e of Deno.readDirSync(`${pgdata}/pg_wal`)) {
    if (/^[0-9A-F]{24}$/.test(e.name) && e.name > current) Deno.removeSync(`${pgdata}/pg_wal/${e.name}`)
  }
}

// Rows per COPY: bounds what one batch holds in memory, here and in the wasm.
const BATCH = 200_000

export async function restore(dump: string, pgdata: string, roles: string[], log: (line: string) => void = console.log) {
  // A fresh directory: PGlite runs initdb into it, and an existing one throws here.
  Deno.mkdirSync(pgdata)
  const t0 = performance.now()
  const lap = (what: string) => log(`${((performance.now() - t0) / 1000).toFixed(1)}s ${what}`)
  const db = await PGlite.create({ dataDir: pgdata, icuDataDir: await icuDataDir() })
  for (const sql of roles) await db.exec(await Deno.readTextFile(sql))
  // The dump's index builds over millions of rows.
  await db.exec(`SET maintenance_work_mem = '256MB'`)

  let sql: string[] = []
  let copy: { head: string; rows: string[]; total: number } | null = null
  const flushSql = async () => {
    if (sql.length === 0) return
    const text = sql.join('\n')
    sql = []
    await db.exec(text)
  }
  const flushCopy = async () => {
    if (!copy || copy.rows.length === 0) return
    await db.query(`${copy.head} FROM '/dev/blob'`, [], { blob: new Blob(copy.rows) })
    copy.total += copy.rows.length
    copy.rows = []
  }
  const line = async (l: string) => {
    if (copy) {
      if (l === '\\.') {
        await flushCopy()
        if (copy.total >= BATCH) lap(`${copy.head} (${copy.total} rows)`)
        copy = null
      } else {
        copy.rows.push(l + '\n')
        if (copy.rows.length >= BATCH) await flushCopy()
      }
      return
    }
    const m = /^(COPY .+) FROM stdin;$/.exec(l)
    if (m) {
      await flushSql()
      copy = { head: m[1], rows: [], total: 0 }
      return
    }
    if (/^\\(un)?restrict /.test(l)) return
    // Named with --schema, public is dumped as created; initdb made it.
    if (l === 'CREATE SCHEMA public;') {
      sql.push('CREATE SCHEMA IF NOT EXISTS public;')
      return
    }
    if (l.startsWith('\\')) throw new Error(`unhandled psql meta-command: ${l}`)
    sql.push(l)
  }
  let pending = ''
  for await (const chunk of (await Deno.open(dump)).readable.pipeThrough(new TextDecoderStream())) {
    pending += chunk
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      await line(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
  }
  if (pending) await line(pending)
  if (copy) throw new Error(`dump ends inside ${(copy as { head: string }).head}`)
  await flushSql()
  lap('dump restored')
  await db.exec('VACUUM ANALYZE')
  await closeTrimmed(db, pgdata)
  lap('VACUUM ANALYZE, CHECKPOINT, WAL trimmed')
}

if (import.meta.main) {
  const args = [...Deno.args]
  const roles: string[] = []
  for (let i = args.indexOf('--roles'); i >= 0; i = args.indexOf('--roles')) roles.push(...args.splice(i, 2).slice(1))
  const [dump, pgdata] = args
  if (!dump || !pgdata || args.length !== 2) throw new Error('usage: restore.ts <dump.sql> <pgdata-dir> [--roles <sql>]…')
  await restore(dump, pgdata, roles)
}
