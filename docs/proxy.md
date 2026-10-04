---
type: concept
title: The proxy
description: Caddy as the cluster's one door — its routes, HTTP/2 over a locally trusted certificate, and the plain listener that serves only the healthcheck.
---

# The proxy

Caddy is the only way into a cluster. Every browser request reaches a service
through one of its routes, so the proxy is where transport, authorization of
sync, and idempotence at the CRUD boundary are decided. Pipelines write to
PostgREST directly ([routing](change-capture.md#routing)).

## Routes

The Caddyfile is the consumer's (`meta.caddyfile` in [`cluster.cue`](../cluster.cue),
default `docker/Caddyfile`), and the services it routes to are the cluster's.
mecha's own stack uses [`services/proxy/Caddyfile`](../services/proxy/Caddyfile),
which routes these and answers 404 to anything else:

| route | service | what the route adds |
|---|---|---|
| `/crud/*` | PostgREST (`crud:3000`) | `Prefer: return=representation,resolution=ignore-duplicates` on every POST, so a redelivered insert is absorbed rather than answered 409 ([change capture](change-capture.md#duplicates)) |
| `/electric/*` | ElectricSQL (`electric:3000`) | the gate, then the `secret` query parameter, below; `flush_interval -1` and a 300 s read timeout for the long-poll |
| `/auth/*` | the auth service (`auth:9999`) | mounted with its prefix: the service's routes carry `/auth` |
| `/img/*` | imgproxy ([the blob plane](capabilities.md#the-blob-plane)) | `flush_interval -1` |
| `/poke` | the ticker ([its contract](../services/ticker/README.md)) | mounted with its prefix: the ticker answers `POST /poke` and 404s everything else |
| `/health` | Caddy itself | the container's healthcheck |

**The gate is in the Caddyfile.** The cluster gives caddy and electric the
same `ELECTRIC_SECRET`, and electric refuses a shape request that does not
carry it as the `secret` query parameter, so the Caddyfile's electric route is
where it is added. With the auth plane on, the route puts `forward_auth` to the
auth service (`/auth/shape/verify`) first and adds the secret after the gate,
so a request that skips the gate has no secret to present
([its contract](../services/auth/README.md)). Both sit inside a `route`:
outside one, Caddy sorts `uri` ahead of `forward_auth`, and the gate would
refuse the secret the proxy had just added. mecha's own Caddyfile carries the
gate, and its smoke drives a shape through it.

The gate compares what decides reach and admits the rest by name: `table` and
`where` must equal the token's, every parameter must appear once, the method
must be GET, and `replica` is admitted only as `full`. It compares the query
Electric will receive, which is Caddy's re-encoding of it through Go's
`url.ParseQuery`: that drops a pair holding a raw `;` or a `%` that starts no
escape, where the gate's parser keeps both, so such a query is refused, or a
`where` the gate approved would never reach Electric. Electric's paging and
streaming parameters pass, and so do a subset snapshot's `subset__where`,
`subset__params`, `subset__order_by` and `subset__limit`, which a collection
synced on demand sends for each view's rows. A subset returns no row the
token does not reach: Electric ANDs it onto the shape's `where` as a parsed
expression, the token's `where` binds no `$n`, Electric's parser admits no
subquery and no function of its own choosing, and a POST body never reaches the
gate. Returning is not evaluating, though: Postgres orders the two predicates
by its own costs, so a subset's runs on rows the token excludes, and an error
it raises there (a cast of another subject's value) quotes that value back.
So the gate holds a subset to the grammar its client compiles a view's
predicate to, shared with [the page's cluster](browser.md) in
`services/auth/jwt.ts`, in which no error depends on a row's value: a quoted
column compared with a `$n` or a literal, two values compared (the
compiler's `true = true` for a subset with no filter), a bare `TRUE` or
`FALSE`, `"col" = ANY($n)`, `"col" IS [NOT] NULL`, under `AND`/`OR`/`NOT`.
A column meets only a value, whose type Postgres infers from the column, so
no cast it makes depends on a row. Where the request picks the type instead,
the column is cast to it on every row and raises on a value beyond its range:
two columns of different numeric types, and a typed literal
(`"amount" = "float8" '1'` raises on a numeric beyond float8's range), so
neither parses, nor does arithmetic, a function or a pattern. A pattern is the one the client could send that
raises on a row's value (a LIKE pattern ending in its escape character, once
the value matched the rest), and the store sends none: a filter by pattern is
read from the collection, never as a view (omnishell's `routeOf`). The gate
refuses a subset as Electric does, a 400 whose `errors.subset` names the
parameter (a repeated `subset__*` parameter among them), which the store
raises as the program's error rather than retry.
Caddy answers Electric's 5xx with its status, its headers (a 503's
`Retry-After` among them) and a fixed body, so Postgres's text reaches no
client either way. Two alternatives were rejected. Binding the
token's scopes into the subset needs a proxy that rewrites the query, where
the gate only judges it. Admitting `subset__*` only for tables synced on demand
needs the token to know a sync mode, which the auth service does not, and
narrows nothing the grammar does not already. `tests/entrypoint.sh` holds each
premise against Electric behind Caddy; the premises are stated beside
`SHAPE_FREE_PARAMS` in [the auth service](../services/auth/main.ts).

A consumer's Caddyfile routes `/blobs/*` to rclone-s3 as well
([the blob plane](capabilities.md#the-blob-plane)).

The statics a consumer serves are baked into the image, not bind-mounted: a
file mount follows its inode, and an editor saving atomically replaces the
inode, so every edit would 404 until the container is recreated. `develop:
watch` syncs and restarts instead. `caddy adapt`, not `caddy validate`, is the
lint (`checks: caddy`): validate provisions the certificate, whose path is the
container's.

## One door, and it is h2

A browser opens at most six HTTP/1.1 connections per origin, and every live
Electric shape holds one for its whole long-poll, one per table a screen reads.
Past six, writes queue behind the polls, invisibly, because every toggle is
optimistic: a bookmark doing 78 ms of server work waited 12,073 ms of queue.
HTTP/2 multiplexes every stream over one connection. On a nine-table screen,
transport the only variable:

| | HTTP/1.1 | h2 |
|---|---|---|
| screen rendered | 1,552 ms | 647 ms |
| slowest shape | 20,027 ms | 142 ms |
| a write from that screen | 445 ms | 43 ms |

So the cluster publishes one port, `meta.door` (default
`${CADDY_TLS_HOST_PORT:-0}:8443`), serving h2 over TLS. The plain `:8080`
listener exists inside the container for the healthcheck and is deliberately
not published, so there is no second transport to drift onto. mecha's own stack
is the exception: its proxy serves plain HTTP on `8080:8080`, which its smoke
suites and benchmark address.

## The certificate

Browsers speak h2 only over TLS with a certificate they trust, and an untrusted
certificate is worse than plain HTTP: its interstitial blocks WebAuthn, where
`http://localhost` is a secure context. The door answers two names:

- `localhost`, a person's browser on the host. `sayt setup` issues a mkcert
  pair into the consumer's gitignored `.certs/` (`verbs: certs`), `sayt launch`
  issues one if setup has not (`verbs: certsLaunch`); the image copies it and
  `develop: watch` syncs a re-issued one. Trusting it, `mise exec -- mkcert
  -install`, is left to a human because it writes the system keychain; setup
  prints the command. Without a pair, Caddy serves its own CA.
- `caddy`, a client on the cluster's network: the integrate checkers. Caddy's
  own CA signs it, and the checkers ignore certificate errors: deno for that
  host only, Chromium browser-wide, because a context's `ignoreHTTPSErrors`
  does not reach a service worker's fetches. Its own site block, so mkcert's
  pair, which names localhost only, never sends Caddy to a public CA for a name
  only the cluster resolves.

## Rejected

- **A second origin for sync.** The cap is per origin, and serving `/electric/*`
  from a second origin did cut that bookmark to 42 ms — but it buys twelve
  sockets where the problem wants none, a nine-table screen overflows the second
  six anyway, and the split is arithmetic redone whenever a screen grows a
  table. Two findings from it hold regardless: Electric answers CORS itself, so
  a second grant fails every shape with "Access-Control-Allow-Origin contains
  multiple values"; and shape responses are `public, max-age=604800` with the
  origin echoed, so without `Vary: Origin` one cached entry serves every origin,
  and opening a shape URL in a tab poisons it for the app.
- **Only `tls internal` for `localhost`.** Caddy's own root lives in the container,
  so no browser trusts it, and an untrusted certificate blocks WebAuthn.
- **A CA the checkers trust.** A pair issued in the build, its CA copied into
  the checkers' images: deno takes it through `DENO_CERT`, but Chromium on Linux
  trusts only its NSS database, and one written by leap's NSS 3.125 records the
  trust as a PKCS #11 3.2 object that the Playwright image's NSS 3.98 cannot
  read. Writing it with that image's own certutil means apt, or a per-arch
  pinned package, in the browser images; for a name nothing outside the
  cluster resolves, trust buys nothing that ignoring loses.
- **Publishing the plain listener, or redirecting it to https.** A second front
  door is a path that only ever runs on a laptop.
- **nginx/OpenResty with Lua handlers** for webhooks and SSE: brittle, hard to
  test, opaque to tracing, Last-Event-ID replay kept by hand, no Windows. The
  door is Caddy without scripting; handlers are pipelines
  ([change capture](change-capture.md)).
