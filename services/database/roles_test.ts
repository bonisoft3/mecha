import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { pgTest, postgres } from "../compute/pg-test.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const migration = await Deno.readTextFile(`${here}migrations/001_roles.sql`);
const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();
async function query(url: string, sql: string, ownership = "framework") {
  const child = new Deno.Command("psql", {
    args: [url, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA"],
    env: { PGOPTIONS: `-c mecha.roles=${ownership}` }, stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();
  const result = await child.output();
  return { ok: result.success, out: decode(result.stdout), err: decode(result.stderr) };
}
async function must(url: string, sql: string, ownership = "framework") {
  const r = await query(url, sql, ownership);
  assert(r.ok, r.err);
  return r.out;
}
const state = `SELECT jsonb_build_object(
 'roles', (SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_authid r),
 'members', (SELECT jsonb_agg(to_jsonb(m) ORDER BY oid) FROM pg_auth_members m),
 'settings', (SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase, setrole) FROM pg_db_role_setting s));`;

Deno.test("the standalone role migration is generated from the shared ownership contract", async () => {
  const result = await new Deno.Command("cue", { args: ["export", ".:cluster", "-e", "RolesMigration.out", "--out", "text"], cwd: root, stdout: "piped", stderr: "piped" }).output();
  assert(result.success, decode(result.stderr));
  assert.equal(new TextDecoder().decode(result.stdout), migration);
});

pgTest("external role ownership validates without repairing, regardless of the caller's privilege", async () => {
  await using pg = await postgres();
  await must(pg.url, migration);
  await must(pg.url, migration);
  await must(pg.url, "CREATE ROLE migrator LOGIN; ALTER ROLE anon SET statement_timeout = 5000;");
  await must(pg.url, "ALTER DATABASE postgres SET statement_timeout = '99s';");
  const limited = pg.url.replace("postgres@", "migrator@");
  let before = await must(pg.url, state);
  await must(limited, migration, "external");
  await must(pg.url, migration, "external");
  assert.equal(await must(pg.url, state), before);
  const refused = async (change: string, restore: string, message: RegExp) => {
    await must(pg.url, change);
    before = await must(pg.url, state);
    for (const url of [limited, pg.url]) {
      const r = await query(url, migration, "external");
      assert.equal(r.ok, false);
      assert.match(r.err, message);
      assert.equal(await must(pg.url, state), before);
    }
    await must(pg.url, restore);
  };
  await refused("ALTER ROLE electric NOREPLICATION", "ALTER ROLE electric REPLICATION", /electric.*rolreplication/);
  await refused("ALTER ROLE authenticator INHERIT", "ALTER ROLE authenticator NOINHERIT", /authenticator.*rolinherit/);
  await refused("ALTER ROLE anon BYPASSRLS", "ALTER ROLE anon NOBYPASSRLS", /anon.*rolbypassrls/);
  await refused("ALTER ROLE anon SET statement_timeout = '6s'", "ALTER ROLE anon SET statement_timeout = '5s'", /anon.*statement_timeout/);
  await refused("ALTER ROLE anon IN DATABASE postgres SET statement_timeout = '6s'", "ALTER ROLE anon IN DATABASE postgres RESET statement_timeout", /anon.*database override/);
  await refused("ALTER ROLE anon RENAME TO elsewhere", "ALTER ROLE elsewhere RENAME TO anon", /anon.*missing/);
  await refused("GRANT anon TO authenticator WITH SET FALSE", "GRANT anon TO authenticator WITH SET TRUE", /authenticator.*SET membership.*anon/);
  await refused("GRANT anon TO authenticator WITH ADMIN TRUE", "REVOKE ADMIN OPTION FOR anon FROM authenticator", /authenticator.*ADMIN/);
  await must(pg.url, "CREATE ROLE grantor; GRANT anon TO grantor WITH ADMIN TRUE;");
  await refused("GRANT anon TO authenticator WITH INHERIT TRUE, SET TRUE GRANTED BY grantor", "REVOKE anon FROM authenticator GRANTED BY grantor", /authenticator.*INHERIT/);
  await refused("GRANT grantor TO authenticator", "REVOKE grantor FROM authenticator", /authenticator.*unexpected membership/);
  await refused("GRANT service TO anon", "REVOKE service FROM anon", /anon.*unexpected membership/);
  const badMode = await query(pg.url, migration, "externl");
  assert.equal(badMode.ok, false);
  assert.match(badMode.err, /must be framework or external/);
});

pgTest("external passwords are untouched by the container step, even with privileged credentials", async () => {
  await using pg = await postgres();
  await must(pg.url, migration);
  await must(pg.url, "ALTER ROLE electric PASSWORD 'before'; ALTER ROLE authenticator PASSWORD 'before';");
  const before = await must(pg.url, state);
  const result = await new Deno.Command("bash", {
    args: ["-ec", 'docker_process_sql() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }; source "$ROLE_PASSWORDS"'],
    env: { DATABASE_URL: pg.url, ROLE_PASSWORDS: `${here}role_passwords.sh`, PGOPTIONS: "-c mecha.roles=external", ELECTRIC_PASSWORD: "after", AUTHENTICATOR_PASSWORD: "after" },
    stdout: "piped", stderr: "piped",
  }).output();
  assert(result.success, decode(result.stderr));
  assert.equal(await must(pg.url, state), before);
});

pgTest("the shared validator preserves keyword and mixed-case token role names", async () => {
  await using pg = await postgres();
  await must(pg.url, migration);
  await must(pg.url, 'CREATE ROLE "select"; CREATE ROLE "Mixed"; GRANT "select", "Mixed" TO authenticator WITH INHERIT FALSE, SET TRUE;');
  const template = await Deno.readTextFile(`${here}roles-template.sql`);
  const contract = { roles: { select: { attributes: { rolcanlogin: false }, settings: {} }, Mixed: { attributes: { rolcanlogin: false }, settings: {} } }, memberships: { authenticator: ["select", "Mixed"] } };
  const sql = template.replace("@@CONTRACT@@", JSON.stringify(contract)).replace("@@MANAGED@@", "SELECT 1;");
  const before = await must(pg.url, state);
  await must(pg.url, sql, "external");
  assert.equal(await must(pg.url, state), before);
});

pgTest("the native initdb password step also respects external ownership", async () => {
  const work = await Deno.makeTempDir();
  const init = `${work}/init`;
  await Deno.mkdir(init);
  await Deno.writeTextFile(`${init}/000_premade.sql`, `SET mecha.roles = framework;\n${migration}
ALTER ROLE electric PASSWORD 'before'; ALTER ROLE authenticator PASSWORD 'before';
CREATE TABLE password_snapshot AS SELECT rolname, rolpassword FROM pg_authid;
`);
  await Deno.writeTextFile(`${init}/001_roles.sql`, migration);
  await Deno.copyFile(`${here}role_passwords.sh`, `${init}/899_role_passwords.sh`);
  await Deno.writeTextFile(`${init}/999_check.sql`, `DO $$ BEGIN
IF EXISTS (SELECT FROM pg_authid a JOIN password_snapshot b USING (rolname) WHERE a.rolpassword IS DISTINCT FROM b.rolpassword) THEN
RAISE EXCEPTION 'native password step changed externally managed passwords'; END IF; END $$;
CREATE TABLE roles_checked (ok boolean); INSERT INTO roles_checked VALUES (true);`);
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const process = new Deno.Command("nu", {
    args: [`${here}entrypoint.nu`, init],
    env: { BAYT_LOCAL_WORK_DIR: work, PGPORT: String(port), POSTGRES_USER: "postgres", POSTGRES_DB: "postgres", PGOPTIONS: "-c mecha.roles=external", ELECTRIC_PASSWORD: "after", AUTHENTICATOR_PASSWORD: "after" },
    stdout: "piped", stderr: "piped",
  }).spawn();
  const finished = process.output();
  let ended = false;
  void finished.then(() => { ended = true; });
  try {
    const until = Date.now() + 30_000;
    while (true) {
      const r = await query(`postgresql://postgres@127.0.0.1:${port}/postgres`, "SELECT ok FROM roles_checked;", "external");
      if (r.ok) { assert.equal(r.out, "t"); break; }
      if (ended) { const output = await finished; throw new Error(decode(output.stderr)); }
      if (Date.now() >= until) throw new Error("native role initialization did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    if (!ended) {
      const dirs = [];
      for await (const entry of Deno.readDir(work)) if (entry.name.startsWith("pg-")) dirs.push(`${work}/${entry.name}`);
      for (const dir of dirs) {
        const stop = await new Deno.Command("pg_ctl", { args: ["-D", dir, "-m", "immediate", "-w", "stop"], stdout: "null", stderr: "piped" }).output();
        assert(stop.success, decode(stop.stderr));
      }
    }
    await finished;
    await Deno.remove(work, { recursive: true });
  }
});
