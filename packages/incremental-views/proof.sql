BEGIN;
CREATE EXTENSION pg_ivm VERSION '1.13';
CREATE TABLE ivm_cards (id text PRIMARY KEY, set_id text NOT NULL, hint text NOT NULL);
CREATE TABLE ivm_art (id text PRIMARY KEY, card_id text NOT NULL, set_id text NOT NULL, level integer NOT NULL, run text NOT NULL, status text NOT NULL);
SELECT pgivm.create_immv('ivm_counts', $query$
  SELECT a.set_id, a.level, max(substring(a.run FROM 5)::integer) AS run_number,
    count(*) AS total,
    sum(CASE WHEN a.status = 'drawn' THEN 1 ELSE 0 END) AS drawn,
    sum(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) AS failed,
    sum(CASE WHEN a.status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
    sum(CASE WHEN a.status IN ('waiting', 'pending') THEN 1 ELSE 0 END) AS pending
  FROM ivm_art a JOIN ivm_cards f ON f.id = a.card_id
  GROUP BY a.set_id, a.level
$query$);
SELECT pgivm.create_immv('ivm_runs', $query$
  SELECT f.set_id, max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer) AS run_number
  FROM ivm_cards f GROUP BY f.set_id
$query$);
CREATE FUNCTION ivm_assert_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    (SELECT set_id, level, total FROM ivm_counts EXCEPT
     SELECT a.set_id, a.level, count(*) FROM ivm_art a JOIN ivm_cards f ON f.id = a.card_id GROUP BY a.set_id, a.level)
    UNION ALL
    (SELECT a.set_id, a.level, count(*) FROM ivm_art a JOIN ivm_cards f ON f.id = a.card_id GROUP BY a.set_id, a.level
     EXCEPT SELECT set_id, level, total FROM ivm_counts)
  ) THEN RAISE EXCEPTION 'AFTER statement consumer observed stale counts'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER cortex_ivm_proof AFTER INSERT OR UPDATE OR DELETE ON ivm_art FOR EACH STATEMENT EXECUTE FUNCTION ivm_assert_after();
CREATE TRIGGER cortex_ivm_proof AFTER INSERT OR UPDATE OR DELETE ON ivm_cards FOR EACH STATEMENT EXECUTE FUNCTION ivm_assert_after();
INSERT INTO ivm_cards VALUES ('a', 'deck', 'run-1'), ('b', 'deck', 'run-2'), ('c', 'other', 'run-1');
INSERT INTO ivm_art VALUES ('a:2', 'a', 'deck', 2, 'run-1', 'pending'), ('b:2', 'b', 'deck', 2, 'run-2', 'drawn'), ('c:2', 'c', 'other', 2, 'run-1', 'failed');
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM ivm_counts WHERE set_id = 'deck' AND total = 2 AND drawn = 1 AND pending = 1 AND run_number = 2) THEN
    RAISE EXCEPTION 'insert did not maintain joined counts';
  END IF;
END $$;
COMMIT;
BEGIN;
UPDATE ivm_art SET status = 'unknown' WHERE id = 'a:2';
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM ivm_counts WHERE set_id = 'deck' AND unknown = 1 AND pending = 0) THEN
    RAISE EXCEPTION 'view is not current inside the writing transaction';
  END IF;
END $$;
ROLLBACK;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM ivm_counts WHERE set_id = 'deck' AND unknown = 0 AND pending = 1) THEN
    RAISE EXCEPTION 'rollback left stale aggregate state';
  END IF;
END $$;
DELETE FROM ivm_cards WHERE id = 'b';
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM ivm_counts WHERE set_id = 'deck' AND total = 1 AND pending = 1 AND run_number = 1) OR
     NOT EXISTS (SELECT FROM ivm_runs WHERE set_id = 'deck' AND run_number = 1) THEN
    RAISE EXCEPTION 'deleting the maximum failed to maintain join and maxima';
  END IF;
END $$;
DELETE FROM ivm_cards WHERE id = 'a';
DO $$ BEGIN
  IF EXISTS (SELECT FROM ivm_counts WHERE set_id = 'deck') OR EXISTS (SELECT FROM ivm_runs WHERE set_id = 'deck') THEN
    RAISE EXCEPTION 'deleted group survived';
  END IF;
  IF NOT EXISTS (SELECT FROM ivm_counts WHERE set_id = 'other' AND total = 1 AND failed = 1) THEN
    RAISE EXCEPTION 'unrelated group was changed';
  END IF;
END $$;
