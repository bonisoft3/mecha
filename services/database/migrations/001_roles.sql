-- The roles the cluster's services act as: anon and authenticator for
-- PostgREST, app_user and service for the auth plane's tokens, and electric
-- for the sync service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT;
    GRANT anon TO authenticator;
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

-- A pipeline writes every tenant's rows, and electric reads every tenant's WAL:
-- both reach across scopes by a role attribute the audit can see. Without it
-- electric's current_scopes() is empty and every shape syncs empty, silently.
-- The password is a dev credential; cluster.cue, at the URL naming this role,
-- says what a deployment does with both.
ALTER ROLE service BYPASSRLS;
ALTER ROLE electric BYPASSRLS REPLICATION LOGIN PASSWORD 'electric';

-- The pipelines and the ticker write as `service` through crud, into any
-- table, as a caller's grants let them.
GRANT USAGE ON SCHEMA public TO service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service;

-- Electric snapshots a shape's rows before it streams them.
GRANT USAGE ON SCHEMA public TO electric;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO electric;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO electric;

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
