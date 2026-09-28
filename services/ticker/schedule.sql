-- The table the ticker sweeps (README.md). The database image stages it, a
-- cluster that declares a schedule places it among the initdb steps, and the
-- caller's migrations seed it by name after it.
CREATE TABLE IF NOT EXISTS schedule (
  name                 TEXT PRIMARY KEY,
  cron                 TEXT NOT NULL,
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
         OR (done_entity IS NOT NULL AND done_filter IS NOT NULL))
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
