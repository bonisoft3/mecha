# mecha

# Entry points

* [mecha](../README.md) - concept: The nine invariants that make a stack a mecha — schema-driven CRUD, CDC and real-time sync — whatever components it runs on.
* [Mecha: the architecture behind the invariants](../ARCHITECTURE.md) - reference: The stack that satisfies the invariants in this tree, one row per component, each linking the document that argues it.
* [Contributing to mecha](../CONTRIBUTING.md) - howto: Changing mecha itself — the workflows, what derives from schema, and where each subsystem is argued.
* [Pending](../PENDING.md) - metric: What mecha argues for and has not built, each with the argument, checked against this tree on the date given.

# Subsystems

* [Change capture and delivery](change-capture.md) - concept: How a committed row reaches the pipelines through Conduit, Dapr, the bus and rpk, what each hop retries, and what absorbs a duplicate.
* [Streaming joins](streaming-joins.md) - concept: The stream tier — Arroyo over the change feed, writing a derived table back through CRUD — what runs, and what a join across entities needs.
* [The proxy](proxy.md) - concept: Caddy as the cluster's one door — its routes, HTTP/2 over a locally trusted certificate, the plain listener that serves only the healthcheck, and the deployment's origin it spells.
* [Schema and its changes](schema.md) - concept: How a schema reaches the database as initdb SQL, mecha's own tables from protobuf, what notices a change, and carrying a live database forward.
* [Tiers and clouds](deployment.md) - concept: mecha's tiers from browser to edge, the unit that holds the WAL reader and the request that wakes it, the managed service each component maps to, and what runs on a cloud as built.
* [The browser platform](browser.md) - concept: mecha's cluster inside one browser tab — PGlite and a JavaScript stand-in for each service, one user, and the guarantees it drops.
* [Capabilities](capabilities.md) - concept: The switches in cluster.cue that add planes to a cluster — data, change feed, auth, blobs, schedules — and what mecha's own stack runs beside them.
* [State machines](machines.md) - concept: Trigger-driven statechart reducers inside PostgreSQL — deterministic transitions, relational effects, timeouts, and ticker sweeps.

# Service and package contracts

* [The auth service's token contract](../services/auth/README.md) - reference: The HS256 token this service mints, PostgREST verifies and policies read through auth_uid().
* [Row-level security: the tenancy floor](../services/database/rls/README.md) - reference: The row isolation every mecha database carries, whatever emitted its tables, and what its audit proves.
* [ticker](../services/ticker/README.md) - reference: The periodic wake's contract — clock, poke, tick, outcome — how an app declares a schedule, and why a tick needs no durability.
* [@mecha/lake](../packages/lake/README.md) - reference: The browser-side consumer of a published DuckLake.
