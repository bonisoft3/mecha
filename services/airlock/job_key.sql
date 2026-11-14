-- The Graphile job key of a ledger key: its SHA-256 as hex, since Graphile
-- caps a job key at 512 bytes and a ledger key carries the effect's key fields
-- whole, a translation's every card among them. Every enqueue, lease, claim
-- and removal of a key's job goes through it; the job's payload names the
-- ledger key as it is.
CREATE OR REPLACE FUNCTION airlock.job_key(key text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN encode(sha256(convert_to(key, 'UTF8')), 'hex');
