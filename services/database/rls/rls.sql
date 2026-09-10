-- The tenancy floor: the row-level isolation every mecha database has, whatever
-- generated the tables above it.
--
-- Permissive policies OR together; restrictive policies AND with everything; a
-- table with RLS enabled and no permissive policy denies all. So a restrictive
-- policy is a floor nothing above it can widen, and the design rests on that:
-- a bug in the generated rules layer is an outage, never a breach.
--
-- The policy text lives here and nowhere else. A generator emits
-- `CALL rls_protect('<table>')`, never the policy itself, so it cannot emit a
-- subtly wrong one and a correction reaches every app by migration.

-- The one thing that grants breadth, so its failure modes are the ones that
-- matter: it fails closed on an unset GUC, and drops empty elements rather than
-- minting a '' scope that would match everything. Assertions 6 and 19 say why.
-- STABLE so Postgres evaluates it once per statement and not once per row.
CREATE OR REPLACE FUNCTION public.current_scopes() RETURNS text[]
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(
      array(SELECT s FROM unnest(
        string_to_array(current_setting('app.scopes', true), ',')) AS s
        WHERE s <> ''),
      '{}'::text[])
  $$;

-- The scopes a subject holds, derived in one place because two tiers read it:
-- PostgREST through `app_pre_request` below, and the sync path's gatekeeper,
-- which cannot share the GUC because it answers before the request exists. Two
-- derivations would be two answers to "how far does this subject reach".
--
-- `public:` is held by everyone, signed in or not, so a public row is reached by
-- carrying that scope rather than by being exempt from the floor. That is what
-- lets a public table sync: a shape predicate can name a scope, and cannot name
-- an exception.
--
CREATE OR REPLACE FUNCTION public.subject_scopes(uid text) RETURNS text[]
  LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN uid IS NULL OR uid = '' THEN ARRAY['public:']
                ELSE ARRAY['public:', 'user:' || uid] END
  $$;

-- The caller supplies `scope_id`: its derivation differs per access mode and
-- belongs to whoever declared the entity. Prefer a generated column --
-- `scope_id text GENERATED ALWAYS AS ('user:' || owner) STORED` -- because
-- Postgres then refuses a client-supplied value, so the derivation cannot be
-- made to lie without a trigger to defend it.
--
-- The missing TO clause and the FORCE are both deliberate and both invisible to
-- a reader who does not know to look for them; assertions 16 and 17 say why. A
-- role that must see across scopes takes BYPASSRLS, which is a row in pg_roles
-- and so auditable, rather than an absence from a TO list, which is not.
--
-- The other sanctioned reach across scopes is the emitted validation trigger,
-- `<table>_validate()`: SECURITY DEFINER, owned by the migration role, fired
-- AFTER INSERT OR UPDATE. AFTER, so only a write the caller's own policies
-- already admitted reaches the definer's read: a caller who cannot write the
-- row cannot use the predicate as an oracle over rows they cannot see. It reads
-- the rows an entity's declared `via` edges name -- one query per edge, joined
-- on the referenced id -- and answers once per write. The refusal it raises
-- carries only `validation <table>.<name>`, never a row, so the reach discloses
-- one bit per admitted write and nothing else. Its precondition: the migration
-- role must bypass RLS, as a superuser or a role holding BYPASSRLS. Where it
-- does not, FORCE ROW LEVEL SECURITY scopes the definer's read by the CALLER's
-- app.scopes and the trigger judges what the writer can see rather than what
-- stands -- so the emitted 008_validations.sql opens with a DO block that
-- refuses to install under a role holding neither.
DROP PROCEDURE IF EXISTS public.rls_protect(regclass, text);
-- Whether a table carries a scope the floor can read: the column, NOT NULL.
-- The floor's precondition and the gate's answer to "can this table carry a
-- scoped shape" are this one question. NULL for no table is false.
CREATE OR REPLACE FUNCTION public.has_scope(tbl regclass) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = tbl AND a.attname = 'scope_id'
                      AND a.attnotnull AND NOT a.attisdropped)
  $$;

CREATE OR REPLACE PROCEDURE public.rls_protect(tbl regclass)
  LANGUAGE plpgsql
  -- A policy binds its function references when it is created, and binds them
  -- permanently. Without the pin the caller's search_path at CALL time decides
  -- which `current_scopes()` the floor calls, for the life of the policy.
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT public.has_scope(tbl) THEN
    RAISE EXCEPTION
      'rls_protect(%): scope_id must exist and be NOT NULL -- a NULL scope fails '
      '= ANY(), so the row is invisible to every role while the audit reports the '
      'table protected', tbl;
  END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenancy ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenancy ON %s AS RESTRICTIVE FOR ALL '
    'USING (scope_id = ANY(current_scopes())) '
    'WITH CHECK (scope_id = ANY(current_scopes()))', tbl);
END $$;

-- PostgREST calls this once per request, in the request's transaction, after
-- switching to the request role. It is what makes current_scopes() a constant
-- for the statement rather than a subquery per row.
--
-- It must exist wherever PGRST_DB_PRE_REQUEST names it, and that setting is
-- unconditional for a server app -- so it cannot be conditional either, which
-- rules out emitting it per app. It can live here because it reads one setting
-- and writes another and depends on nothing an app declares.
--
-- Not SECURITY DEFINER: it reaches no table.
CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  sub text := nullif(current_setting('request.jwt.claims', true)::json->>'sub', '');
BEGIN
  IF sub LIKE '%,%' THEN
    RAISE EXCEPTION 'jwt sub contains a comma, which would split into two scopes';
  END IF;
  PERFORM set_config('app.scopes',
    array_to_string(public.subject_scopes(sub), ','), true);
END $$;

-- Tables the floor cannot cover, declared rather than discovered.
--
-- A restrictive policy is tenancy isolation, and some visibility is finer than
-- tenancy: a per-object share grants one row to one reader, and there is no
-- scope both parties hold that does not also grant everything else the owner
-- has. Such a table is guarded by its permissive policies alone.
--
-- This exists so the audit can stay meaningful. Without it a sharing app's
-- audit is permanently non-empty, and a gate that always fails is one nobody
-- reads. Empty then means every table is either floored or knowingly exempt,
-- and `rls_exempt` is the short list a reviewer actually has to read.
-- Outside `public` on purpose. An app migration granting DML ON ALL TABLES IN
-- SCHEMA public -- 002_grants and 007_publication both do -- would otherwise
-- hand every signed-in user the ability to exempt any table and silence the
-- gate, and a REVOKE here would be undone by the next such grant. Being outside
-- `public` also keeps it off PostgREST, which serves that schema.
CREATE SCHEMA IF NOT EXISTS mecha;
CREATE TABLE IF NOT EXISTS mecha.rls_exempt (
  table_name text PRIMARY KEY,
  reason     text NOT NULL
);
GRANT USAGE ON SCHEMA mecha TO PUBLIC;
GRANT SELECT ON mecha.rls_exempt TO PUBLIC;

-- Where a shape may be keyed besides `scope_id`, declared rather than
-- discovered. A row of `table_name` keyed by `column_name` has the visibility
-- of the `parent` row that column names: a composition's rows are content of
-- their parent. Declaring the edge is what makes a per-object shape
-- (`note_item where note_id = '<row>'`) authorizable at all: the gate cannot
-- prove from a policy that every present and future row under a key is
-- readable, but an app that emitted the policy can say so, once, here.
--
-- `parent = 'subject'` is the one edge that names no table: the keyed rows
-- are addressed to a subject -- a grant table by its sharee column -- and the
-- value must be the caller. Not `app_user` by its key, which would make the
-- edge as wide as that table's policy, and an app may make app_user public.
--
-- Outside `public` for the reason given at `rls_exempt`: a row here widens
-- what a shape may carry, and an app grant must not be able to add one.
CREATE TABLE IF NOT EXISTS mecha.shape_key (
  table_name  text NOT NULL,
  column_name text NOT NULL,
  parent      text NOT NULL,
  parent_key  text NOT NULL,
  PRIMARY KEY (table_name, column_name)
);
GRANT SELECT ON mecha.shape_key TO PUBLIC;

-- A composition's scope is its parent's, and a generated column cannot reach
-- another table, so this trigger writes it and overwrites anything supplied.
-- BEFORE, so the value is in the row Postgres stores; on UPDATE too, because
-- re-pointing the parent key is a move. Arguments: parent table, parent key,
-- the child's column naming it. The child's value is cast to the parent
-- key's type, so the lookup is the parent key's index.
--
-- A child of no parent has no scope. Where the column is a foreign key the
-- key refuses it, and this raises the same violation first, since NOT NULL
-- would otherwise answer before the key does. Where it is not -- a sink a
-- pipeline writes for a row that may since be gone -- the row is derived
-- data of nothing and is not stored, so the batch it came in lands.
CREATE OR REPLACE FUNCTION mecha.scope_from_parent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  ty text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO ty FROM pg_attribute a
    WHERE a.attrelid = TG_ARGV[0]::regclass AND a.attname = TG_ARGV[1] AND NOT a.attisdropped;
  EXECUTE format('SELECT p.scope_id FROM %s p WHERE p.%I = ($1).%I::%s',
                 TG_ARGV[0]::regclass, TG_ARGV[1], TG_ARGV[2], ty)
    INTO NEW.scope_id USING NEW;
  IF NEW.scope_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint c
                WHERE c.conrelid = TG_RELID AND c.contype = 'f'
                  AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                         WHERE attrelid = TG_RELID AND attname = TG_ARGV[2])]) THEN
      RAISE foreign_key_violation USING MESSAGE =
        format('Key is not present in table "%s".', TG_ARGV[0]);
    END IF;
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

-- Whether a shape over `tbl` keyed `col = val` reaches only rows the caller
-- may read: the edge is declared, and the caller can read the parent row.
-- Evaluated as the caller, and it has to be: the gatekeeper sets the
-- subject's role and claims on its transaction first, so the SELECT on the
-- parent is the app's own policies answering -- the one derivation the CRUD
-- path reads. Not SECURITY DEFINER, which Postgres forbids from switching
-- role, and which would answer as its owner anyway.
CREATE OR REPLACE FUNCTION mecha.shape_reach(tbl text, col text, val text) RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  p text;
  k text;
  ty text;
  ok boolean;
BEGIN
  SELECT parent, parent_key INTO p, k FROM mecha.shape_key
    WHERE table_name = tbl AND column_name = col;
  IF p IS NULL THEN RETURN false; END IF;
  IF p = 'subject' THEN
    RETURN val = nullif(current_setting('request.jwt.claims', true)::json->>'sub', '');
  END IF;
  -- The value is cast to the key's own type, so the comparison can use the
  -- key's index; comparing on the text side would scan the parent per mint.
  -- A value the type will not take -- unparseable, out of range -- names no
  -- row: data_exception is the whole class.
  SELECT format_type(a.atttypid, a.atttypmod) INTO ty FROM pg_attribute a
    WHERE a.attrelid = p::regclass AND a.attname = k AND NOT a.attisdropped;
  IF ty IS NULL THEN RETURN false; END IF;
  BEGIN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1::%s)', p::regclass, k, ty)
      INTO ok USING val;
  EXCEPTION WHEN data_exception THEN
    RETURN false;
  END;
  RETURN ok;
END $$;
GRANT EXECUTE ON FUNCTION mecha.shape_reach(text, text, text) TO PUBLIC;

-- It reads the catalog rather than the source because a hand-written migration
-- can bypass a generator and cannot bypass this. Every term rejects an object
-- that some earlier version of this called protected, and each is held down by
-- its own assertion. None is decoration; do not simplify one away.
--
-- A function rather than a bare view because `pg_get_expr` renders according to
-- the CALLER's search_path. Unpinned, an auditor with a different one gets false
-- failures, and -- worse -- a policy calling a wide-open `current_scopes()` from
-- another schema on the path renders bare and reads as protected.
--
-- Views and matviews are included because migrations run as the superuser, so
-- every object is superuser-owned: a view without `security_invoker` executes as
-- its owner and bypasses RLS, and a matview is a stored snapshot RLS never
-- evaluates at all. One CREATE VIEW would otherwise defeat the floor silently.
-- Outside `public` for the reason given at `rls_exempt`, and with more to lose:
-- this list names every table the floor does not cover.
--
-- Two drops with different jobs, neither redundant: the unqualified pair clears
-- the objects from `public` in a database created while they lived there; the
-- qualified one is what lets the file be applied to a database that already has
-- it, which is how a correction to the floor reaches one.
DROP VIEW IF EXISTS public.rls_unprotected;
DROP FUNCTION IF EXISTS public.rls_audit();
DROP VIEW IF EXISTS mecha.rls_unprotected;
CREATE OR REPLACE FUNCTION mecha.rls_audit()
  RETURNS TABLE (table_name text, reason text)
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT n.nspname || '.' || c.relname,
         CASE c.relkind
           WHEN 'm' THEN 'materialized view: a snapshot RLS never evaluates'
           WHEN 'v' THEN 'view without security_invoker: runs as its owner'
           ELSE CASE
             WHEN NOT c.relrowsecurity      THEN 'RLS not enabled'
             WHEN NOT c.relforcerowsecurity THEN 'RLS not forced: the owner is exempt'
             WHEN EXISTS (SELECT 1 FROM pg_policy p
                           WHERE p.polrelid = c.oid AND p.polpermissive
                             AND p.polroles = '{0}'::oid[])
               THEN 'a permissive policy granted to PUBLIC: every role holds public:, so anon reaches what it admits'
             ELSE 'no tenancy policy: restrictive, PUBLIC, FOR ALL, both sides the scope test'
           END
         END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm')
     AND NOT EXISTS (SELECT 1 FROM mecha.rls_exempt e
                      WHERE e.table_name = n.nspname || '.' || c.relname)
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND n.nspname NOT LIKE 'pg\_temp\_%'
     AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                        AND d.deptype = 'e')
     AND (c.relkind = 'm'
          OR (c.relkind = 'v'
              AND NOT coalesce(c.reloptions, '{}') @> ARRAY['security_invoker=true'])
          OR (c.relkind IN ('r', 'p')
              AND (NOT c.relrowsecurity
                   OR NOT c.relforcerowsecurity
                   OR EXISTS (SELECT 1 FROM pg_policy p
                               WHERE p.polrelid = c.oid AND p.polpermissive
                                 AND p.polroles = '{0}'::oid[])
                   OR NOT EXISTS (
                        SELECT 1 FROM pg_policy p
                         WHERE p.polrelid = c.oid
                           AND NOT p.polpermissive
                           AND p.polroles = '{0}'::oid[]
                           AND p.polcmd = '*'
                           AND pg_get_expr(p.polqual, p.polrelid)
                                 = '(scope_id = ANY (current_scopes()))'
                           AND pg_get_expr(p.polwithcheck, p.polrelid)
                                 = '(scope_id = ANY (current_scopes()))'))))
$$;

-- security_invoker because the audit flags views that lack it, and a check that
-- exempts itself is not one. It runs as the reader either way: rls_audit reads
-- only catalogs.
CREATE VIEW mecha.rls_unprotected WITH (security_invoker = true)
  AS SELECT * FROM mecha.rls_audit();

-- A function is EXECUTE TO PUBLIC by default, so the schema move alone would
-- leave the view denied and the function under it callable by anyone. Both
-- surfaces or neither: assertions 39 and 40. `rls_exempt` is readable by
-- contrast because a GRANT says so.
REVOKE EXECUTE ON FUNCTION mecha.rls_audit() FROM PUBLIC;

-- `rls_exempt` is a table in a schema the audit scans, so it exempts itself
-- -- by a row, in the list a reviewer reads, rather than by a term in the
-- predicate where nobody would find it.
INSERT INTO mecha.rls_exempt VALUES
  ('mecha.rls_exempt', 'the exemption list: readable by all, writable by none'),
  ('mecha.shape_key', 'the shape edges: readable by all, writable by none')
  ON CONFLICT DO NOTHING;
