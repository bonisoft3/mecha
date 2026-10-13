-- A tick is retained so the ticker's deterministic key absorbs redelivery.
-- Schedule names identify one entry, never a reusable machine/row pair.
CREATE TABLE IF NOT EXISTS public.machine_timer_tick (
  id UUID PRIMARY KEY,
  schedule TEXT NOT NULL,
  tick_at TIMESTAMPTZ NOT NULL,
  late BOOLEAN NOT NULL,
  caller TEXT,
  machine TEXT NOT NULL,
  "row" JSONB NOT NULL,
  state TEXT NOT NULL,
  delay TEXT NOT NULL,
  branch INTEGER,
  transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX IF NOT EXISTS machine_timer_tick_transaction
  ON public.machine_timer_tick (transaction_id, machine);
CREATE INDEX IF NOT EXISTS schedule_machine_timer_owner
  ON public.schedule USING gin (emits_values) WHERE emits_entity = 'machine_timer_tick';
ALTER TABLE public.machine_timer_tick ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.machine_timer_tick FROM PUBLIC;
DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'app_user'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON public.machine_timer_tick FROM %I', r);
    END IF;
  END LOOP;
END
$$;
