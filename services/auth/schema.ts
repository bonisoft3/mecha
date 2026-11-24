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
  | "webauthn_challenge"
  | "auth_native_ticket"
  | "auth_refresh_token"
  | "account_recovery";

export const AUTH_TABLES: AuthTable[] = [
  "webauthn_credential",
  "identity_link",
  "webauthn_challenge",
  "auth_native_ticket",
  "auth_refresh_token",
  "account_recovery",
];

// Only tables that existed in public before mecha_auth keep a compatibility view.
const LEGACY_PUBLIC_TABLES: AuthTable[] = ["webauthn_credential", "identity_link"];

const columns: Record<AuthTable, string> = {
  webauthn_credential: `
    id text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    public_key bytea not null,
    counter bigint not null default 0,
    created_at timestamptz default now()`,
  identity_link: `
    provider text not null,
    issuer text not null,
    sub text not null,
    user_id uuid not null references public.app_user(id) on delete cascade,
    name text,
    picture text,
    email text,
    created_at timestamptz not null default now(),
    primary key (provider, issuer, sub)`,
  // A sign-in's challenge, spent: its state token is stateless, so a passkey's
  // answer to it would sign in again until the token expires.
  webauthn_challenge: `
    challenge text primary key,
    expires_at timestamptz not null`,
  auth_native_ticket: `
    id text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    provider text not null,
    issuer text not null,
    sub text,
    code_challenge text not null,
    proof jsonb,
    held boolean not null default false,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()`,
  auth_refresh_token: `
    token_hash text primary key,
    user_id uuid not null references public.app_user(id) on delete cascade,
    family_id uuid not null,
    proof jsonb,
    way jsonb,
    expires_at timestamptz not null,
    replaced_by text,
    revoked_at timestamptz,
    created_at timestamptz not null default now()`,
  // What asking to set up recovery knows of an account: when it first had an
  // external effect, and how often Not now was answered.
  account_recovery: `
    user_id uuid primary key references public.app_user(id) on delete cascade,
    effected_at timestamptz,
    declines int not null default 0,
    ask_after timestamptz`,
};

const list = (tables: AuthTable[]) => `ARRAY[${tables.map((t) => `'${t}'`).join(", ")}]::text[]`;
/** Columns later releases added to tables an earlier one made: a profile's
 * name, picture and address on a link; how a native ticket's or a refresh
 * family's sign-in was made, and which way (and subject) it came in by; when a passkey was
 * added. A row from before them says none of it, and renews or redeems
 * nothing. An account holds a link per provider (LINK_PER_PROVIDER), so the
 * one-per-account constraint goes. */
export const EVOLVE_AUTH_TABLES = `
ALTER TABLE mecha_auth.identity_link ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS picture text, ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE mecha_auth.identity_link DROP CONSTRAINT IF EXISTS identity_link_user_id_key;
ALTER TABLE mecha_auth.webauthn_credential ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE mecha_auth.webauthn_credential ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE mecha_auth.auth_refresh_token ADD COLUMN IF NOT EXISTS proof jsonb,
  ADD COLUMN IF NOT EXISTS way jsonb;
ALTER TABLE mecha_auth.auth_native_ticket ADD COLUMN IF NOT EXISTS proof jsonb,
  ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS sub text;`;

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
-- A guest signing in to an account another holds is held, never merged.
DROP FUNCTION IF EXISTS mecha_auth.adopt_guest(uuid, uuid);`
}

/** One link per account and provider: a session's way names its provider,
 * never a second subject of it, which would outlive the first's removal. Run
 * once every link names its issuer. */
export const LINK_PER_PROVIDER =
  `CREATE UNIQUE INDEX IF NOT EXISTS identity_link_user_provider_idx ON mecha_auth.identity_link (user_id, provider, issuer);`;

/** The account an external effect was asked for, stamped where the airlock
 * claims it: the ledger's insert runs in the writer's transaction, under the
 * claims of the request that moved the machine, so a person's write stamps
 * their account and the service's own moves stamp none. Set up recovery is
 * asked of an account so stamped (core.ts). A cluster with no ledger has no
 * external effects to stamp. */
export const STAMP_EFFECTS = `
CREATE OR REPLACE FUNCTION mecha_auth.effect_requested() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $stamp$
DECLARE claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
BEGIN
  -- A subject naming no account stamps none, and never fails the effect.
  IF claims->>'role' = 'app_user' AND claims->>'sub' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    INSERT INTO mecha_auth.account_recovery (user_id, effected_at)
      SELECT u.id, now() FROM public.app_user u WHERE u.id = (claims->>'sub')::uuid
      ON CONFLICT (user_id) DO UPDATE SET effected_at = coalesce(account_recovery.effected_at, excluded.effected_at);
  END IF;
  RETURN NULL;
END $stamp$;
DO $stamp$ BEGIN
  IF to_regclass('airlock.external_effect_ledger') IS NOT NULL THEN
    CREATE OR REPLACE TRIGGER mecha_auth_effect_requested AFTER INSERT ON airlock.external_effect_ledger
      FOR EACH ROW EXECUTE FUNCTION mecha_auth.effect_requested();
  END IF;
END $stamp$;`;

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
