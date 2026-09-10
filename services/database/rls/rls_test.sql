-- Assertions on the tenancy floor (rls.sql). Raises on the first failure rather
-- than printing, so it is a gate. Builds and drops its own fixture; expects
-- rls.sql loaded and an `_f_app` role.
\set ON_ERROR_STOP on
-- The gate's only output is its verdict; IF EXISTS chatter would bury it.
SET client_min_messages = warning;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '_f_app') THEN
    EXECUTE 'DROP OWNED BY _f_app'; EXECUTE 'DROP ROLE _f_app';
  END IF;
END $c$;
CREATE ROLE _f_app NOLOGIN;
GRANT USAGE ON SCHEMA public TO _f_app;

-- Only the three fixtures built out here need clearing. Everything else is
-- created inside the DO block, which is one transaction: a failed assertion
-- rolls its own fixtures back, so a re-run starts from the same state whether
-- the last one passed or not.
DROP TABLE IF EXISTS _f_posting, _f_note, _f_denied;
CREATE TABLE _f_posting(id serial primary key, note text not null, scope_id text not null);
INSERT INTO _f_posting(note, scope_id) VALUES
  ('h1 a','household:h1'), ('h1 b','household:h1'), ('h2 c','household:h2');
CALL rls_protect('_f_posting');
-- Deliberately the widest possible permissive policy: the floor must hold anyway.
CREATE POLICY wide ON _f_posting FOR ALL TO _f_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON _f_posting TO _f_app;
GRANT USAGE ON SEQUENCE _f_posting_id_seq TO _f_app;

-- mode: owned. The scope is generated, so the client cannot state it.
CREATE TABLE _f_note(id serial primary key, user_id text not null, body text not null,
  scope_id text GENERATED ALWAYS AS ('user:' || user_id) STORED NOT NULL);
INSERT INTO _f_note(user_id, body) VALUES ('ana','ana'), ('davi','davi');
CALL rls_protect('_f_note');
CREATE POLICY wide ON _f_note FOR ALL TO _f_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON _f_note TO _f_app;
GRANT USAGE ON SEQUENCE _f_note_id_seq TO _f_app;

-- Floor present, no permissive policy: must be invisible even to a scope holder.
CREATE TABLE _f_denied(id serial primary key, x text, scope_id text not null);
INSERT INTO _f_denied(x, scope_id) VALUES ('invisible','household:h1');
CALL rls_protect('_f_denied');
GRANT SELECT ON _f_denied TO _f_app;

-- `anon` in a stock mecha database holds blanket DML from 002_grants.sql. A
-- floor that names roles would leave it outside; this fixture is that role.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '_f_anon') THEN
    EXECUTE 'DROP OWNED BY _f_anon'; EXECUTE 'DROP ROLE _f_anon';
  END IF;
END $c$;
CREATE ROLE _f_anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO _f_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON _f_posting TO _f_anon;
CREATE POLICY anon_wide ON _f_posting FOR ALL TO _f_anon USING (true) WITH CHECK (true);

DO $$
DECLARE n int; msg text;
BEGIN
  SET LOCAL ROLE _f_app;

  PERFORM set_config('app.scopes', 'household:h1', true);
  SELECT count(*) INTO n FROM _f_posting;
  IF n <> 2 THEN RAISE EXCEPTION '1 restrictive floor bounds a permissive USING(true): saw % rows, want 2', n; END IF;

  -- The floor's WITH CHECK guards this. Without it the write side is open, and
  -- the attack is not reading another tenant's rows but inserting into them.
  BEGIN INSERT INTO _f_posting(note, scope_id) VALUES ('x','household:h2');
        RAISE EXCEPTION '2 INSERT into an unheld scope was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  INSERT INTO _f_posting(note, scope_id) VALUES ('mine','household:h1');

  BEGIN UPDATE _f_posting SET scope_id='household:h2' WHERE note='h1 a';
        RAISE EXCEPTION '4 moving a row into an unheld scope was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  SELECT count(*) INTO n FROM _f_denied;
  IF n <> 0 THEN RAISE EXCEPTION '5 deny-by-default failed: saw % rows', n; END IF;

  PERFORM set_config('app.scopes', '', true);
  SELECT count(*) INTO n FROM _f_posting;
  IF n <> 0 THEN RAISE EXCEPTION '6 unset scopes did not fail closed: saw % rows', n; END IF;

  -- owned mode
  PERFORM set_config('app.scopes', 'user:ana', true);
  SELECT count(*) INTO n FROM _f_note;
  IF n <> 1 THEN RAISE EXCEPTION '7 owned scope: saw % rows, want 1', n; END IF;

  BEGIN INSERT INTO _f_note(user_id, body) VALUES ('davi','forged');
        RAISE EXCEPTION '8 inserting a row owned by another subject was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN INSERT INTO _f_note(user_id, body, scope_id) VALUES ('ana','x','user:davi');
        RAISE EXCEPTION '9 a client-supplied scope_id was accepted';
  EXCEPTION WHEN generated_always THEN NULL; END;

  INSERT INTO _f_note(user_id, body) VALUES ('ana','mine');

  BEGIN UPDATE _f_note SET user_id='davi' WHERE body='ana';
        RAISE EXCEPTION '11 re-owning a row to another subject was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET ROLE;

  -- rls_protect runs on every migration, so it must survive being applied twice.
  CALL rls_protect('_f_posting');
  CALL rls_protect('_f_posting');

  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name ~ '^public\._f_';
  IF n <> 0 THEN
    SELECT string_agg(table_name, ', ') INTO msg FROM mecha.rls_unprotected WHERE table_name ~ '^public\._f_';
    RAISE EXCEPTION '12 audit found fixtures without the floor: %', msg;
  END IF;

  -- A partitioned parent carries the policy that applies to queries through it,
  -- so the audit must see relkind 'p' or an unprotected table passes the check
  -- that exists to prove no such table exists.
  CREATE TABLE _f_part(id int, scope_id text) PARTITION BY RANGE (id);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_part';
  IF n <> 1 THEN RAISE EXCEPTION '14 audit does not see an unprotected partitioned table'; END IF;
  DROP TABLE _f_part;

  -- An unrelated restrictive policy must not stand in for the floor.
  CREATE TABLE _f_decoy(id int, scope_id text);
  ALTER TABLE _f_decoy ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_decoy FORCE ROW LEVEL SECURITY;
  CREATE POLICY other ON _f_decoy AS RESTRICTIVE FOR ALL USING (true);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_decoy';
  IF n <> 1 THEN RAISE EXCEPTION '15 an unrelated restrictive policy stood in for the floor'; END IF;
  DROP TABLE _f_decoy;

  -- A doubled comma would mint a '' scope, and '' matches every row whose
  -- scope_id is ''. Widening is the one direction current_scopes must not fail
  -- in, so the empty elements are dropped rather than trimmed later.
  SET LOCAL ROLE _f_app;
  PERFORM set_config('app.scopes', 'household:h1,,', true);
  IF '' = ANY(current_scopes()) THEN RAISE EXCEPTION '19 an empty scope was minted'; END IF;
  RESET ROLE;

  -- A restrictive policy constrains only the roles it names, so naming one would
  -- leave `anon` -- which holds blanket DML from 002_grants.sql -- outside the
  -- floor while the audit still reported the table protected. Hence no TO clause.
  SET LOCAL ROLE _f_anon;
  PERFORM set_config('app.scopes', 'household:h1', true);
  SELECT count(*) INTO n FROM _f_posting WHERE scope_id = 'household:h2';
  IF n <> 0 THEN RAISE EXCEPTION '16 a second role escaped the floor: saw % rows from an unheld scope', n; END IF;
  RESET ROLE;

  -- The owner is exempt from RLS without FORCE, and migrations run as the owner
  -- -- which is exactly the out-of-band table the floor exists to catch.
  CREATE TABLE _f_noforce(id int, scope_id text);
  ALTER TABLE _f_noforce ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_noforce AS RESTRICTIVE FOR ALL
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_noforce';
  IF n <> 1 THEN RAISE EXCEPTION '17 audit accepted a table without FORCE'; END IF;
  DROP TABLE _f_noforce;

  CREATE TABLE _f_rolescoped(id int, scope_id text);
  ALTER TABLE _f_rolescoped ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_rolescoped FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_rolescoped AS RESTRICTIVE FOR ALL TO _f_app
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_rolescoped';
  IF n <> 1 THEN RAISE EXCEPTION '18 audit accepted a floor bound to one role'; END IF;
  DROP TABLE _f_rolescoped;

  -- A permissive policy named `tenancy` looks like the floor in every other
  -- respect and binds nothing.
  CREATE TABLE _f_permissive(id int, scope_id text);
  ALTER TABLE _f_permissive ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_permissive FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_permissive FOR ALL
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_permissive';
  IF n <> 1 THEN RAISE EXCEPTION '20 audit accepted a permissive policy as the floor'; END IF;
  DROP TABLE _f_permissive;

  -- FOR SELECT leaves the write side unbound while looking like the floor from
  -- the catalog, which is why the audit pins polcmd and the rendered predicate.
  CREATE TABLE _f_selectonly(id int, scope_id text);
  ALTER TABLE _f_selectonly ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_selectonly FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_selectonly AS RESTRICTIVE FOR SELECT
    USING (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_selectonly';
  IF n <> 1 THEN RAISE EXCEPTION '21 audit accepted a SELECT-only floor'; END IF;
  DROP TABLE _f_selectonly;

  -- A table in another schema is the cheapest way to add one out of band.
  CREATE SCHEMA _f_other;
  CREATE TABLE _f_other.leaky(id int, scope_id text);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = '_f_other.leaky';
  IF n <> 1 THEN RAISE EXCEPTION '22 audit is blind outside the public schema'; END IF;
  DROP SCHEMA _f_other CASCADE;

  -- FORCE without ENABLE leaves RLS inactive, and the two flags are independent.
  CREATE TABLE _f_forced(id int, scope_id text);
  ALTER TABLE _f_forced FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_forced AS RESTRICTIVE FOR ALL
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_forced';
  IF n <> 1 THEN RAISE EXCEPTION '23 audit accepted FORCE without ENABLE'; END IF;
  DROP TABLE _f_forced;

  -- A floor that binds writes and not reads: the with-check side alone looks
  -- correct, which is why both sides are pinned.
  CREATE TABLE _f_readopen(id int, scope_id text);
  ALTER TABLE _f_readopen ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_readopen FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_readopen AS RESTRICTIVE FOR ALL
    USING (true) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_readopen';
  IF n <> 1 THEN RAISE EXCEPTION '24 audit accepted a floor that binds writes but not reads'; END IF;
  DROP TABLE _f_readopen;

  -- FOR UPDATE is the case a text pin alone does not catch: unlike FOR SELECT
  -- it carries BOTH quals, so it matches every other term while leaving SELECT,
  -- INSERT and DELETE unbound.
  CREATE TABLE _f_updonly(id int, scope_id text NOT NULL);
  ALTER TABLE _f_updonly ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_updonly FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenancy ON _f_updonly AS RESTRICTIVE FOR UPDATE
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_updonly';
  IF n <> 1 THEN RAISE EXCEPTION '25 audit accepted a FOR UPDATE floor'; END IF;
  DROP TABLE _f_updonly;

  -- A same-named function on the caller's search_path would render bare and read
  -- as the real one; the audit pins its own search_path so it renders qualified.
  CREATE SCHEMA _f_evil;
  CREATE FUNCTION _f_evil.current_scopes() RETURNS text[]
    LANGUAGE sql STABLE AS $e$ SELECT ARRAY['household:h1','household:h2'] $e$;
  CREATE TABLE _f_shadow(id int, scope_id text NOT NULL);
  ALTER TABLE _f_shadow ENABLE ROW LEVEL SECURITY;
  ALTER TABLE _f_shadow FORCE ROW LEVEL SECURITY;
  SET LOCAL search_path = _f_evil, public;
  CREATE POLICY tenancy ON _f_shadow AS RESTRICTIVE FOR ALL
    USING (scope_id = ANY(current_scopes())) WITH CHECK (scope_id = ANY(current_scopes()));
  SET LOCAL search_path = public;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_shadow';
  IF n <> 1 THEN RAISE EXCEPTION '26 audit accepted a shadowed current_scopes'; END IF;
  -- and the render must stay qualified even when the CALLER's search_path is the
  -- hostile one, which is what the function's own pinned path is for.
  SET LOCAL search_path = _f_evil, public;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_shadow';
  SET LOCAL search_path = public;
  IF n <> 1 THEN RAISE EXCEPTION '26b audit trusted the caller''s search_path'; END IF;
  DROP TABLE _f_shadow; DROP SCHEMA _f_evil CASCADE;

  -- Migrations run as the superuser, so a view without security_invoker executes
  -- as its owner and bypasses RLS entirely.
  CREATE VIEW _f_view AS SELECT * FROM _f_posting;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_view';
  IF n <> 1 THEN RAISE EXCEPTION '27 audit is blind to a non-invoker view'; END IF;
  DROP VIEW _f_view;

  -- The escape a view has: security_invoker makes it run as the reader, so the
  -- underlying table's floor applies and the view is not itself a hole.
  CREATE VIEW _f_okview WITH (security_invoker = true) AS SELECT * FROM _f_posting;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_okview';
  IF n <> 0 THEN RAISE EXCEPTION '28 a security_invoker view was flagged'; END IF;
  DROP VIEW _f_okview;

  CREATE MATERIALIZED VIEW _f_matview AS SELECT * FROM _f_posting;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_matview';
  IF n <> 1 THEN RAISE EXCEPTION '29 audit is blind to a materialized view'; END IF;
  DROP MATERIALIZED VIEW _f_matview;

  -- A temp table in any session would otherwise fail the gate spuriously.
  CREATE TEMP TABLE _f_tmp(id int);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name LIKE '%._f_tmp';
  IF n <> 0 THEN RAISE EXCEPTION '30 a temp table failed the audit'; END IF;
  DROP TABLE _f_tmp;

  -- A NULL scope fails `= ANY()`, so the row would be invisible forever with the
  -- audit reporting the table protected.
  CREATE TABLE _f_nullable(id int, scope_id text);
  BEGIN
    CALL rls_protect('_f_nullable');
    RAISE EXCEPTION '31 rls_protect accepted a nullable scope_id';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE '31 %' THEN RAISE; END IF;
  END;
  DROP TABLE _f_nullable;

  -- The audit's own objects must pass it. Assertion 12 is scoped to the
  -- fixtures so it cannot see them, and the first version of the view flagged
  -- itself.
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name LIKE 'mecha.rls\_%';
  IF n <> 0 THEN RAISE EXCEPTION '33 the audit flags its own objects'; END IF;

  -- An exemption must be declared to count: the audit still names a table that
  -- merely lacks a floor, or the list stops being the short one to review.
  CREATE TABLE _f_exempt(id int, scope_id text NOT NULL);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_exempt';
  IF n <> 1 THEN RAISE EXCEPTION '34 an undeclared table was treated as exempt'; END IF;
  INSERT INTO mecha.rls_exempt VALUES ('public._f_exempt', 'fixture');
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_exempt';
  IF n <> 0 THEN RAISE EXCEPTION '35 a declared exemption was still flagged'; END IF;
  DELETE FROM mecha.rls_exempt WHERE table_name = 'public._f_exempt';
  DROP TABLE _f_exempt;

  -- app_pre_request is the only writer of app.scopes on a server, so its
  -- failure modes are current_scopes's failure modes one tier up.
  PERFORM set_config('request.jwt.claims', '{"sub":"ana"}', true);
  PERFORM app_pre_request();
  IF current_scopes() <> ARRAY['public:', 'user:ana'] THEN
    RAISE EXCEPTION '36 app_pre_request did not derive the subject scope';
  END IF;

  -- The comma is the separator, so a subject holding one arrives as two scopes,
  -- the second of them chosen by whoever minted the token.
  PERFORM set_config('request.jwt.claims', '{"sub":"ana,user:davi"}', true);
  BEGIN
    PERFORM app_pre_request();
    RAISE EXCEPTION '37 app_pre_request accepted a subject holding the separator';
  EXCEPTION WHEN raise_exception THEN
    IF sqlerrm LIKE '37 %' THEN RAISE; END IF;
  END;

  -- An anonymous request carries claims with no subject. It must mint no
  -- *subject* scope -- a bare 'user:' is a scope a row could carry -- and must
  -- still hold `public:`, which is what lets an anonymous reader see a public
  -- row through the floor rather than around it.
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM app_pre_request();
  IF current_scopes() <> ARRAY['public:'] THEN
    RAISE EXCEPTION '38 a subjectless request did not hold exactly public:';
  END IF;

  -- The floor over a public table. `public:` is a scope like any other, so the
  -- same restrictive policy carries it; what differs is only that every subject
  -- holds it. Nothing here says a public row is *writable* -- the floor's WITH
  -- CHECK admits any scope the caller holds, so writes stay guarded by the
  -- permissive policies and the table grants.
  CREATE TABLE _f_public(id int, scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
  INSERT INTO _f_public(id) VALUES (1), (2);
  CALL rls_protect('_f_public');
  CREATE POLICY readable ON _f_public FOR SELECT TO _f_anon USING (true);
  GRANT SELECT ON _f_public TO _f_anon;
  SET LOCAL ROLE _f_anon;
  PERFORM set_config('app.scopes', array_to_string(subject_scopes(NULL), ','), true);
  SELECT count(*) INTO n FROM _f_public;
  RESET ROLE;
  IF n <> 2 THEN
    RAISE EXCEPTION '39 an anonymous reader could not see a floored public table (saw %)', n;
  END IF;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_public';
  IF n <> 0 THEN RAISE EXCEPTION '40 a floored public table was flagged'; END IF;
  DROP TABLE _f_public;

  -- The audit names every table the floor does not cover, so who may read it
  -- is part of the floor. The view and the function under it are two surfaces
  -- onto the same list, and a schema move only ever hides the first.
  BEGIN
    SET LOCAL ROLE _f_anon;
    PERFORM count(*) FROM mecha.rls_unprotected;
    RESET ROLE;
    RAISE EXCEPTION '41 a non-superuser read the audit view';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;

  BEGIN
    SET LOCAL ROLE _f_anon;
    PERFORM count(*) FROM mecha.rls_audit();
    RESET ROLE;
    RAISE EXCEPTION '42 a non-superuser called the audit function';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;

  -- 26 is the audit noticing a shadowed current_scopes after the fact; this is
  -- rls_protect refusing to mint one in the first place.
  CREATE SCHEMA _f_evil2;
  CREATE FUNCTION _f_evil2.current_scopes() RETURNS text[]
    LANGUAGE sql STABLE AS $e$ SELECT ARRAY['household:h1','household:h2'] $e$;
  CREATE TABLE _f_hostile(id int, scope_id text NOT NULL);
  SET LOCAL search_path = _f_evil2, public;
  CALL rls_protect('_f_hostile');
  SET LOCAL search_path = public;
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_hostile';
  IF n <> 0 THEN RAISE EXCEPTION '43 rls_protect inherited the caller''s search_path'; END IF;
  DROP TABLE _f_hostile; DROP SCHEMA _f_evil2 CASCADE;

  -- The gatekeeper's per-row question, asked as the subject. An undeclared
  -- edge is unreachable whatever the row; a declared one reaches exactly what
  -- the parent's policies show the subject.
  CREATE TABLE _f_doc(id serial primary key, owner text not null);
  CREATE TABLE _f_line(id serial primary key, doc_id int not null references _f_doc(id), body text);
  INSERT INTO _f_doc(owner) VALUES ('ana'), ('davi');
  ALTER TABLE _f_doc ENABLE ROW LEVEL SECURITY;
  CREATE POLICY own ON _f_doc FOR SELECT TO _f_app USING (owner = current_setting('app.subject', true));
  GRANT SELECT ON _f_doc, _f_line TO _f_app;
  INSERT INTO mecha.shape_key VALUES ('public._f_line', 'doc_id', 'public._f_doc', 'id');
  PERFORM set_config('app.subject', 'ana', true);
  SET LOCAL ROLE _f_app;
  IF NOT mecha.shape_reach('public._f_line', 'doc_id', '1') THEN
    RAISE EXCEPTION '44 a declared edge did not reach a row the subject reads';
  END IF;
  IF mecha.shape_reach('public._f_line', 'doc_id', '2') THEN
    RAISE EXCEPTION '45 a declared edge reached a row the subject cannot read';
  END IF;
  IF mecha.shape_reach('public._f_line', 'body', '1') THEN
    RAISE EXCEPTION '46 an undeclared edge was reachable';
  END IF;
  -- A value the key's type refuses, unparseable or out of range, names no row.
  IF mecha.shape_reach('public._f_line', 'doc_id', 'no such row') THEN
    RAISE EXCEPTION '47 an edge reached a row that does not exist';
  END IF;
  IF mecha.shape_reach('public._f_line', 'doc_id', '99') THEN
    RAISE EXCEPTION '47 an edge reached a row that does not exist';
  END IF;
  IF mecha.shape_reach('public._f_line', 'doc_id', '99999999999999999999') THEN
    RAISE EXCEPTION '47 an edge reached a row that does not exist';
  END IF;
  RESET ROLE;
  -- The subject edge: reaches the caller and nobody else, whatever any table
  -- says about who may read whom.
  INSERT INTO mecha.shape_key VALUES ('public._f_grant', 'user_id', 'subject', 'id');
  PERFORM set_config('request.jwt.claims', '{"sub":"ana"}', true);
  SET LOCAL ROLE _f_app;
  IF NOT mecha.shape_reach('public._f_grant', 'user_id', 'ana') THEN
    RAISE EXCEPTION '49 the subject edge did not reach the caller';
  END IF;
  IF mecha.shape_reach('public._f_grant', 'user_id', 'davi') THEN
    RAISE EXCEPTION '50 the subject edge reached another subject';
  END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{}', true);
  SET LOCAL ROLE _f_app;
  IF mecha.shape_reach('public._f_grant', 'user_id', 'ana') THEN
    RAISE EXCEPTION '51 the subject edge reached a subject from no claims';
  END IF;
  RESET ROLE;
  DELETE FROM mecha.shape_key WHERE table_name = 'public._f_grant';
  BEGIN
    SET LOCAL ROLE _f_app;
    INSERT INTO mecha.shape_key VALUES ('public._f_line', 'body', 'public._f_line', 'id');
    RESET ROLE;
    RAISE EXCEPTION '48 an app role declared a shape edge';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  DELETE FROM mecha.shape_key WHERE table_name = 'public._f_line';
  DROP TABLE _f_line, _f_doc;

  -- The composition trigger: a child takes its parent's scope, overwriting
  -- what it was handed, through a key whose type differs from the parent's.
  CREATE TABLE _f_parent(id uuid primary key default gen_random_uuid(), scope_id text not null);
  CREATE TABLE _f_child(id serial primary key, parent_id text not null, scope_id text not null);
  CREATE TRIGGER _f_child_scope BEFORE INSERT OR UPDATE ON _f_child
    FOR EACH ROW EXECUTE FUNCTION mecha.scope_from_parent('_f_parent', 'id', 'parent_id');
  INSERT INTO _f_parent(scope_id) VALUES ('user:ana'), ('user:davi');
  INSERT INTO _f_child(parent_id, scope_id)
    SELECT id::text, 'user:liar' FROM _f_parent WHERE scope_id = 'user:ana';
  IF (SELECT scope_id FROM _f_child) <> 'user:ana' THEN
    RAISE EXCEPTION '52 a composition did not take its parent''s scope';
  END IF;
  UPDATE _f_child SET parent_id = (SELECT id::text FROM _f_parent WHERE scope_id = 'user:davi');
  IF (SELECT scope_id FROM _f_child) <> 'user:davi' THEN
    RAISE EXCEPTION '53 a re-pointed composition kept the scope it left';
  END IF;
  -- No key on the column: a sink. An orphan is not stored, and the statement
  -- it came in lands.
  INSERT INTO _f_child(parent_id) VALUES (gen_random_uuid()::text);
  SELECT count(*) INTO n FROM _f_child;
  IF n <> 1 THEN RAISE EXCEPTION '54 an orphan of a sink was stored'; END IF;
  -- A key on the column: the orphan is refused as the key refuses it.
  CREATE TABLE _f_keyed(id serial primary key, parent_id uuid not null references _f_parent(id), scope_id text not null);
  CREATE TRIGGER _f_keyed_scope BEFORE INSERT OR UPDATE ON _f_keyed
    FOR EACH ROW EXECUTE FUNCTION mecha.scope_from_parent('_f_parent', 'id', 'parent_id');
  BEGIN
    INSERT INTO _f_keyed(parent_id) VALUES (gen_random_uuid());
    RAISE EXCEPTION '55 an orphan of a keyed composition was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  DROP TABLE _f_keyed, _f_child, _f_parent;

  -- Every role holds `public:`, so a permissive policy granted to PUBLIC on a
  -- floored public table hands anon whatever it admits, writes included: the
  -- floor's WITH CHECK is satisfied by a scope anon holds. The audit says so.
  CREATE TABLE _f_open(id int, scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL);
  CALL rls_protect('_f_open');
  CREATE POLICY wide ON _f_open FOR ALL USING (true) WITH CHECK (true);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_open';
  IF n <> 1 THEN RAISE EXCEPTION '56 a permissive policy granted to PUBLIC was not flagged'; END IF;
  DROP POLICY wide ON _f_open;
  CREATE POLICY narrow ON _f_open FOR ALL TO _f_app USING (true) WITH CHECK (true);
  SELECT count(*) INTO n FROM mecha.rls_unprotected WHERE table_name = 'public._f_open';
  IF n <> 0 THEN RAISE EXCEPTION '57 a permissive policy granted to a role was flagged'; END IF;
  DROP TABLE _f_open;

  RAISE WARNING 'rls: 57/57 pass';
END $$;

DROP TABLE _f_posting, _f_note, _f_denied;
DROP OWNED BY _f_anon;
DROP ROLE _f_anon;
DROP OWNED BY _f_app;
DROP ROLE _f_app;
