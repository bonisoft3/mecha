// A secret field's tables (pronto's #Field.secret, seal.ts), which the airlock
// brings at its start where an effect reads one, beside publishing its key,
// and the edge's object at its boot: every statement idempotent and run at
// every start, so a database that outlived a release gains them with no
// migration, and airlock.sql, a step a retained database has applied, stays as
// it was.
//
// airlock.secret holds a secret field's sealed value from the write that named
// it until the last effect naming it on its row settles, or `expires_at`, five minutes on: what
// the airlock opens for a handler beside its input, keyed by the row as the
// ledger's `row` names it. Only ciphertext sealed to the airlock's key, which
// no database, backup or program holds, so a logged table: an effect in flight
// keeps its value across a crash or a failover, and what the WAL and the
// backups keep opens for no one without the key. It is in the airlock's
// schema, which only its owner may use.
//
// public.airlock_seal holds the public half of the seal key, which the screen
// seals a secret field to: one row, written at each start by whoever holds the
// key, read through crud by every client role and written by none of them.
// Whatever a grant gave either table is revoked first, as airlock.sql revokes
// it from the ledger.

export const SEAL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS airlock.secret (
  tbl        TEXT NOT NULL,
  row        JSONB NOT NULL,
  field      TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tbl, row, field)
);
ALTER TABLE airlock.secret ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.airlock_seal (
  kid TEXT PRIMARY KEY,
  key JSONB NOT NULL
);
ALTER TABLE public.airlock_seal ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE
  g RECORD;
  r TEXT;
BEGIN
  FOR g IN
    SELECT DISTINCT c.oid::regclass::text AS name, a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid IN ('airlock.secret'::regclass, 'public.airlock_seal'::regclass)
       AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %s', g.name,
      CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon', 'app_user', 'service'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT ON public.airlock_seal TO %I', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.airlock_seal'::regclass AND polname = 'airlock_seal_read') THEN
    CREATE POLICY airlock_seal_read ON public.airlock_seal FOR SELECT USING (true);
  END IF;
  IF to_regclass('mecha.rls_exempt') IS NOT NULL THEN
    INSERT INTO mecha.rls_exempt VALUES ('public.airlock_seal', 'the seal key''s public half: readable by all, written by the airlock alone')
      ON CONFLICT DO NOTHING;
  END IF;
END
$$;
`;

/** The tables brought up to date and the current key's public half published,
 * in one transaction: the page never reads a key the airlock no longer holds. */
export const PUBLISH_SEAL_SQL = `
WITH gone AS (DELETE FROM public.airlock_seal WHERE kid <> $1)
INSERT INTO public.airlock_seal (kid, key) VALUES ($1, $2) ON CONFLICT (kid) DO UPDATE SET key = EXCLUDED.key`;
