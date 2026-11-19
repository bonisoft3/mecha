# The auth service's token contract

Three components read these tokens and only one mints them, so the shape is
stated here rather than in each: this service issues, PostgREST verifies, and
the emitter writes the policies that call `auth_uid()`.

- **HS256**, claims `{role, sub, handle, guest, name?, email?, exp}`, secret from `PGRST_JWT_SECRET`.
  A dev default ships so a fresh cluster boots; production overrides it.
- **A user token** carries role `app_user`, `sub` = the `app_user` row id, `guest` (`true` for `/auth/guest`, `false` after a ceremony or provider sign-in), and `name` / verified `email` when minted from a provider link.
- **A service token** carries role `service` and the nil uuid, pre-signed
  against the dev secret and delivered as a compose env default. It exists so a
  transform can write without a reader, which is the only caller that has no
  session to borrow.
- **`auth_uid()`** reads `sub` out of `request.jwt.claims`. It is a replaceable
  object, restated by the database image with the tenancy floor and never
  migrated with the tables, so a correction reaches every database without a
  migration.

- **A shape token** carries `typ: "shape"`, the `table` and the `where` its
  scopes reach. `/auth/shape/verify` answers Caddy for every shape request:
  `table` and `where` must equal the token's, and a subset snapshot narrows it
  with the `subset__*` parameters the gate names ([proxy](../../docs/proxy.md)).

When the catalogs prove a leaf table's `scope_id` is a stored generated
NOT NULL constant `'public:'`, its shape predicate retains only the subject's
public scope. Readers share one Electric log while their tokens keep distinct
subjects. Defaults, mutable or private scopes, virtual generated columns and
tables with descendants retain the full subject scope set. Keyed shapes keep
their row authorization; every request must still match its token's table and
exact predicate.

The WebAuthn challenge travels in a short-lived `state` JWT rather than a
server-side ceremony store. Native Android passkey ceremonies verify against
`WEBAUTHN_ORIGIN` plus any `android:apk-key-hash:<sha256-b64url>` entries from
`ANDROID_APK_KEY_HASHES`.

Every session-minting endpoint (`POST /auth/guest`, WebAuthn verify,
`POST /auth/oidc/session`, and `POST /auth/refresh`) returns an opaque rotating
`refresh_token` alongside `token` and `user`. `mecha_auth.auth_refresh_token`
stores only the SHA-256 hash, `family_id`, expiry (90 days), and replacement
pointer; replaying an already-rotated token revokes its entire family.

`DELETE /auth/account` requires a valid `app_user` Bearer token and deletes the
`app_user` row, cascading credentials, links, tickets, refresh tokens, and
`ON DELETE CASCADE` owned rows.

## Provider sign-in

A provider `signIn` names (`oidc.ts`) signs a person in by OpenID Connect's
authorization code flow with PKCE, by redirect, so no provider script runs in
a page the door serves:

- `GET /auth/oidc/<provider>/start?return=<path>` sends the browser to the
  provider's authorization endpoint with a signed `state`, a nonce and the
  PKCE challenge; the verifier stays in an HttpOnly cookie scoped to the
  callback, and the state carries only its hash. Speculative `GET`s
  (`Service-Worker-Navigation-Preload` and `prefetch`/`preview`) are refused on
  both `start` and `callback` without touching cookies or spending a code.
- `GET /auth/oidc/<provider>/callback` redeems the code at the provider's token
  endpoint with that verifier, verifies the ID token (RS256 or ES256) against
  the provider's published keys, issuer, client and nonce, and links the
  subject to an `app_user` in `identity_link`, making both the first time. It
  leaves an HttpOnly `mecha_oidc` cookie on `/auth/oidc` and a readable
  `mecha_oidc_hint` naming the provider, and returns to `return`, a
  same-origin path.
- `POST /auth/oidc/session` exchanges the cookie — or, when `/start` ran with
  `?return=native&code_challenge=<S256>[&scheme=<scheme>]` against an allowlisted
  `NATIVE_SCHEMES` entry, atomically consumes the 60-second single-use ticket
  from `<scheme>://auth/callback?ticket=<id>` against `{ ticket, code_verifier }`
  — for `{ token, refresh_token, user }` (`guest: false`). `POST /auth/oidc/signout`
  clears both browser cookies.

A provider is found by its discovery document. Each setting is `signIn`'s
default for the provider (`issuer`, `internal`, `client`, `scope`, `params`),
which the deployment's variable overrides; a secret is the deployment's alone,
and a provider whose client neither gives refuses to start:

| Variable | |
|---|---|
| `OIDC_<NAME>_CLIENT_ID` | required; `origin` makes the client the door's own origin, a public client as an issuer that registers none takes it |
| `OIDC_<NAME>_ISSUER` | the issuer, required unless the name is a preset (`google`); setting it puts another issuer in the preset's place |
| `OIDC_<NAME>_INTERNAL` | where this service reaches the issuer when the cluster's way differs from the reader's |
| `OIDC_<NAME>_CLIENT_SECRET` | where the provider wants one; Google's code flow does |
| `OIDC_<NAME>_SCOPE` | `openid`, or the preset's |
| `OIDC_<NAME>_AUTHORIZE_PARAMS` | further authorization parameters, URL-encoded; never one the flow sets |

Without a guest token on `/start`, a subject signs into its own account, made
the first time. Passing an unlinked guest's token (`Authorization: Bearer <jwt>`
or `promote_token`) on `/auth/oidc/<provider>/start` promotes that guest onto a
fresh provider link in place, or reassigns the guest's owned rows in `public`
into an already-linked `app_user` before deleting the guest row.

All auth tables (`webauthn_credential`, `identity_link`, `auth_native_ticket`,
`auth_refresh_token`) live in `mecha_auth`, which no app role may use.

`identity_link` is `(provider, issuer, sub, user_id unique, created_at)`, with the
provider's `name`, `picture` and verified `email` where it gives them, refreshed
on every sign-in. An app that keeps its people elsewhere copies them with a trigger on
it, as a reader is made on `webauthn_credential`; the service creates the table
when it starts, so an app's migration that declares such a trigger declares the
table as the service does.

Both tables live in the schema `mecha_auth`, which no app role may use: an
app's grants on every table in `public` and the CRUD API serving `public` reach
neither. The service moves them there, rows and all, from `public`, where
earlier releases made them, and refuses to start where both copies exist. A
trigger or reader an app declares names them `mecha_auth.identity_link` and
`mecha_auth.webauthn_credential`.

The issuer is the configured issuer URL, with the preset's accepted ID-token
aliases treated as that same issuer. Replacing an issuer never transfers its
subjects or browser sessions. Removing a provider also ends cookie adoption.
For an existing link table without issuers, add an `issuer text` column and
populate it with each row's original issuer before starting auth; startup
refuses unassigned rows because the provider label cannot identify their issuer.
