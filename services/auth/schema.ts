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

export type AuthTable =
  | "webauthn_credential"
  | "identity_link"
  | "auth_native_ticket"
  | "auth_refresh_token";

export const AUTH_TABLES: AuthTable[] = [
  "webauthn_credential",
  "identity_link",
  "auth_native_ticket",
  "auth_refresh_token",
];

// Only tables that existed in public before mecha_auth keep a compatibility view.
const LEGACY_PUBLIC_TABLES: AuthTable[] = ["webauthn_credential", "identity_link"];

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
    name text,
    picture text,
    email text,
    created_at timestamptz not null default now(),
    primary key (provider, issuer, sub)`,
  auth_native_ticket: `
    id text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    provider text not null,
    issuer text not null,
    code_challenge text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()`,
  auth_refresh_token: `
    token_hash text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    family_id uuid not null,
    expires_at timestamptz not null,
    replaced_by text,
    revoked_at timestamptz,
    created_at timestamptz not null default now()`,
};

const list = (tables: AuthTable[]) => `ARRAY[${tables.map((t) => `'${t}'`).join(", ")}]::text[]`;

/** Reassigns rows owned by `guest_id` across public tables referencing `app_user(id)`
 * (or defaulting a uuid owner column to `auth_uid()`) onto `target_id`, dropping
 * unique collisions `target_id` already holds before removing the guest row. */
const ADOPT_GUEST_SQL = `
CREATE OR REPLACE FUNCTION mecha_auth.adopt_guest(guest_id uuid, target_id uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $adopt$
DECLARE
  r record;
  dup record;
BEGIN
  IF guest_id IS NULL OR target_id IS NULL OR guest_id = target_id THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.attname AS col
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname <> 'app_user'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attgenerated = ''
      AND (
        EXISTS (
          SELECT 1 FROM pg_constraint con
          JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = con.confkey[1]
          WHERE con.conrelid = c.oid
            AND con.contype = 'f'
            AND con.confrelid = to_regclass('public.app_user')
            AND array_length(con.conkey, 1) = 1
            AND con.conkey[1] = a.attnum
            AND fa.attname = 'id'
        )
        OR (
          a.atttypid = 'uuid'::regtype
          AND d.oid IS NOT NULL
          AND pg_get_expr(d.adbin, d.adrelid) LIKE '%auth_uid()%'
        )
      )
    ORDER BY 1, 2
  LOOP
    BEGIN
      EXECUTE format('UPDATE public.%I SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col)
        USING target_id, guest_id;
    EXCEPTION WHEN unique_violation THEN
      FOR dup IN EXECUTE format('SELECT tableoid, ctid FROM public.%I WHERE %I = $1', r.tbl, r.col) USING guest_id LOOP
        BEGIN
          EXECUTE format('UPDATE public.%I SET %I = $1 WHERE tableoid = $2 AND ctid = $3', r.tbl, r.col)
            USING target_id, dup.tableoid, dup.ctid;
        EXCEPTION WHEN unique_violation THEN
          EXECUTE format('DELETE FROM public.%I WHERE tableoid = $1 AND ctid = $2', r.tbl)
            USING dup.tableoid, dup.ctid;
        END;
      END LOOP;
    END;
  END LOOP;
  DELETE FROM public.app_user WHERE id = guest_id;
END;
$adopt$;
`;

/** Makes mecha_auth and the tables in it, moving any an earlier release left in public. */
export function prepareAuthTables(tables: AuthTable[] = AUTH_TABLES): string {
  const indexes = tables.includes("auth_refresh_token")
    ? `
CREATE INDEX IF NOT EXISTS auth_refresh_token_family_idx ON mecha_auth.auth_refresh_token (family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_token_user_idx ON mecha_auth.auth_refresh_token (user_id);`
    : "";
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
${tables.map((t) => `CREATE TABLE IF NOT EXISTS mecha_auth.${t} (${columns[t]}\n);`).join("\n")}${indexes}
${ADOPT_GUEST_SQL}`;
}

/**
 * Takes back every privilege anyone but the owner holds on mecha_auth, on the
 * tables and on their columns, grant chains included, then names the old
 * views and tells the audit the tables are the service's own.
 */
export function sealAuthTables(tables: AuthTable[] = AUTH_TABLES): string {
  const legacyViews = tables.filter((t) => LEGACY_PUBLIC_TABLES.includes(t));
  return `
DO $auth$
DECLARE t text; g record;
BEGIN
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA mecha_auth FROM PUBLIC CASCADE;
  FOR g IN
    SELECT 'SCHEMA mecha_auth' AS target, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'mecha_auth' AND a.grantee <> n.nspowner
    UNION SELECT format('mecha_auth.%I', c.relname), a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relnamespace = 'mecha_auth'::regnamespace AND a.grantee <> c.relowner
    UNION SELECT format('(%I) ON mecha_auth.%I', at.attname, c.relname), a.grantee
      FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid, aclexplode(at.attacl) a
      WHERE c.relnamespace = 'mecha_auth'::regnamespace AND at.attnum > 0 AND NOT at.attisdropped AND a.grantee <> c.relowner
    UNION SELECT format('FUNCTION %s', p.oid::regprocedure), a.grantee
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.pronamespace = 'mecha_auth'::regnamespace AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL %s FROM %s CASCADE',
      CASE WHEN g.target LIKE '(%' THEN g.target ELSE 'ON ' || g.target END,
      CASE g.grantee WHEN 0 THEN 'PUBLIC' ELSE g.grantee::regrole::text END);
  END LOOP;
  FOREACH t IN ARRAY ${list(legacyViews)} LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      EXECUTE format('CREATE VIEW public.%I WITH (security_invoker = true) AS SELECT * FROM mecha_auth.%I', t, t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ${list(tables)} LOOP
    INSERT INTO mecha.rls_exempt VALUES ('mecha_auth.' || t, 'the auth service''s own table, in a schema no app role may use')
      ON CONFLICT DO NOTHING;
  END LOOP;
END $auth$;
`;
}
