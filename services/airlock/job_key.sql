-- The Graphile job key of a ledger key: its SHA-256 as hex, since Graphile
-- caps a job key at 512 bytes and a ledger key carries the effect's key fields
-- whole, a translation's every card among them. Every enqueue, lease, claim
-- and removal of a key's job goes through it; the job's payload names the
-- ledger key as it is.
CREATE OR REPLACE FUNCTION airlock.job_key(key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN encode(sha256(convert_to(key, 'UTF8')), 'hex');

-- The read journal: one row per read a row took the answer of, written in the
-- commit that moved the row (airlock.ts deliverRead). Its key is
-- '<effect>:<row's key>:<incarnation>:<n>', the incarnation the uuid a row
-- takes at its insert and n its count of entries into the invoking state, so
-- replay, re-running the row's transitions, reaches the same key
-- and is answered from `outcome`; `digest`, of the input's text, tells a
-- history that diverged. A read claims nothing before its call, so this is
-- no ledger: it records what happened. Here rather than in airlock.sql
-- because this step also runs at every release (#AirlockUpgradeSql), so a
-- database built before it takes it; closed as the ledger is.
CREATE TABLE IF NOT EXISTS airlock.read_journal (
  key         TEXT PRIMARY KEY,
  effect      TEXT NOT NULL,
  row         JSONB NOT NULL,
  incarnation TEXT NOT NULL,
  n           INT NOT NULL,
  digest      TEXT NOT NULL,
  outcome     JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- A table made before entries named their incarnation gains the column.
ALTER TABLE airlock.read_journal ADD COLUMN IF NOT EXISTS incarnation TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS read_journal_effect ON airlock.read_journal (effect);
ALTER TABLE airlock.read_journal ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE g RECORD;
BEGIN
  FOR g IN
    SELECT DISTINCT a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'airlock.read_journal'::regclass AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON airlock.read_journal FROM %s',
      CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
END
$$;
