-- The identity table the auth service mints tokens against: one row per
-- subject, keyed by the token's `sub`. A consumer's migrations create their
-- own; this is mecha's own stack's. It sits outside migrations/ because it
-- calls the tenancy floor, which Atlas's replay of that directory never has.
CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  scope_id text GENERATED ALWAYS AS ('user:' || id::text) STORED NOT NULL
);
CALL rls_protect('app_user');

-- A subject syncs its own row. Electric validates the publication rather than
-- building it, and serves only a table whose replica identity is FULL.
ALTER TABLE app_user REPLICA IDENTITY FULL;
ALTER PUBLICATION electric_publication_default ADD TABLE app_user;
