-- What an app's schema asks of the build: an ICU collation over the root
-- locale (icu-root.tgz), a PL/pgSQL trigger (plpgsql linked in), and a DO
-- block.
CREATE COLLATION search (provider = icu, locale = 'und-u-ks-level1', deterministic = false);

CREATE TABLE team (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  search_name text COLLATE search GENERATED ALWAYS AS (name) STORED,
  txid text
);

CREATE FUNCTION stamp_txid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.txid := pg_current_xact_id()::text;
  RETURN NEW;
END $$;
CREATE TRIGGER team_txid BEFORE INSERT OR UPDATE ON team FOR EACH ROW EXECUTE FUNCTION stamp_txid();

DO $$ BEGIN
  INSERT INTO team (name) VALUES ('Grêmio-RS'), ('Flamengo-RJ'), ('Atlético-MG');
END $$;
