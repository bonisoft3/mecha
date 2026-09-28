# Row-level security: the tenancy floor

The row isolation every mecha database has, whatever generated the tables above
it. Live: the database image (bayt.cue, `database-image`) bakes this in as
`/docker-entrypoint-initdb.d/003_rls.sql`, so it is present before any
app-emitted table and whether or not a generator ran at all.

**Scope: shared stores only.** It applies to the tables in the cluster's
database. An app that keeps all its data in the browser has no schema here, so it
gets no policies — a boundary between one subject and themselves is not one.

Where the database runs does not change the floor. The same tables in PGlite in
a browser get **the same policies**, with the shim setting
`app.scopes` where a server would use `db-pre-request` or the gatekeeper. PGlite connects as a
superuser and superusers bypass RLS, so this needs `SET ROLE` to a non-superuser
first — `applyScopeSession()` in `@mecha/postgrest-js`. With it the enforcement
is identical; what differs is only that the scope set is asserted by local code
rather than derived from a verified token. A scope bug
therefore surfaces in the fast loop rather than only in the slow one.
And it guards the **CRUD** path: Electric reads the WAL and never evaluates RLS,
so the sync path's boundary is the gatekeeper, not this. Electric's own database
role therefore needs `BYPASSRLS`, or `FORCE` empties every shape silently.

**It is a boundary for requests, not for connections.** `app.scopes` is a
placeholder GUC, so it carries `USERSET` context and any session can set its own:
`SET app.scopes = 'user:someone-else'` widens the floor to whatever the caller
names. `REVOKE SET ON PARAMETER` does not restrain a placeholder, so this is a
property of the mechanism rather than an omission. It costs nothing on the HTTP
path, where `app_pre_request()` overwrites the setting from the verified token on
every request before any statement runs. What it means is that a database
credential *is* the trust boundary: anyone who can open a session as `app_user`
or `anon` holds every scope, and the floor is not the thing standing between
them and the data.

Nor does it hide the catalog. `mecha.rls_audit()` is `REVOKE`d from `PUBLIC`, but
it reads `pg_class`/`pg_policy`, which are world-readable — a session that can
run SQL can re-derive the same list by hand. The revoke keeps the audit off
casual and PostgREST-served paths; it is not a seal.

```
psql -d <db> -f rls.sql
psql -d <db> -f rls_test.sql      # WARNING: rls: 57/57 pass
```

Design: `docs/superpowers/specs/2026-09-05-permissions-design.md`.

## Why this lives in mecha and not in the generator

The floor's whole value is that it holds **even when the generator is bypassed** —
a hand-written migration, a table added out of band. A guarantee that lives in
the generator is weaker than one that does not, so the mechanism and its audit
belong to the database.

That gives a clean seam:

- **mecha** owns the mechanism: `current_scopes()`, `auth_uid()`,
  `rls_protect()`, and the audit (`mecha.rls_unprotected`). The policy text
  exists in exactly one place.
- **The generator** that writes an app's migrations owns application: it emits
  `CALL rls_protect('<table>')` and the `scope_id` derivation for the entity's
  access mode. It never emits the policy text, so it cannot emit a subtly wrong
  one, and a correction reaches every app by migration rather than by
  regeneration.

## What the gate proves

`rls_test.sql` is the list; it raises on the first failure and names it, so it is
read by running it rather than by keeping a copy here in step. Every fixture
carries a deliberately maximal permissive policy (`FOR ALL USING (true) WITH
CHECK (true)`), so the floor is tested against the worst thing a rules layer
could emit.

It covers four groups:

- **The floor binds.** Reads bounded despite `USING (true)`; `INSERT` and
  `UPDATE` into an unheld scope refused; deny-by-default; unset scopes failing
  closed; a second role with its own permissive policy still inside it.
- **The derivation cannot lie.** `owned` scoping through a generated column, a
  client-supplied `scope_id` refused by Postgres itself, no inserting or
  re-owning a row to another subject, and `rls_protect` refusing a nullable
  `scope_id` — a NULL scope fails `= ANY()`, so the row would be invisible
  forever while the audit called the table protected.
- **The audit cannot be fooled.** It rejects a permissive `tenancy`, one bound to
  a single role, a table not `FORCE`d, one `FORCE`d but not `ENABLE`d, and floors
  that are `FOR SELECT` or `FOR UPDATE` only — the second matters because it
  carries *both* quals and so passes a text pin alone. It sees partitioned
  parents, other schemas, views without `security_invoker`, and materialized
  views; it does not flag temp tables or a `security_invoker` view; and it pins
  its own `search_path`, so a shadowing `current_scopes()` on the caller's path
  cannot make an open policy read as the floor.
- **It survives operation.** `rls_protect` applied twice, and the suite run twice
  against a database that already contains other tables.

**Every term of the audit predicate is held down by one of these**, checked by
deleting each term in turn and confirming the suite fails. Re-run that sweep
after any change to the predicate, and read a term that survives as a fixture
missing, not a term redundant: mutation testing shows which mutants the fixtures
catch, not which terms are needed.

The suite creates and drops its own `_f_app` and `_f_anon` roles, so it needs no
roles to pre-exist.

## Deriving `scope_id`

The caller derives `scope_id` for each table and calls `rls_protect`; a table it
leaves unfloored goes into `mecha.rls_exempt` with its reason, which is the short
list a reviewer reads. The derivations in use:

| Table | `scope_id` | Floored |
|---|---|---|
| owned by a subject | `GENERATED ALWAYS AS ('user:' \|\| owner) STORED` | yes |
| a child of a composition | the parent's, copied by a trigger, since a generated column cannot reach another table; a child of no parent gets a foreign-key violation where the column naming its parent is a foreign key, and is dropped without a word (`RETURN NULL`) where it is not | as its parent |
| public | `GENERATED ALWAYS AS ('public:') STORED`, a scope every subject holds | yes |
| the identity table | `'user:' \|\| id`, so a person reads their own row | exempt; its self-select policy alone admits a reader |
| shared per object | the owner's, carried for the shape predicate and for a child's trigger | exempt: the floor is restrictive, so it ANDs, and a sharee holds no scope the owner's row carries; the share policies govern CRUD |
| service only | none | exempt; no policy admits `app_user` or `anon`, and `service` reads by `BYPASSRLS` |

The share policies are the one place a row reaches a subject whose scopes do not
include it, so their bugs are breaches rather than outages, and they are the
policies most in need of tests of their own.

The sync path reads the same scopes. A shape token's `where` is
`scope_id IN (<the subject's scopes>)`, built from `subject_scopes` by
`services/auth/jwt.ts`: the derivation the CRUD path's floor uses, so the two
paths cannot disagree about a subject's reach.
