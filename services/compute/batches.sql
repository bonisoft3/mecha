CREATE SCHEMA IF NOT EXISTS compute;
REVOKE ALL ON SCHEMA compute FROM PUBLIC;
CREATE TABLE IF NOT EXISTS compute.definition (
  name text PRIMARY KEY,
  instance_id uuid NOT NULL UNIQUE,
  version text NOT NULL,
  reads text[] NOT NULL,
  to_tables text[] NOT NULL DEFAULT '{}'::text[],
  parents text[] NOT NULL,
  ordinal integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
ALTER TABLE compute.definition ADD COLUMN IF NOT EXISTS to_tables text[] NOT NULL DEFAULT '{}'::text[];
CREATE TABLE IF NOT EXISTS compute.capture (
  instance_id uuid PRIMARY KEY REFERENCES hybrid_compute_batch.instance,
  inputs jsonb,
  last_superseded jsonb,
  claimed_coverage jsonb,
  completed_coverage jsonb
);
ALTER TABLE compute.capture ADD COLUMN IF NOT EXISTS claimed_coverage jsonb;
ALTER TABLE compute.capture ADD COLUMN IF NOT EXISTS completed_coverage jsonb;
CREATE SEQUENCE IF NOT EXISTS compute.source_revision_seq;
CREATE TABLE IF NOT EXISTS compute.source (
  name text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT nextval('compute.source_revision_seq'),
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  lsn pg_lsn NOT NULL DEFAULT pg_current_wal_insert_lsn(),
  wal_seq bigint NOT NULL DEFAULT 0
);
ALTER TABLE compute.source ADD COLUMN IF NOT EXISTS lsn pg_lsn NOT NULL DEFAULT pg_current_wal_insert_lsn();
ALTER TABLE compute.source ADD COLUMN IF NOT EXISTS wal_seq bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS compute.wal (
  seq bigserial PRIMARY KEY,
  lsn pg_lsn NOT NULL DEFAULT pg_current_wal_insert_lsn(),
  table_name text NOT NULL,
  op "char" NOT NULL,
  row_data jsonb
);
CREATE INDEX IF NOT EXISTS wal_table_seq ON compute.wal (table_name, seq);
REVOKE ALL ON ALL TABLES IN SCHEMA compute FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA compute FROM PUBLIC;

CREATE OR REPLACE FUNCTION compute.touch_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
SET intervalstyle = 'iso_8601'
SET bytea_output = 'hex'
AS $$
DECLARE v_seq bigint;
BEGIN
  IF current_setting('compute.restoring_source', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    PERFORM 1 FROM compute.source WHERE name = TG_ARGV[0] FOR UPDATE;
    IF TG_NARGS > 1 AND TG_ARGV[1] = 'true' THEN
      INSERT INTO compute.wal(lsn, table_name, op, row_data)
      VALUES (pg_current_wal_insert_lsn(), TG_ARGV[0], 'T', NULL)
      RETURNING seq INTO v_seq;
    END IF;
    UPDATE compute.source
    SET revision = nextval('compute.source_revision_seq'),
        txid = pg_current_xact_id(),
        lsn = greatest(lsn, pg_current_wal_insert_lsn()),
        wal_seq = greatest(wal_seq, coalesce(v_seq, wal_seq))
    WHERE name = TG_ARGV[0];
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION compute.touch_source_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
SET intervalstyle = 'iso_8601'
SET bytea_output = 'hex'
AS $$
DECLARE v_seq bigint;
BEGIN
  IF current_setting('compute.restoring_source', true) IS DISTINCT FROM pg_current_xact_id()::text
     AND EXISTS (SELECT 1 FROM affected) THEN
    PERFORM 1 FROM compute.source WHERE name = TG_ARGV[0] FOR UPDATE;
    IF TG_NARGS > 1 AND TG_ARGV[1] = 'true' THEN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO compute.wal(lsn, table_name, op, row_data)
        SELECT pg_current_wal_insert_lsn(), TG_ARGV[0], 'I', to_jsonb(r) FROM affected r;
      ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO compute.wal(lsn, table_name, op, row_data)
        SELECT pg_current_wal_insert_lsn(), TG_ARGV[0], 'D', to_jsonb(r) FROM affected r;
      ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO compute.wal(lsn, table_name, op, row_data)
        SELECT pg_current_wal_insert_lsn(), TG_ARGV[0], 'D', to_jsonb(r) FROM old_affected r;
        INSERT INTO compute.wal(lsn, table_name, op, row_data)
        SELECT pg_current_wal_insert_lsn(), TG_ARGV[0], 'I', to_jsonb(r) FROM affected r;
      END IF;
      v_seq := currval('compute.wal_seq_seq');
      DELETE FROM compute.wal
      WHERE table_name = TG_ARGV[0]
        AND seq < coalesce(
          (SELECT w.seq FROM compute.wal w
           WHERE w.table_name = TG_ARGV[0]
           ORDER BY w.seq DESC OFFSET 4096 LIMIT 1),
          0
        );
    END IF;
    UPDATE compute.source
    SET revision = nextval('compute.source_revision_seq'),
        txid = pg_current_xact_id(),
        lsn = greatest(lsn, pg_current_wal_insert_lsn()),
        wal_seq = greatest(wal_seq, coalesce(v_seq, wal_seq))
    WHERE name = TG_ARGV[0];
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION compute.restore_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('compute.restoring_source', true) IS DISTINCT FROM pg_current_xact_id()::text THEN
    PERFORM set_config('compute.restoring_source', pg_current_xact_id()::text, true);
    DELETE FROM compute.wal;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS compute_source_restore ON compute.source;
CREATE TRIGGER compute_source_restore AFTER INSERT OR DELETE OR TRUNCATE ON compute.source
  FOR EACH STATEMENT EXECUTE FUNCTION compute.restore_source();
ALTER TABLE compute.source ENABLE ALWAYS TRIGGER compute_source_restore;

CREATE OR REPLACE VIEW compute.batch AS
SELECT d.name,d.version,(i.state->>'requested')::bigint AS requested,
  (i.state->>'completed')::bigint AS completed,
  nullif((i.state->>'wake')::bigint,0) AS wake,
  nullif((i.state->>'claimed')::bigint,0) AS claimed,c.inputs,c.last_superseded,
  coalesce((SELECT jsonb_object_agg(r->>'name',r->>'revision')
    FROM jsonb_array_elements(i.state->'required') r),'{}'::jsonb) AS required
FROM compute.definition d JOIN hybrid_compute_batch.instance i ON i.id=d.instance_id
LEFT JOIN compute.capture c ON c.instance_id=i.id;
REVOKE ALL ON compute.batch FROM PUBLIC;

CREATE OR REPLACE FUNCTION compute.lock_batches() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM i.id FROM hybrid_compute_batch.instance i
    JOIN compute.definition d ON d.instance_id=i.id ORDER BY d.name FOR UPDATE OF i;
END;
$$;

CREATE OR REPLACE FUNCTION compute.ready(instance_id uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT NOT EXISTS (
    SELECT FROM hybrid_compute_batch.instance i,
      jsonb_array_elements(i.state->'required') r
    LEFT JOIN compute.batch p ON p.name=r->>'name'
    WHERE i.id=instance_id AND (p.name IS NULL OR p.completed < (r->>'revision')::bigint)
  )
$$;

CREATE OR REPLACE FUNCTION compute.mark(names text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE fresh text[]; d record; requirements jsonb;
BEGIN
  SELECT coalesce(array_agg(name),'{}'::text[]) INTO fresh FROM compute.batch
    WHERE name=ANY(names) AND requested=coalesce(claimed,completed);
  FOR d IN SELECT * FROM compute.definition WHERE name=ANY(names) ORDER BY name LOOP
    PERFORM hybrid_compute_batch.deliver(d.instance_id,'{"kind":"invalidate","payload":{}}'::jsonb);
  END LOOP;
  FOR d IN SELECT * FROM compute.definition WHERE name=ANY(fresh) ORDER BY name LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.name,'revision',p.requested) ORDER BY p.name),'[]'::jsonb)
      INTO requirements FROM compute.batch p WHERE p.name=ANY(d.parents);
    PERFORM hybrid_compute_batch.deliver(d.instance_id,jsonb_build_object('kind','pin','payload',jsonb_build_object('required',requirements)));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION compute.schedule() RETURNS void LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  FOR d IN SELECT definition.* FROM compute.definition definition JOIN compute.batch b USING(name)
    WHERE definition.enabled AND b.wake IS NULL AND b.requested>b.completed AND compute.ready(definition.instance_id)
    ORDER BY definition.ordinal,definition.name LOOP
    PERFORM hybrid_compute_batch.deliver(d.instance_id,'{"kind":"schedule","payload":{}}'::jsonb);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION compute.invalidate(tables text[] DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE names text[];
BEGIN
  PERFORM compute.lock_batches();
  WITH RECURSIVE dirty(name) AS (
    SELECT name FROM compute.definition WHERE enabled AND (tables IS NULL OR reads && tables)
    UNION
    SELECT d.name FROM compute.definition d JOIN dirty p ON p.name=ANY(d.parents) WHERE d.enabled
  ) SELECT coalesce(array_agg(name),'{}'::text[]) INTO names FROM dirty;
  PERFORM compute.mark(names);
  PERFORM compute.schedule();
END;
$$;

CREATE OR REPLACE FUNCTION compute.tracked(p_name text) RETURNS boolean LANGUAGE sql AS $$
  SELECT (cardinality(d.reads) > 0 OR cardinality(d.to_tables) > 0)
    AND NOT EXISTS (
      SELECT FROM unnest(d.reads || d.to_tables) AS t(table_name)
      LEFT JOIN compute.source s ON s.name = t.table_name
      WHERE s.name IS NULL
    )
  FROM compute.definition d
  WHERE d.name = p_name
$$;

CREATE OR REPLACE FUNCTION compute.input_coverage(p_name text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE
    WHEN NOT compute.tracked(p_name) OR EXISTS (
      SELECT FROM unnest(d.parents) AS p(parent_name)
      LEFT JOIN compute.batch b ON b.name = p.parent_name
      WHERE b.name IS NULL OR b.completed = 0
    ) THEN NULL
    ELSE jsonb_build_object(
      'version', d.version,
      'reads', coalesce(
        (SELECT jsonb_object_agg(s.name, s.revision ORDER BY s.name)
         FROM unnest(d.reads) AS r(table_name)
         JOIN compute.source s ON s.name = r.table_name),
        '{}'::jsonb
      ),
      'parents', coalesce(
        (SELECT jsonb_object_agg(b.name, b.completed ORDER BY b.name)
         FROM unnest(d.parents) AS p(parent_name)
         JOIN compute.batch b ON b.name = p.parent_name),
        '{}'::jsonb
      )
    )
  END
  FROM compute.definition d
  WHERE d.name = p_name
$$;

CREATE OR REPLACE FUNCTION compute.sink_coverage(p_name text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE
    WHEN NOT compute.tracked(p_name) THEN NULL
    ELSE coalesce(
      (SELECT jsonb_object_agg(s.name, s.revision ORDER BY s.name)
       FROM unnest(d.to_tables) AS t(table_name)
       JOIN compute.source s ON s.name = t.table_name),
      '{}'::jsonb
    )
  END
  FROM compute.definition d
  WHERE d.name = p_name
$$;

CREATE OR REPLACE FUNCTION compute.current_coverage(p_name text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE
    WHEN i.cov IS NULL OR s.cov IS NULL THEN NULL
    ELSE i.cov || jsonb_build_object('to', s.cov)
  END
  FROM (SELECT compute.input_coverage(p_name) AS cov) i,
       (SELECT compute.sink_coverage(p_name) AS cov) s
$$;

CREATE OR REPLACE FUNCTION compute.reconcile(p_initial boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE names text[];
BEGIN
  PERFORM compute.lock_batches();
  WITH RECURSIVE dirty(name) AS (
    SELECT d.name
    FROM compute.definition d
    JOIN compute.batch b USING (name)
    LEFT JOIN compute.capture c ON c.instance_id = d.instance_id
    WHERE d.enabled AND (
      CASE
        WHEN b.claimed IS NOT NULL THEN
          (c.claimed_coverage IS NOT NULL AND (c.claimed_coverage - 'digest') IS DISTINCT FROM compute.input_coverage(d.name))
          OR (p_initial AND c.claimed_coverage IS NULL)
        WHEN b.completed > 0 THEN
          (p_initial OR compute.tracked(d.name) OR c.completed_coverage IS NOT NULL)
          AND (c.completed_coverage IS NULL OR (c.completed_coverage - 'digest') IS DISTINCT FROM compute.current_coverage(d.name))
        ELSE
          p_initial
      END
    )
    UNION
    SELECT d.name
    FROM compute.definition d
    JOIN dirty p ON p.name = ANY(d.parents)
    WHERE d.enabled
  ) SELECT coalesce(array_agg(name), '{}'::text[]) INTO names FROM dirty;
  PERFORM compute.mark(names);
  PERFORM compute.schedule();
END;
$$;

CREATE OR REPLACE FUNCTION compute.after_work(name text, published boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE names text[];
BEGIN
  IF published THEN
    SELECT coalesce(array_agg(d.name),'{}'::text[]) INTO names FROM compute.definition d
      WHERE d.enabled AND after_work.name=ANY(d.parents);
    PERFORM compute.mark(names);
  END IF;
  PERFORM compute.schedule();
END;
$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA compute FROM PUBLIC;

ALTER TABLE compute.definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.source ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.wal ENABLE ROW LEVEL SECURITY;
ALTER TABLE compute.machine_version ENABLE ROW LEVEL SECURITY;
DO $private$
DECLARE grant_ record;
BEGIN
  FOR grant_ IN
    SELECT DISTINCT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname='compute' AND a.grantee<>n.nspowner
    UNION
    SELECT DISTINCT 'TABLE', format('%I.%I',n.nspname,c.relname), a.grantee
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname='compute' AND c.relkind IN ('r','p','v') AND a.grantee<>c.relowner
    UNION
    SELECT DISTINCT 'SEQUENCE', format('%I.%I',n.nspname,c.relname), a.grantee
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a
      WHERE n.nspname='compute' AND c.relkind='S' AND a.grantee<>c.relowner
    UNION
    SELECT DISTINCT 'FUNCTION',p.oid::regprocedure::text,a.grantee
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
        aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE n.nspname='compute' AND a.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s',grant_.kind,grant_.name,
      CASE WHEN grant_.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_.grantee)) END);
  END LOOP;
END;
$private$;
