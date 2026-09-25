# A schema that moves

Mecha does not know what an entity is. It is given a schema — a list of SQL
files — and it runs the data plane that schema describes: Postgres, a REST
gateway over it, a sync service, a change feed, a lake. This doc is what happens
in that plane when the schema moves, and what a caller has to know to move it.

What decides whether a change is *permitted* belongs to whoever declared the
tables; pronto's answer is
[`../../../plugins/pronto/docs/2026-09-24-refusing-a-schema-change.md`](../../../plugins/pronto/docs/2026-09-24-refusing-a-schema-change.md).

## How a schema reaches the database

A cluster delivers its schema by baking it into the database image and letting
postgres apply it at initdb, in name order, on a fresh data directory. There is
no migration runner to ask and no revision table to consult: **the steps that
ran are the files the image carries.**

That is the whole mechanism, and it has one consequence worth stating before
anything else: it only ever runs on an empty data directory. A container that
keeps its volume never applies a changed file. A schema change therefore reaches
an existing database by some other means, and reaches a *new* one by being in
the image.

The cluster publishes what a caller needs to reach it, at
`#Cluster.surface.schema`:

```
{ "target": "database", "initdb": "/docker-entrypoint-initdb.d" }
```

`target` is the name a compose project gives the service; `initdb` is where the
image applies from. Anything that applies this schema elsewhere, inspects what
it built, or reproduces it reads those two rather than keeping a copy of this
layout that nothing would correct when it moved.

Above the caller's own steps the image contributes one of its own: the tenancy
floor, `002a_rls.sql`, the row-level isolation every mecha database has whatever
emitted the tables above it. Its name places it — after the 002 grants, before a
caller's 005 that calls `rls_protect`.

## What notices

A schema change is not one event. It is one `ALTER` and then a handful of
caches, positions and copies that each find out differently — and the ones that
do not find out are the failures worth knowing.

**PostgREST's schema cache is the one this model breaks.** It reads the catalog
once and serves from memory: after a migration a new column answers 400 and a
new table 404, indefinitely, until it is told. `NOTIFY pgrst, 'reload schema';`
is the telling.

**Electric caches relation OIDs.** Measured: `ALTER TABLE … ADD COLUMN` leaves
the relation's OID unchanged, so shapes survive an additive change. A
drop-and-recreate shifts it, and Electric then reports the table as dropped or
renamed and stops serving the shape. This is the sharpest argument in the data
plane for additive change: the difference between "nothing happened" and "the
sync path is down" is whether the relation kept its identity.

**Conduit's replication position outlives the database.** Its
`confirmed_flush_lsn` is stored on its side, so a database reset leaves the
connector asking for WAL the server no longer has — the position runs ahead of
`pg_current_wal_lsn()` and the change feed goes silently dead. Silently is the
problem: nothing errors, rows simply stop arriving.

**The lake keeps its bytes and not its names.** DuckLake writes a `field_id`
into every parquet column and resolves by it, so a rename or a drop against the
catalog is metadata and rewrites nothing. It is the one holder in the plane for
which a rename is cheap — which is exactly why it cannot be the reason to allow
one elsewhere.

**A hand-written copy is a schema change nobody applies.** Where a component
carries its own spelling of the tables, a migration is a manual edit there, and
nothing connects the two.

## Applying a change to a database that already exists

Since initdb only fires on an empty directory, a live database is carried
forward by pgroll, which keeps a ledger of what it has applied. A migration runs
once; running it again reports that the database is up to date and exits 0.

A ledger therefore decides how the SQL above it may be written: without one,
every statement has to survive being applied twice, and what that costs a caller
who wants to read its own DDL is
[`../../../plugins/pronto/docs/2026-09-24-refusing-a-schema-change.md`](../../../plugins/pronto/docs/2026-09-24-refusing-a-schema-change.md).

Mecha's own development database is not one of these clusters and keeps its own
arrangement — `services/database/schemas/schema.hcl` and a checked-in
`atlas.sum`, driven by the `atlas:diff` and `atlas:hash` tasks in its Taskfile.
That is mecha's stack maintaining mecha's tables, and nothing a caller's cluster
does depends on it.

pgroll's expand-and-contract is available where a change genuinely needs two
shapes live at once: it adds the column under a temporary name, exposes both
shapes through per-version schemas, and renames on completion. Taking that path
for a table means the readers keyed on the table — the REST gateway, the sync
shapes, row-level security — have to be pointed at the version schema, which is
why it is a deliberate choice for one change rather than the default for all.

## Reproducing what a schema built

Because the steps that ran are the files the image carries, a database's schema
can be rebuilt from the image alone: start it, read the initdb directory, apply
the steps in name order. Nothing needs to be told what the steps were.

That property is what makes the plane inspectable — the catalog after each step
is a state you can compare, and comparing consecutive states is how a change
that the SQL text hides still becomes visible. Who does that comparison, and
what they refuse on the strength of it, is the caller's business.
