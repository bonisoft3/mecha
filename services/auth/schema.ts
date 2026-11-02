// Where the auth tables live, as SQL both auth implementations run: the host
// service on Postgres (main.ts, migrate) and the edge cluster on PGlite
// (packages/mecha-edge/src/cluster.ts).
//
// The passkeys and links decide who signs in as whom, so they live in
// mecha_auth, a schema no app role may use. An app grants every table in
// public (mecha's 002_grants, pronto's emitted grants and default privileges)
// and the CRUD API serves public, BYPASSRLS roles included, so neither a
// revoke nor row security there outlasts the next such grant; nothing grants
// on mecha_auth, and sealAuthTables takes back whatever did at every start.
//
// A table an earlier release made in public moves with its rows, and a
// security_invoker view keeps the old name: an earlier release still running
// reads and writes through it, one starting again fails at its ALTER TABLE
// rather than making empty tables, and an app role reaching the view is
// refused at mecha_auth.

export type AuthTable = "webauthn_credential" | "identity_link";

const columns: Record<AuthTable, string> = {
  webauthn_credential: `
    id text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    public_key bytea not null,
    counter bigint not null default 0`,
  identity_link: `
    provider text not null,
    issuer text not null,
    sub text not null,
    user_id uuid not null unique references public.app_user(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (provider, issuer, sub)`,
};

const list = (tables: AuthTable[]) => `ARRAY[${tables.map((t) => `'${t}'`).join(", ")}]`;

/** Makes mecha_auth and the tables in it, moving any an earlier release left in public. */
export function prepareAuthTables(tables: AuthTable[]): string {
  return `
DO $auth$
DECLARE t text; kind "char";
BEGIN
  CREATE SCHEMA IF NOT EXISTS mecha_auth;
  FOREACH t IN ARRAY ${list(tables)} LOOP
    SELECT c.relkind INTO kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t;
    IF kind = 'r' THEN
      IF to_regclass('mecha_auth.' || t) IS NOT NULL THEN
        RAISE EXCEPTION '% is in both public and mecha_auth: keep the one holding the live rows and drop the other', t;
      END IF;
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA mecha_auth', t);
      DELETE FROM mecha.rls_exempt WHERE table_name = 'public.' || t;
    ELSIF kind = 'v' THEN
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.' || t) AND reloptions @> ARRAY['security_invoker=true']) THEN
        RAISE EXCEPTION 'public.% is a view without security_invoker, not the auth service''s', t;
      END IF;
    ELSIF kind IS NOT NULL THEN
      RAISE EXCEPTION 'public.% is a %, neither the table an earlier release made nor the auth service''s view', t, kind;
    END IF;
  END LOOP;
END $auth$;
${tables.map((t) => `CREATE TABLE IF NOT EXISTS mecha_auth.${t} (${columns[t]}\n);`).join("\n")}
`;
}

/**
 * Takes back every privilege anyone but the owner holds on mecha_auth, on the
 * tables and on their columns, grant chains included, then names the old
 * views and tells the audit the tables are the service's own.
 */
export function sealAuthTables(tables: AuthTable[]): string {
  return `
DO $auth$
DECLARE t text; g record;
BEGIN
  FOR g IN
    SELECT 'SCHEMA mecha_auth' AS target, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'mecha_auth' AND a.grantee <> n.nspowner
    UNION SELECT format('mecha_auth.%I', c.relname), a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relnamespace = 'mecha_auth'::regnamespace AND a.grantee <> c.relowner
    UNION SELECT format('(%I) ON mecha_auth.%I', at.attname, c.relname), a.grantee
      FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid, aclexplode(at.attacl) a
      WHERE c.relnamespace = 'mecha_auth'::regnamespace AND at.attnum > 0 AND NOT at.attisdropped AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL %s FROM %s CASCADE',
      CASE WHEN g.target LIKE '(%' THEN g.target ELSE 'ON ' || g.target END,
      CASE g.grantee WHEN 0 THEN 'PUBLIC' ELSE g.grantee::regrole::text END);
  END LOOP;
  FOREACH t IN ARRAY ${list(tables)} LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      EXECUTE format('CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT * FROM mecha_auth.%I', t, t);
    END IF;
    INSERT INTO mecha.rls_exempt VALUES ('mecha_auth.' || t, 'the auth service''s own table, in a schema no app role may use')
      ON CONFLICT DO NOTHING;
  END LOOP;
END $auth$;
`;
}
