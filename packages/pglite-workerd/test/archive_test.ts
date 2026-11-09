// The archive's ledger against a real pgroll ledger: Postgres 18 migrated by
// pgroll (both mecha's pinned images, as the migrate step runs them) to its
// first migration, dumped with the ledger, restored with its release's scripts,
// then given the release's set with one more. The ledger holds the file as
// given and the migration by the text pgroll recorded; only the missing one
// applies; a second run applies nothing; another release's scripts never
// restore. Needs Docker.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'
import { restore } from '../restore.ts'
import { applyScripts, digest, pgrollScripts } from '../scripts.ts'

// libraries/mecha/bayt.cue's _postgres and _pgroll.
const POSTGRES = 'postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8'
const PGROLL = 'ghcr.io/xataio/pgroll:v0.16.3@sha256:aca5425285691ed78079196c1629de039e7d7b795773b1ff63e1419d79dbd830'

async function docker(args: string[], stdin?: string): Promise<string> {
  const child = new Deno.Command('docker', { args, stdin: stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  if (stdin !== undefined) {
    const w = child.stdin.getWriter()
    await w.write(new TextEncoder().encode(stdin))
    await w.close()
  }
  const r = await child.output()
  if (!r.success) throw new Error(`docker ${args.join(' ')}: ${new TextDecoder().decode(r.stderr)}`)
  return new TextDecoder().decode(r.stdout)
}

const sql = (up: string) => ({ operations: [{ sql: { up, onComplete: true } }] })
const TEAM = { name: '005_create_tables.sql', sql: "CREATE TABLE team (id integer PRIMARY KEY, name text NOT NULL); INSERT INTO team VALUES (1, 'Flamengo');" }
const MIGRATIONS = {
  '001_add_city': sql("ALTER TABLE team ADD COLUMN city text; UPDATE team SET city = 'Rio'"),
  '002_add_country': sql("ALTER TABLE team ADD COLUMN country text NOT NULL DEFAULT 'Brazil'\n-- tier: container\nALTER TABLE team REPLICA IDENTITY FULL;\n-- tier: any\n"),
}

Deno.test('a restored directory records what its database applied and carries the rest of a release from there', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'pglite-migrate-' })
  const name = `pglite-migrate-${crypto.randomUUID().slice(0, 8)}`
  const url = 'postgres://postgres:x@127.0.0.1:5432/postgres?sslmode=disable'
  await docker(['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=x', POSTGRES])
  try {
    // Over TCP: the entrypoint's initdb runs a server on the socket alone.
    for (let i = 0; ; i++) {
      try { await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break } catch (e) { if (i > 120) throw e }
      await new Promise((r) => setTimeout(r, 500))
    }
    await docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], TEAM.sql)
    await Deno.mkdir(`${tmp}/pgroll`)
    await Deno.writeTextFile(`${tmp}/pgroll/001_add_city.json`, JSON.stringify(MIGRATIONS['001_add_city']))
    // Copied in, not bind-mounted: a daemon in another container (dind) sees
    // none of this one's /tmp, and the mount comes up empty.
    const pgroll = async (...args: string[]) => {
      const id = (await docker(['create', '--network', `container:${name}`, PGROLL, ...args, '--postgres-url', url])).trim()
      try {
        await docker(['cp', `${tmp}/pgroll`, `${id}:/pgroll`])
        await docker(['start', '-a', id])
      } finally {
        await docker(['rm', '-f', id])
      }
    }
    await pgroll('init')
    await pgroll('baseline', '000_baseline', '/tmp', '--yes')
    await pgroll('start', '/pgroll/001_add_city.json', '--complete')
    await Deno.writeTextFile(`${tmp}/dump.sql`, await docker(['exec', name, 'pg_dump', '-h', '127.0.0.1', '-U', 'postgres', '--schema=public', '--schema=pgroll', '--no-owner', '--no-publications', '--no-subscriptions']))
    const [city, country] = pgrollScripts(MIGRATIONS)
    await assert.rejects(() => restore(`${tmp}/dump.sql`, `${tmp}/other`, [], [TEAM, city, country], () => {}), /names 002_add_country, which the archive's pgroll ledger never completed/)
    await Deno.remove(`${tmp}/other`, { recursive: true })
    await restore(`${tmp}/dump.sql`, `${tmp}/pgdata`, [], [TEAM, city], () => {})

    const db = await PGlite.create({ dataDir: `${tmp}/pgdata`, icuDataDir: await icuDataDir() })
    try {
      assert.deepEqual(
        (await db.query('SELECT name, sha256 FROM public._pronto_migrations ORDER BY name')).rows,
        [{ name: '001_add_city', sha256: await digest(city.sql) }, { name: '005_create_tables.sql', sha256: await digest(TEAM.sql) }],
      )
      assert.deepEqual(await applyScripts(db, [TEAM, city, country], () => {}), ['002_add_country'])
      assert.deepEqual((await db.query('SELECT name, city, country FROM team')).rows, [{ name: 'Flamengo', city: 'Rio', country: 'Brazil' }])
      assert.deepEqual(await applyScripts(db, [TEAM, city, country], () => {}), [])
    } finally {
      await db.close()
    }
  } finally {
    await docker(['rm', '-f', name])
    await Deno.remove(tmp, { recursive: true })
  }
})
