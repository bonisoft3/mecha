DO $mecha_roles$
DECLARE
  ownership text := coalesce(nullif(current_setting('mecha.roles', true), ''), 'framework');
  contract jsonb := $contract${"roles":{"anon":{"attributes":{"rolcanlogin":false,"rolsuper":false,"rolcreaterole":false,"rolcreatedb":false,"rolreplication":false,"rolbypassrls":false},"settings":{"statement_timeout":"5s","lock_timeout":"2s","idle_in_transaction_session_timeout":"10s"},"notDatabaseOwner":false},"app_user":{"attributes":{"rolcanlogin":false,"rolsuper":false,"rolcreaterole":false,"rolcreatedb":false,"rolreplication":false,"rolbypassrls":false},"settings":{"statement_timeout":"5s","lock_timeout":"2s","idle_in_transaction_session_timeout":"10s"},"notDatabaseOwner":false},"authenticator":{"attributes":{"rolcanlogin":true,"rolinherit":false,"rolsuper":false,"rolcreaterole":false,"rolcreatedb":false,"rolreplication":false,"rolbypassrls":false},"settings":{"statement_timeout":"5s","lock_timeout":"2s","idle_in_transaction_session_timeout":"10s"},"notDatabaseOwner":false},"service":{"attributes":{"rolcanlogin":false,"rolsuper":false,"rolcreaterole":false,"rolcreatedb":false,"rolreplication":false,"rolbypassrls":true},"settings":{"statement_timeout":"30s","lock_timeout":"5s","idle_in_transaction_session_timeout":"60s"},"notDatabaseOwner":false},"electric":{"attributes":{"rolcanlogin":true,"rolsuper":false,"rolcreaterole":false,"rolcreatedb":false,"rolreplication":true,"rolbypassrls":true},"settings":{},"notDatabaseOwner":false}},"memberships":{"authenticator":["anon","app_user","service"],"anon":[],"app_user":[],"service":[],"electric":[]},"exactMemberships":true}$contract$;
  expected record;
  actual jsonb;
  setting record;
  grant_spec record;
  value text;
BEGIN
  IF ownership = 'framework' THEN
    EXECUTE $managed$-- The roles the cluster's services act as: anon and authenticator for
-- PostgREST, app_user and service for the auth plane's tokens, and electric
-- for the sync service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service') THEN
    CREATE ROLE service NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'electric') THEN
    CREATE ROLE electric NOLOGIN;
  END IF;
END
$$;

-- PostgREST logs in as authenticator and switches to the role a request's
-- token names; it applies that role's settings (timeouts, isolation) only to
-- roles its login is granted, so the grant is what makes them hold, and the
-- login inherits none of their privileges. On Kubernetes the operator may
-- have created the role first.
ALTER ROLE authenticator NOINHERIT LOGIN;
GRANT anon, app_user, service TO authenticator;

-- A pipeline writes every tenant's rows, and electric reads every tenant's WAL:
-- both reach across scopes by a role attribute the audit can see. Without it
-- electric's current_scopes() is empty and every shape syncs empty, silently.
-- electric's password is the deployment's (cluster.cue's #RolePasswordsStep).
ALTER ROLE service BYPASSRLS;
ALTER ROLE electric BYPASSRLS REPLICATION LOGIN;

-- Finite machine bounds: statement, lock, and idle timeouts.
-- Public and client-facing traffic fail fast to protect connection pool and give immediate feedback:
ALTER ROLE anon SET statement_timeout = '5s';
ALTER ROLE anon SET lock_timeout = '2s';
ALTER ROLE anon SET idle_in_transaction_session_timeout = '10s';

ALTER ROLE authenticator SET statement_timeout = '5s';
ALTER ROLE authenticator SET lock_timeout = '2s';
ALTER ROLE authenticator SET idle_in_transaction_session_timeout = '10s';

ALTER ROLE app_user SET statement_timeout = '5s';
ALTER ROLE app_user SET lock_timeout = '2s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '10s';

-- Internal service role (batches, pipelines, ticker) has bounded headroom:
ALTER ROLE service SET statement_timeout = '30s';
ALTER ROLE service SET lock_timeout = '5s';
ALTER ROLE service SET idle_in_transaction_session_timeout = '60s';
$managed$;
    RETURN;
  END IF;
  IF ownership <> 'external' THEN
    RAISE EXCEPTION 'mecha.roles must be framework or external, got %', ownership;
  END IF;
  FOR expected IN SELECT j.key AS name, j.value AS spec FROM jsonb_each(contract->'roles') j LOOP
    SELECT to_jsonb(r) INTO actual FROM pg_catalog.pg_roles r WHERE rolname = expected.name;
    IF actual IS NULL THEN
      RAISE EXCEPTION 'externally managed role % is missing; its administrator must create it', quote_ident(expected.name);
    END IF;
    FOR setting IN SELECT j.key AS name, j.value FROM jsonb_each(expected.spec->'attributes') j LOOP
      IF actual->setting.name IS DISTINCT FROM setting.value THEN
        RAISE EXCEPTION 'externally managed role % requires % = %, got %; its administrator must correct it',
          quote_ident(expected.name), setting.name, setting.value, actual->setting.name;
      END IF;
    END LOOP;
    IF coalesce((expected.spec->>'notDatabaseOwner')::boolean, false)
       AND (actual->>'oid')::oid = (SELECT datdba FROM pg_database WHERE datname = current_database()) THEN
      RAISE EXCEPTION 'externally managed token role % must not own the database', quote_ident(expected.name);
    END IF;
    FOR setting IN SELECT j.key AS name, j.value FROM jsonb_each_text(expected.spec->'settings') j LOOP
      SELECT substr(c, strpos(c, '=') + 1) INTO value
        FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c
        WHERE s.setdatabase = 0 AND s.setrole = (actual->>'oid')::oid
          AND split_part(c, '=', 1) = setting.name;
      IF value IS NULL OR
         (CASE WHEN value ~ '^[0-9]+$' THEN value || 'ms' ELSE value END)::interval <> setting.value::interval THEN
        RAISE EXCEPTION 'externally managed role % requires % = %, got %; its administrator must correct it',
          quote_ident(expected.name), setting.name, setting.value, coalesce(value, '<unset>');
      END IF;
      IF EXISTS (SELECT FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c
                 WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND s.setrole = (actual->>'oid')::oid AND split_part(c, '=', 1) = setting.name
                   AND (CASE WHEN split_part(c, '=', 2) ~ '^[0-9]+$' THEN split_part(c, '=', 2) || 'ms'
                             ELSE split_part(c, '=', 2) END)::interval <> setting.value::interval) THEN
        RAISE EXCEPTION 'externally managed role % has a conflicting database override for %; its administrator must correct it',
          quote_ident(expected.name), setting.name;
      END IF;
    END LOOP;
  END LOOP;
  FOR grant_spec IN SELECT j.key AS name, j.value AS roles FROM jsonb_each(contract->'memberships') j LOOP
    FOR expected IN SELECT j.value AS name FROM jsonb_array_elements_text(grant_spec.roles) j LOOP
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members
                     WHERE member = quote_ident(grant_spec.name)::regrole AND roleid = quote_ident(expected.name)::regrole AND set_option) THEN
        RAISE EXCEPTION 'externally managed role % requires SET membership in %; its administrator must grant it',
          quote_ident(grant_spec.name), quote_ident(expected.name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_catalog.pg_auth_members m
               WHERE m.member = quote_ident(grant_spec.name)::regrole
                 AND (coalesce((contract->>'exactMemberships')::boolean, false) OR jsonb_array_length(grant_spec.roles) = 0
                      OR pg_get_userbyid(m.roleid) IN (SELECT jsonb_array_elements_text(grant_spec.roles)))
                 AND (m.inherit_option OR m.admin_option OR
                      pg_get_userbyid(m.roleid) NOT IN (SELECT jsonb_array_elements_text(grant_spec.roles)))) THEN
      RAISE EXCEPTION 'externally managed role % has unexpected membership, INHERIT or ADMIN privileges; its administrator must revoke them', quote_ident(grant_spec.name);
    END IF;
  END LOOP;
END
$mecha_roles$;
