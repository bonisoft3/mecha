-- After rls.sql: an app whose rows belong to their writer, kept to them by the
-- floor (scope `user:<owner>`) and a policy on auth_uid(), with a shared table
-- every subject reaches through `public:`.
CREATE ROLE app_user NOLOGIN;
GRANT USAGE ON SCHEMA public TO app_user;

CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);

CREATE TABLE note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner uuid NOT NULL DEFAULT auth_uid(),
  body text NOT NULL,
  scope_id text GENERATED ALWAYS AS ('user:' || owner) STORED NOT NULL
);
CALL rls_protect('note');
CREATE POLICY own ON note FOR ALL USING (owner = auth_uid()) WITH CHECK (owner = auth_uid());
GRANT SELECT, INSERT, UPDATE, DELETE ON note TO app_user;

CREATE TABLE board (
  id integer PRIMARY KEY,
  title text NOT NULL,
  scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
);
CALL rls_protect('board');
CREATE POLICY everyone ON board FOR SELECT USING (true);
GRANT SELECT ON board TO app_user;
INSERT INTO board VALUES (1, 'Brasileirão 2026');
