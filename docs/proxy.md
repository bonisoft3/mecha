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
`http://localhost` is a secure context. So `sayt setup` issues a mkcert pair
into the consumer's gitignored `.certs/` (`verbs: certs`), `sayt launch` issues
one if setup has not (`verbs: certsLaunch`), and the directory is mounted, not
the two files, for the same inode reason as the statics. Trusting the pair,
`mise exec -- mkcert -install`, is left to a human because it writes the system
keychain; setup prints the command. Untrusted, the certificate is still served,
and automated drivers ignore certificate errors; only a person's browser
complains.

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
- **`tls internal`.** Caddy's own root lives in the container, so no browser
  trusts it, and an untrusted certificate blocks WebAuthn.
- **Publishing the plain listener, or redirecting it to https.** A second front
  door is a path that only ever runs on a laptop.
- **nginx/OpenResty with Lua handlers** for webhooks and SSE: brittle, hard to
  test, opaque to tracing, Last-Event-ID replay kept by hand, no Windows. The
  door is Caddy without scripting; handlers are pipelines
  ([change capture](change-capture.md)).
