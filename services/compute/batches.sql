CREATE SCHEMA IF NOT EXISTS compute;
REVOKE ALL ON SCHEMA compute FROM PUBLIC;
CREATE TABLE IF NOT EXISTS compute.definition (
  name text PRIMARY KEY,
  instance_id uuid NOT NULL UNIQUE,
  version text NOT NULL,
  reads text[] NOT NULL,
  parents text[] NOT NULL,
  ordinal integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS compute.capture (
  instance_id uuid PRIMARY KEY REFERENCES hybrid_compute_batch.instance,
  inputs jsonb,
  last_superseded jsonb
);
REVOKE ALL ON ALL TABLES IN SCHEMA compute FROM PUBLIC;

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
      WHERE n.nspname='compute' AND a.grantee<>c.relowner
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
