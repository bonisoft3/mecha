---
type: concept
title: Schema and its changes
description: How a schema reaches the database as initdb SQL, mecha's own tables from protobuf, what notices a change, and carrying a live database forward.
---

# Schema and its changes

mecha does not know what an entity is. A cluster is given a list of SQL files
and runs the data plane they describe: Postgres, the REST gateway, sync, the
change feed. Whether a change is permitted belongs to whoever declared the
tables. mecha's own stack writes its list from protobuf, which is one way
to write it.

## How a schema reaches the database

`state.migrations` in [`cluster.cue`](../cluster.cue) is the list. The
`database` target copies it into `/docker-entrypoint-initdb.d`, and postgres
applies it in name order on an empty data directory. Every step's name opens
with three digits no other step holds, then `_`, and the cluster refuses any
other: postgres globs the directory in its locale's order, which skips
punctuation, and anything replaying it sorts by byte, and only such names
put both in one order. Two steps are mecha's own, and their digits are taken:

- **`003_rls.sql`, the tenancy floor**, in every database
  ([its contract](../services/database/rls/README.md)). It also defines
  `auth_uid()`, the subject every row policy reads
  ([the token contract](../services/auth/README.md)), so it runs after the
  extensions, roles and grants a caller opens with and before its tables,
  whose column defaults may call it, and its policies, which call
  `rls_protect`.
- **`020_schedule.sql`, the table the ticker sweeps**, where the cluster
  declares a schedule
  ([the ticker](../services/ticker/README.md#one-table-of-mechas-and-the-apps-own)).
  The image stages it outside the initdb directory and the `database` target
  places it there, after a caller's grants and before the seed the caller
  names after it.

The initdb set has no runner and no revision table: **the steps that ran are
the files in the image's initdb directory.** A new database gets a change by
being built from the image; one that keeps its data directory never applies a
changed file, and is [carried forward](#carrying-a-live-database-forward)
instead.
Compose keeps no data directory: `PGDATA` sits on the container's writable
layer, every migration is a `develop: watch` rebuild entry, a rebuild
recreates the container empty, and every service waiting on the database's
health restarts with it.

`surface.schema` publishes `{target: "database", initdb:
"/docker-entrypoint-initdb.d"}`, and for a cluster given pgroll migrations
`pgroll: {target: "migrate", dir: "/pgroll", baseline: "00_initdb"}`, so
anything that applies, inspects or reproduces the schema reads those services
and directories instead of copying the layout.

## mecha's own tables, from protobuf

```
proto/*.proto   ── task buf:generate (protoschema-jsonschema v0.5.2) ─► gen/jsonschema/
tmpl.cue        ── embeds each entity's JSON Schema ─► Entities
bayt.cue        ── state.migrations ─► the database image
```

- **`task buf:generate`** derives JSON Schemas from protobuf definitions.
- **The tables** are declared with `id uuid DEFAULT uuidv7()` as primary key, `createdAt`,
  `updatedAt`, and write-back fields `processed_at` and `source`.
- **Migrations** are applied in numerical order (`001_...sql`, `002_...sql`, etc.) on fresh volumes
  at initdb, and live database evolution is handled via `state.pgroll`.

## What else names an entity

Generation reaches the tables and nothing else. Each of these names entities by
hand, and a new entity is missing from it until someone adds it:

- the Conduit template's `tables`, which decides what is captured
  ([change capture](change-capture.md#what-bites));
- the Electric publication, `005_electric_publication.sql`, since the cluster
  runs Electric with `ELECTRIC_MANUAL_TABLE_PUBLISHING`;
- each pipeline's `meta collection`, and each Arroyo source's columns
  ([streaming joins](streaming-joins.md#what-runs)).

The Caddyfile names none: `/crud/*` reaches every table PostgREST sees.

## What notices a change

A database changed in place, under running services:

- **PostgREST** serves from a schema cache it reads once. It checks the columns
  a write names against that cache, so a write to a new column answers 400, and
  a new table 404, until `NOTIFY pgrst, 'reload schema';`, which the migrate
  step sends. A read of a new column passes unchecked.
- **Electric** caches relation OIDs. `ADD COLUMN` keeps the OID and the shapes,
  and a shape learns the column from the relation message logical replication
  sends ahead of the table's next write, not from the catalog: until a row is
  written, a shape keeps the columns it started with. A drop-and-recreate
  shifts the OID, and Electric reports the table dropped and stops serving the
  shape. This is the sharpest argument for additive change.
- **Conduit** has to restart with a reset database, and forwards a new table
  only once `tables` names it ([change capture](change-capture.md#what-bites)).
- **The lake** resolves parquet columns by `field_id`, so a rename or drop is
  metadata there: the one holder for which a rename is cheap, which is why it
  cannot justify one elsewhere ([@mecha/lake](../packages/lake/README.md)).
- **A hand-written copy of the tables** is a schema change nobody applies.

## Carrying a live database forward

A database that keeps its data directory has its schema changed in place, with
pgroll. `state.pgroll` takes the changes, keyed by name, in pgroll's own grammar
([`pgroll/`](../pgroll/)): `#Name` keeps name order the same under every
collation and refuses the baseline's name, and `#Migration` is the grammar
without the `name` field the pinned pgroll's reader refuses. A cluster given
any runs a one-shot `migrate` target between the database turning healthy and
its readers starting. crud, auth, electric and conduit wait on it completing,
so a migration that fails stops them all rather than leaving them to serve the
schema it did not reach. A cluster given none has no `migrate` target, and one
without a database refuses them.

Each migration is written into the migrate image from the value, as a heredoc
in its Dockerfile, so the image holds exactly what `cue vet` accepted. The
runner, [`services/migrate/migrate.sh`](../services/migrate/migrate.sh), runs
`pgroll init`, records the schema initdb built as the baseline `00_initdb` once,
whether the volume is fresh or predates the runner, then runs
`pgroll start --complete` for each migration the ledger lacks, in byte order,
and checks the ledger after each. It ends with `NOTIFY pgrst, 'reload schema'`,
so a PostgREST already running serves the new columns without a restart. It
exits non-zero on anything short of that, including a migration that sorts
before one the database already applied: a fresh volume would apply it first,
and two databases built from one set would differ.

pgroll keeps a ledger, so a migration runs once and a boot over an applied set
changes nothing. The initdb set stays the record of how a fresh volume was
built; pgroll's ledger is the record of what came after. A migration the schema
initdb builds has since absorbed can leave the set, because the runner applies
only what the ledger lacks. Each migration completes as it starts: no two
versions of a table are served at once, and the readers keyed on the table, the
REST gateway, the sync shapes and row-level security, stay on `public`.

Compose runs the step on every boot. No other tier runs it yet
([pending](../PENDING.md#tiers-and-clouds)); the browser tier never will,
because PGlite cannot run pgroll.

## What bites

- **Every number is a 32-bit `integer`.** protoschema spells every numeric kind
  and every enum as an `anyOf` with a string arm, and the template maps any
  `anyOf` to `integer`, so its `number` branch never fires for protobuf: an
  `int64` overflows past 2³¹ and a `double` refuses a fraction.
- **Two casings in one table.** Generated columns are camelCase JSON names, the
  write-back's columns snake_case; a pipeline or query writes each as the table
  spells it.

## Reproducing what a schema built

Since the steps are the images' files, a database's schema can be rebuilt from
the images alone: start the database image, read the initdb directory and apply
the steps in name order, then, with the migrate image's pgroll, baseline and
start each migration it holds. Each step's catalog is a state to compare, and
consecutive states show a change the SQL text hides. Who compares, and what
they refuse, is the caller's business.

## Rejected

- **Replaying the initdb set on a live database.** Without a ledger, every
  statement has to survive a second run, and `CREATE TABLE IF NOT EXISTS`
  keeps a table's old shape without a word.
- **Expand-and-contract for every change.** Each one would move the REST
  gateway, the sync shapes and row-level security onto a new version schema.
- **`pgroll migrate` as the runner.** It refuses a directory that an applied
  migration has since left, so a migration folded into the initdb schema would
  fail every live database's next boot. It exits 0 having applied nothing when
  a migration is active or the schema has no baseline, and it skips a file
  whose name sorts at or below the baseline's.
- **The migrations as files beside the value.** A second copy of what `cue vet`
  accepted, free to disagree with it.
- **Atlas's declarative apply** (`atlas schema apply` from the HCL). It computes
  the change against the live database at deploy time, drops included: a plan
  nobody read. A versioned file is read before it ships.
- **Drop-and-recreate to change a table.** It shifts the OID, and Electric stops
  serving every shape on it.
- **A rename because the lake takes it cheaply.** Every other holder pays for
  it.
