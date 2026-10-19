-- The table the ticker sweeps (README.md). The database image stages it, a
-- cluster that declares a schedule places it among the initdb steps, and the
-- caller's migrations seed it by name after it.
CREATE TABLE IF NOT EXISTS schedule (
  name                 TEXT PRIMARY KEY,
  -- A cadence, or a single instant: a one-shot row is due once `due_at` has
  -- passed and its watermark has not, and is re-armed by clearing the
  -- watermark. The airlock's step seeds one, `airlock`, which pronto's guard
  -- re-arms (services/airlock/airlock.sql).
  cron                 TEXT,
  due_at               TIMESTAMPTZ,
  time_zone            TEXT NOT NULL DEFAULT 'UTC',
  suspended            BOOLEAN NOT NULL DEFAULT FALSE,
  max_lateness_seconds INTEGER NOT NULL DEFAULT 300,
  concurrency_policy   TEXT NOT NULL DEFAULT 'Allow'
                         CHECK (concurrency_policy IN ('Allow', 'Forbid')),
  done_entity          TEXT,
  done_filter          TEXT,
  emits_entity         TEXT NOT NULL,
  emits_values         JSONB NOT NULL DEFAULT '{}',
  last_tick_at         TIMESTAMPTZ,
  CHECK (concurrency_policy <> 'Forbid'
         OR (done_entity IS NOT NULL AND done_filter IS NOT NULL)),
  CHECK ((cron IS NULL) <> (due_at IS NULL))
);

-- The default privileges a caller's grants set reach every table made after
-- them, this one included, so without this a signed-in user can read and
-- rewrite the mechanism. That is not a disclosure, it is an escalation: the
-- ticker reads emits_entity and emits_values from here and writes them as
-- `service`, which bypasses RLS, so whoever can repoint the column has rows
-- inserted wherever they choose, once per poke — and `suspended` stops every
-- schedule. No policy is declared because none is wanted: `service` holds
-- BYPASSRLS and nothing else has any business here.
-- RLS is what denies them: those grants name the roles, not PUBLIC, so
-- revoking PUBLIC would leave every one of them in place. The revoke below is
-- belt to that brace, and is conditional because which roles exist is the
-- caller's.
ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'app_user'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON schedule FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- The ticker's own grant, stated here rather than inherited: a caller step
-- that revoked its default privileges before this table exists (as one
-- closing its passkey table must) has taken back the grant it would otherwise
-- be born with. The ticker reads the list and advances each row's watermark,
-- and nothing more.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service') THEN
    GRANT SELECT, UPDATE ON schedule TO service;
  END IF;
END
$$;
