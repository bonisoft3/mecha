// restore.ts against a real pg_dump: Postgres 18 (mecha's pinned image) holds a
// table with a policy for a role the dump does not carry, an ICU collation, a
// trigger and rows COPY must keep byte for byte; its plain dump, restored after
// the roles, answers the same in PGlite. Needs Docker.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'
import { restore } from '../restore.ts'

// libraries/mecha/bayt.cue's _postgres.
const POSTGRES = 'postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8'

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

const ROLES = 'CREATE ROLE app_user NOLOGIN;'
const SCHEMA = `${ROLES}
CREATE COLLATION search (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
CREATE TABLE team (id integer PRIMARY KEY, name text NOT NULL, search_name text COLLATE search GENERATED ALWAYS AS (name) STORED, note text);
CREATE FUNCTION shout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := upper(NEW.note); RETURN NEW; END $$;
CREATE TRIGGER shout BEFORE INSERT OR UPDATE ON team FOR EACH ROW EXECUTE FUNCTION shout();
ALTER TABLE team ENABLE ROW LEVEL SECURITY;
CREATE POLICY even ON team FOR SELECT TO app_user USING (id % 2 = 0);
GRANT SELECT ON team TO app_user;
INSERT INTO team (id, name, note) SELECT n, CASE WHEN n = 1 THEN 'Grêmio-RS' ELSE 'team ' || n END, E'tab\\there' FROM generate_series(1, 1000) n;
`

Deno.test('a pg_dump restores into a PGlite data directory', async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'pglite-restore-' })
  const name = `pglite-restore-${crypto.randomUUID().slice(0, 8)}`
  await docker(['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=x', POSTGRES])
  try {
    // Over TCP: the entrypoint's initdb runs a server on the socket alone,
    // which answers and then shuts down.
    for (let i = 0; ; i++) {
      try { await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break } catch (e) { if (i > 120) throw e }
      await new Promise((r) => setTimeout(r, 500))
    }
    await docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], SCHEMA)
    await Deno.writeTextFile(`${tmp}/dump.sql`, await docker(['exec', name, 'pg_dump', '-h', '127.0.0.1', '-U', 'postgres', '--schema=public', '--no-owner', '--no-publications', '--no-subscriptions']))
    await Deno.writeTextFile(`${tmp}/roles.sql`, ROLES)
    await restore(`${tmp}/dump.sql`, `${tmp}/pgdata`, [`${tmp}/roles.sql`], () => {})

    const db = await PGlite.create({ dataDir: `${tmp}/pgdata`, icuDataDir: await icuDataDir() })
    try {
      assert.deepEqual((await db.query('SELECT count(*)::int n FROM team')).rows, [{ n: 1000 }])
      assert.deepEqual((await db.query("SELECT name, note FROM team WHERE search_name = 'GREMIO-rs'")).rows, [{ name: 'Grêmio-RS', note: 'TAB\tHERE' }])
      assert.deepEqual((await db.query("UPDATE team SET note = 'quiet' WHERE id = 2 RETURNING note")).rows, [{ note: 'QUIET' }])
      await db.exec('SET ROLE app_user')
      assert.deepEqual((await db.query('SELECT count(*)::int n FROM team')).rows, [{ n: 500 }])
    } finally {
      await db.close()
    }
  } finally {
    await docker(['rm', '-f', name])
    await Deno.remove(tmp, { recursive: true })
  }
})
