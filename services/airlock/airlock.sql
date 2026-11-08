-- The airlock's tables (README.md). The database image stages them, and a
-- cluster whose program declares an external effect places them among the
-- initdb steps, after Graphile's schema (graphile.sql). A guard is plpgsql,
-- which resolves the ledger and add_job only when it runs.

-- A client that could write the ledger could forge an outcome, and one that
-- could read it would see every input sent outside. The tables live in a
-- schema of their own so that no grant a caller makes over `public`, before or
-- after this step, reaches them: `GRANT ... ON ALL TABLES IN SCHEMA public`
-- names only `public`, and a role without USAGE here reaches nothing here
-- whatever a table grants it. The owner, which is the airlock's connection,
-- alone holds the schema.
CREATE SCHEMA IF NOT EXISTS airlock;

-- One row per external effect performed: the claim a guard makes in the
-- transition's own commit, the authority for the outcome that alone leaves the
-- invoking state, and time travel's record of the world outside.
CREATE TABLE IF NOT EXISTS airlock.external_effect_ledger (
  key         TEXT PRIMARY KEY,       -- '<effect>:<key fields>'; the sink's idempotency key
  effect      TEXT NOT NULL,
  row         JSONB NOT NULL,         -- the invoking instance's primary key
  input       JSONB NOT NULL,         -- frozen at the claim, never re-derived
  entered     INT NOT NULL DEFAULT 0, -- handler runs begun; past one, a run may have reached the sink
  outcome     JSONB,                  -- {target, kind, data, reconciled}, set once
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at  TIMESTAMPTZ
);

-- Each live Graphile pool against the advisory key its process holds for its
-- whole life (airlock.ts): a key a sweep can take belongs to a process that is
-- gone, so the jobs its pool locked are released then, not after Graphile's
-- four hours.
CREATE TABLE IF NOT EXISTS airlock.pool (
  pool TEXT PRIMARY KEY,
  lock BIGINT NOT NULL
);

-- The airlock's wake. The database image prepends the ticker's schedule table
-- (services/ticker/schedule.sql) to this step, so the table a guard re-arms
-- exists before any caller step that could write a row into an invoking
-- state. The row named `airlock`, seeded here with its watermark reached, is
-- the one-shot pronto's guard re-arms by clearing the watermark; the ticker's
-- next sweep emits one tick here and wakes the units a job needs, so an effect
-- enqueued on a cluster scaled to zero is not owed to a later schedule. The
-- ticker writes through crud as `service`; a client role reaches neither
-- table, as with `schedule`: a tick's instant is when some tenant's row
-- entered an invoking state.
INSERT INTO schedule (name, due_at, last_tick_at, emits_entity)
VALUES ('airlock', now(), now(), 'airlock_wake')
ON CONFLICT (name) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.airlock_wake (
  id       UUID PRIMARY KEY,
  schedule TEXT NOT NULL,
  tick_at  TIMESTAMPTZ NOT NULL,
  late     BOOLEAN NOT NULL,
  caller   TEXT
);
ALTER TABLE public.airlock_wake ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'app_user'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.airlock_wake FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service') THEN
    GRANT INSERT, SELECT ON public.airlock_wake TO service;
  END IF;
END
$$;

-- What a caller's ALTER DEFAULT PRIVILEGES granted at CREATE, on the schema
-- (ON SCHEMAS) or on the tables (ON TABLES without IN SCHEMA), is revoked,
-- `service` included: it bypasses RLS, and SERVICE_JWT is the pipelines' and
-- the ticker's. No policy is declared: nothing else has any business here.
ALTER TABLE airlock.external_effect_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE airlock.pool ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE g RECORD;
BEGIN
  FOR g IN
    SELECT DISTINCT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a
     WHERE n.nspname = 'airlock' AND a.grantee <> n.nspowner
    UNION
    SELECT DISTINCT 'TABLE', 'airlock.' || quote_ident(c.relname), a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid IN ('airlock.external_effect_ledger'::regclass, 'airlock.pool'::regclass)
       AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s', g.kind, g.name,
      CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
END
$$;
