-- A machine's steps run read committed, ordered by locks rather than by a
-- snapshot: a step holds each player of its instance (hold) before it locks
-- any row, so two steps sharing a player run one after the other, and a check
-- reading that player's other instances (seated elsewhere, unavailable) reads
-- them settled. Steps sharing no player share no lock and never abort each
-- other. Under serializable they did: PostgreSQL locks a serializable read by
-- index page, so two players writing their own rows of one small table read
-- each other's page, one was aborted for a conflict no data caused, and the
-- writer took the abort as final. The roles that drive a step, app_user through
-- the gateway and service for the ticker, keep the database's default, which a
-- database built when they were serializable gets back here.
DO $isolation$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN ALTER ROLE app_user RESET default_transaction_isolation; ALTER ROLE app_user RESET enable_seqscan; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service') THEN ALTER ROLE service RESET default_transaction_isolation; ALTER ROLE service RESET enable_seqscan; END IF;
END $isolation$;
-- A step that waited for a player must read what that player's last step
-- left, which a snapshot taken before the wait would not show.
CREATE OR REPLACE FUNCTION hybrid_compute_batch.serial() RETURNS void LANGUAGE plpgsql AS $serial$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a compute_batch step runs read committed, not %', current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;
END;
$serial$;
