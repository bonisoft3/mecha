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
applies it in name order on an empty data directory. The image adds one step of
its own, the tenancy floor `002a_rls.sql`, after mecha's `002` grants and before
a caller's `005` that calls `rls_protect` ([its contract](../services/database/rls/README.md)).

The initdb set has no runner and no revision table: **the steps that ran are
the files the image carries.** A new database gets a change by being built from
the image; one that keeps its data directory never applies a changed file, and
is [carried forward](#carrying-a-live-database-forward) instead.
Compose keeps no data directory: `PGDATA` sits on the container's writable
layer, every migration is a `develop: watch` rebuild entry, a rebuild
recreates the container empty, and every service waiting on the database's
health restarts with it.

`surface.schema` publishes `{target: "database", initdb:
"/docker-entrypoint-initdb.d"}`, so anything that applies, inspects or
reproduces the schema reads that service and directory instead of copying the
layout.

## mecha's own tables, from protobuf

```
proto/*.proto   ── task buf:generate (protoschema-jsonschema v0.5.2) ─► gen/jsonschema/
tmpl.cue        ── embeds each entity listed in _entityBase ─► Entities
tmpl_tool.cue   ── task cue:generate: cue export | jq | gomplate ─► schemas/schema.hcl
task atlas:diff ── atlas migrate diff ─► migrations/<version>_<name>.sql, atlas.sum
bayt.cue        ── state.migrations ─► the database image
```

- **`task generate` writes no migration.** It runs the first two steps and
  `task atlas:hash`. `task atlas:diff -- <name>` writes the file, and the file
  reaches the image once it is listed in `state.migrations`. Until then the HCL
  and the directory disagree, and nothing notices.
- **The template** ([`schema.hcl.tmpl`](../services/database/schemas/schema.hcl.tmpl))
  gives every table `id uuid DEFAULT uuidv7()` as its primary key, `createdAt`,
  `updatedAt`, and the write-back's nullable `processed_at` and `source`. Every
  other field is a `NOT NULL` column under its JSON name, so `user_id` becomes
  `"userId"`: strings `varchar(maxLength)` (255 without one), bools `boolean`,
  repeated fields `jsonb`, every number and enum `integer`. Message-typed fields
  are skipped. Of the protovalidate rules only `max_len` reaches the table.
- **Atlas authors; it does not run.** `atlas migrate diff` replays the
  migrations directory on a throwaway `postgres:18` in Docker, diffs it against
  the HCL and writes the next file. `atlas.sum` is its checksum of that
  directory, and Atlas refuses to diff past a stale one: after editing a
  migration by hand, `task atlas:hash`. No image carries Atlas, nothing reads
  `atlas.sum` at runtime, and Atlas's replay never sees the tenancy floor or
  `tests/validation-smoke.sql`.

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

- **PostgREST** reads the catalog once: a new column answers 400 and a new
  table 404 until `NOTIFY pgrst, 'reload schema';`.
- **Electric** caches relation OIDs. `ADD COLUMN` keeps the OID and the shapes;
  a drop-and-recreate shifts it, and Electric reports the table dropped and
  stops serving the shape. This is the sharpest argument for additive change.
- **Conduit** has to restart with a reset database, and forwards a new table
  only once `tables` names it ([change capture](change-capture.md#what-bites)).
- **The lake** resolves parquet columns by `field_id`, so a rename or drop is
  metadata there: the one holder for which a rename is cheap, which is why it
  cannot justify one elsewhere ([@mecha/lake](../packages/lake/README.md)).
- **A hand-written copy of the tables** is a schema change nobody applies.

## Carrying a live database forward

**Not built.** A database that keeps its data directory has its schema changed
in place, and that is mecha's job, done with pgroll. No tier does it:
compose recreates the database empty, and nothing in the cluster runs pgroll
against a live database ([pending](../PENDING.md#schema)).

pgroll keeps a ledger, so a migration runs once and a rerun reports the
database up to date. The initdb set stays the record of how a fresh volume was
built; pgroll's ledger is the record of what came after. Expand-and-contract,
both shapes exposed through per-version schemas, is for a change that needs two
shapes live at once. The readers keyed on the table, the REST gateway, the sync
shapes and row-level security, then have to be pointed at the version schema,
so it is a choice for one change, not the default.

## What bites

- **Every number is a 32-bit `integer`.** protoschema spells every numeric kind
  and every enum as an `anyOf` with a string arm, and the template maps any
  `anyOf` to `integer`, so its `number` branch never fires for protobuf: an
  `int64` overflows past 2³¹ and a `double` refuses a fraction.
- **Two casings in one table.** Generated columns are camelCase JSON names, the
  write-back's columns snake_case; a pipeline or query writes each as the table
  spells it.
- **A migration hash mismatch** is Atlas refusing a hand-edited directory:
  `task atlas:hash`.

## Reproducing what a schema built

Since the steps are the image's files, a database's schema can be rebuilt from
the image alone: start it, read the initdb directory, apply the steps in name
order. Each step's catalog is a state to compare, and consecutive states show a
change the SQL text hides. Who compares, and what they refuse, is the caller's
business.

## Rejected

- **Replaying the initdb set on a live database.** Without a ledger, every
  statement has to survive a second run, and `CREATE TABLE IF NOT EXISTS`
  keeps a table's old shape without a word.
- **Expand-and-contract for every change.** Each one would move the REST
  gateway, the sync shapes and row-level security onto a new version schema.
- **Atlas's declarative apply** (`atlas schema apply` from the HCL). It computes
  the change against the live database at deploy time, drops included: a plan
  nobody read. A versioned file is read before it ships.
- **Drop-and-recreate to change a table.** It shifts the OID, and Electric stops
  serving every shape on it.
- **A rename because the lake takes it cheaply.** Every other holder pays for
  it.
