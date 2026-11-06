CREATE SCHEMA IF NOT EXISTS airlock;
REVOKE ALL ON SCHEMA airlock FROM PUBLIC;

CREATE TABLE IF NOT EXISTS airlock.internal_work (
  name TEXT PRIMARY KEY,
  task TEXT NOT NULL UNIQUE,
  lock BIGINT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS airlock.internal_work_pool (
  pool TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES airlock.internal_work (name)
);

CREATE TABLE IF NOT EXISTS airlock.internal_work_ledger (
  key TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  input JSONB NOT NULL,
  machine TEXT NOT NULL,
  instance UUID NOT NULL,
  done_event TEXT NOT NULL,
  failed_event TEXT NOT NULL,
  outcome JSONB,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  CHECK ((outcome IS NULL) = (settled_at IS NULL))
);

CREATE OR REPLACE FUNCTION airlock.enqueue_work(
  task TEXT, key TEXT, input JSONB, machine TEXT, instance UUID,
  done_event TEXT, failed_event TEXT,
  run_at TIMESTAMPTZ DEFAULT now(), max_attempts INT DEFAULT 25
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, airlock AS $enqueue$
DECLARE inserted INT; prior airlock.internal_work_ledger;
BEGIN
  IF task = '' OR key = '' OR machine = '' OR done_event = '' OR failed_event = '' OR run_at IS NULL OR max_attempts IS NULL OR max_attempts < 1 THEN
    RAISE EXCEPTION 'invalid internal work declaration';
  END IF;
  INSERT INTO airlock.internal_work_ledger (key, task, input, machine, instance, done_event, failed_event)
    VALUES (key, task, input, machine, instance, done_event, failed_event)
    ON CONFLICT ON CONSTRAINT internal_work_ledger_pkey DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  SELECT l.* INTO STRICT prior FROM airlock.internal_work_ledger l WHERE l.key = enqueue_work.key FOR UPDATE;
  IF prior.task IS DISTINCT FROM task OR prior.input IS DISTINCT FROM input OR prior.machine IS DISTINCT FROM machine
    OR prior.instance IS DISTINCT FROM instance OR prior.done_event IS DISTINCT FROM done_event OR prior.failed_event IS DISTINCT FROM failed_event THEN
    RAISE EXCEPTION 'internal work key % has incompatible input or destination', key;
  END IF;
  IF inserted = 1 THEN
    PERFORM graphile_worker.add_job(task, json_build_object('key', key),
      queue_name => 'internal:' || task, run_at => run_at,
      max_attempts => max_attempts, job_key => 'internal:' || key);
  END IF;
END;
$enqueue$;

CREATE OR REPLACE FUNCTION airlock.settle_work(key TEXT, kind TEXT, payload JSONB DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, airlock AS $settle$
DECLARE work airlock.internal_work_ledger; receipt JSONB; event_name TEXT;
BEGIN
  IF kind NOT IN ('done', 'failed') OR kind IS NULL OR payload IS NULL THEN
    RAISE EXCEPTION 'invalid internal work outcome';
  END IF;
  SELECT l.* INTO STRICT work FROM airlock.internal_work_ledger l WHERE l.key = settle_work.key FOR UPDATE;
  receipt := jsonb_build_object('kind', kind, 'payload', payload);
  IF work.outcome IS NOT NULL THEN
    IF work.outcome IS DISTINCT FROM receipt THEN
      RAISE EXCEPTION 'internal work key % already has a different outcome', key;
    END IF;
    RETURN;
  END IF;
  event_name := CASE kind WHEN 'done' THEN work.done_event ELSE work.failed_event END;
  UPDATE airlock.internal_work_ledger l
    SET outcome = receipt, settled_at = clock_timestamp()
    WHERE l.key = settle_work.key;
  EXECUTE format('SELECT %I.deliver($1, $2)', 'hybrid_' || work.machine)
    USING work.instance, jsonb_build_object('kind', event_name, 'payload', payload);
END;
$settle$;

ALTER TABLE airlock.internal_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE airlock.internal_work_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE airlock.internal_work_ledger ENABLE ROW LEVEL SECURITY;
DO $private$
DECLARE grant_ RECORD;
BEGIN
  FOR grant_ IN
    SELECT DISTINCT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname = 'airlock' AND a.grantee <> n.nspowner
    UNION
    SELECT DISTINCT 'TABLE', format('%I.%I', n.nspname, c.relname), a.grantee
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname = 'airlock' AND c.relname IN ('internal_work', 'internal_work_pool', 'internal_work_ledger') AND a.grantee <> c.relowner
    UNION
    SELECT DISTINCT 'FUNCTION', p.oid::regprocedure::text, a.grantee
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE n.nspname = 'airlock' AND p.proname IN ('enqueue_work', 'settle_work') AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s', grant_.kind, grant_.name,
      CASE WHEN grant_.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_.grantee)) END);
  END LOOP;
END;
$private$;
