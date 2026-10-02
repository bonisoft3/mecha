---
type: concept
title: The browser platform
description: mecha's cluster inside one browser tab — PGlite and a JavaScript stand-in for each service, one user, and the guarantees it drops.
---

# The browser platform

The browser tier runs the cluster in the page: PGlite for PostgreSQL, and a
TypeScript package under [`packages/`](../packages/) for each service. The
client code a page runs against a server cluster runs unchanged against this
one. CRUD is immediately consistent, because there is one database. Everything
the change path does is best-effort.

## Three entry points

`packages/mecha-browser` boots the platform in one of three ways:

- **`createCluster`** ([`cluster.ts`](../packages/mecha-browser/cluster.ts)) is
  the whole cluster behind one fetch handler, a `Request` in and a `Response`
  out. It answers `/auth/guest`, `/auth/shape`, `/auth/whoami`, `/crud/*` and
  `/electric/v1/shape`, the routes a server cluster's auth service, PostgREST
  and Electric answer. The embedder routes those paths of its fetch to `handle`
  and supplies the PGlite instance. The bare imports are pinned in
  `cluster.deno.json`.
- **`bootPlatform`** ([`src/factory.ts`](../packages/mecha-browser/src/factory.ts))
  opens PGlite on IndexedDB (`idb://mecha`). An MSW service worker answers
  `/crud/*` and the app's own `routes`. It returns the same `PlatformContext`
  as `@mecha/client`'s `bootPlatform`, which reads Electric shapes and fetches
  `/crud` on a server, so an app chooses its platform at boot.
- **`src/dev-server.ts`** runs PGlite in memory with a demo table and serves
  postgrest-js on `:8080` through `node:http` (`sayt launch@browser`).

## What stands in for what

| component | package | what it is |
|---|---|---|
| PostgreSQL | `@electric-sql/pglite` 0.5.8 | Postgres in WASM, with one connection, as a superuser |
| PostgREST | `postgrest-js` | A subset: GET, POST, PATCH and DELETE on a table; `eq neq gt gte lt lte like ilike is in`; `select`, `order`, `limit`/`offset`; `Prefer` return, count and resolution. No RPC, no embedding; `ignore-duplicates` is a bare `ON CONFLICT DO NOTHING`, and `merge-duplicates` conflicts on `id` only. A handler given `scopes` does what `db-pre-request` does: it sets `app.scopes` and switches role inside the request's transaction |
| Electric | `cluster.ts` | Electric's HTTP shape protocol over a per-table log, fed by triggers |
| auth | `cluster.ts` | One guest per boot, with unsigned tokens |
| conduit, mesh, bus, transform | `pipeline` | rpk-format YAML: `pipeline.processors` and `output.http_client`. The `input` is ignored, because `pg_notify('cdc')` is the input. It handles `jq` (jq-wasm), `bloblang`, `http`, `branch`, `switch`, `try`/`catch`, `unarchive` and `log`, and refuses any other processor when the YAML is loaded. A `switch` check is `meta("k")`, `env("k")` or a string, with `${VAR}` filled from the environment, compared with `==` or `!=`; any other check is refused at load. The row arrives as `{data: "<row json>"}`, the envelope daprd delivers |
| conduit, mesh, bus, transform | `conduit-js` | One bloblang mapping per table, its result `UPDATE`d back by key. `bootPlatform` uses it only when it is given `pipelines` and a `wasmUrl` but no `pipelineConfigs` |
| bloblang | `bloblang-js` | Benthos's bloblang built for Go WASM. `blobl.wasm` is 38 MB (this tree), so it loads only when a `wasmUrl` is configured. `wasm_exec.js` runs through `new Function`, so the page's CSP must allow `unsafe-eval` |
| rclone-s3 | `rclone-js` | S3's object PUT, GET, HEAD and DELETE, plus ListObjectsV2 without pagination, over a `BlobStorage`: IndexedDB in a page, the filesystem under node. An app mounts it as one of `bootPlatform`'s `routes` |
| caddy | `caddy-js` | Parses `caddy adapt` JSON into route descriptors. Nothing imports it outside its tests: both platforms route by hand |
| an AI model endpoint | the embedder's | `bootPlatform`'s model handler answers a pipeline's call to `TEXT_MODEL_URL` or `IMAGE_MODEL_URL` in the page, with the `textModel` and `imageModel` it is given. mecha ships neither |
| ticker, clock | none | |

Two packages stand in for no service. [`collections`](../packages/collections/src/create-collections.ts)
turns any platform's adapter into TanStack DB collections.
[`tanstackdb-pglite`](../packages/tanstackdb-pglite/src/pglite-collection.ts)
is the browser's adapter: PGlite `live.changes()` feeds a collection, and
writes go through the REST handler. The analytical reader is
[`@mecha/lake`](../packages/lake/README.md).

## The one-user cluster

`createCluster` first runs `rls.sql`, then the app's migrations with their
container-tier statements removed. It then inserts one `app_user`, named
`guest-<8 hex>`, and sets that user's claims for the whole session, so the
tenancy floor ([its contract](../services/database/rls/README.md)) runs
against a real subject. Every request and every log read goes through one
promise chain, because PGlite has one connection. A shape's predicate is
`shapeWhere` over the subject's scopes, the same function the auth service
uses for the server's gate.

A table's trigger notifies the row's key, its scope and the transaction id,
not the row, because `pg_notify` caps a payload at 8 KB. The listener reads the
row back by key, in notification order, and appends it to the table's shape
log, which retains 1,000 entries. A client that falls further behind, or
presents another boot's handle (`<table>-<boot id>`), gets `409 must-refetch`
and starts from a snapshot. A live request waits up to 20 s. A table that
carries a shape must have a primary key, or boot fails.

## The fence

[`fence.ts`](../packages/mecha-browser/fence.ts) removes every span from a
line reading `-- tier: container` to the next line reading `-- tier: any`.
Inside such a span go the statements that need a WAL reader: the publication
and the replica identity. The same grammar lets a bundler refuse a migration
that names `PUBLICATION` or `REPLICA IDENTITY` outside a fence. A fence with no
closing `-- tier: any` matches nothing. PGlite then runs the fenced statements,
and boot fails. `container` is the only tier name the grammar knows.

## What it gives up

- **At-least-once.** A notification is an in-process event. One raised while
  no listener is attached is never replayed. A pipeline step or sink write
  that fails fails the event: PGlite drops the listener's promise, so the
  failure lands as an unhandled rejection, unless a `catch` recovers it. As in
  rpk, `try` flags the failed message and skips its remaining steps, and
  `catch` runs on the flag and clears it. There is no bus, no retry and no dead
  letter. Duplicates are still absorbed
  ([`postgrest-js`](#what-stands-in-for-what)).
- **A service writer.** A pipeline sink writes on the reader's session,
  confined to the reader's scopes. On a server, the `service` role holds
  `BYPASSRLS`.
- **Sharing.** There is one user, minted at every boot, and shapes go by scope
  only: a keyed shape for a row granted by key is refused. A database that
  outlives the page holds rows the next boot's subject cannot see.
- **Durability, beyond what the embedder chose.** `createCluster` keeps
  whatever PGlite it is handed. `bootPlatform`'s IndexedDB can be evicted by
  the browser.
- **Row size in `bootPlatform`.** Its `cdc` trigger is the app's own and sends
  the whole row. Postgres refuses a notify payload over 8,000 bytes, which
  fails the write.
- **Identity.** A token is its claims, unsigned, and nothing checks a
  signature.
- **Server sync.** A page runs this platform or the client, never both. The
  offline outbox that queues writes and retries them lives in
  `@mecha/client`.

## Rejected

- **Electric's own sync service in the page.** The BEAM does not run in a
  browser. The cluster answers Electric's shape protocol itself, so the
  client does not change.
- **Typed values in a shape's rows.** Electric sends each value as Postgres's
  text for it and the client parses by the column's type, so a JSON `true`
  parses as false; the cluster sends text as Electric does.
- **The whole row in the notification.** It fails any row over the notify cap.
  The key is enough to read the row back.
- **Signed tokens in the one-user cluster.** Nothing would verify them, and
  there is no other user to keep out.
- **Recognising container-tier statements by their shape.** The marker is the
  whole grammar. The browser skips what the author fenced, and a bundler
  refuses the two statements when they appear outside a fence instead of
  guessing.
