# The auth service's token contract

Three components read these tokens and only one mints them, so the shape is
stated here rather than in each: this service issues, PostgREST verifies, and
the emitter writes the policies that call `auth_uid()`.

- **HS256**, claims `{role, sub, handle, exp}`, secret from `PGRST_JWT_SECRET`.
  A dev default ships so a fresh cluster boots; production overrides it.
- **A user token** carries role `app_user` and `sub` = the `app_user` row id.
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

The alternative was server-side sessions. It was refused because the WebAuthn
challenge is the only state a ceremony needs, and a short-lived `state` JWT
carries it without giving the service anything to lose on restart.

## Provider sign-in

A provider `signIn` names (`oidc.ts`) signs a person in by OpenID Connect's
authorization code flow with PKCE, by redirect, so no provider script runs in
a page the door serves:

- `GET /auth/oidc/<provider>/start?return=<path>` sends the browser to the
  provider's authorization endpoint with a signed `state`, a nonce and the
  PKCE challenge; the verifier stays in an HttpOnly cookie scoped to the
  callback, and the state carries only its hash.
- `GET /auth/oidc/<provider>/callback` redeems the code at the provider's token
  endpoint with that verifier, verifies the ID token (RS256 or ES256) against
  the provider's published keys, issuer, client and nonce, and links the
  subject to an `app_user` in `identity_link`, making both the first time. It
  leaves an HttpOnly `mecha_oidc` cookie on `/auth/oidc` and a readable
  `mecha_oidc_hint` naming the provider, and returns to `return`, a
  same-origin path.
- `POST /auth/oidc/session` exchanges the cookie for a **user token**, guest
  false, while the link still stands: the terminal keeps a tab's session in
  sessionStorage, which a redirect cannot write, and a tab opened later adopts
  the same sign-in this way. `POST /auth/oidc/signout` clears both cookies.

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

The service holds no account policy: a subject signs into its own account,
made the first time, and a guest who signs in through a provider leaves the
guest behind. A person signed in through a provider and one holding a passkey
are two `app_user`s.

`identity_link` is `(provider, issuer, sub, user_id unique, created_at)`, with the
provider's `name` and `picture` where it gives them, refreshed on every
sign-in. An app that keeps its people elsewhere copies them with a trigger on
it, as a reader is made on `webauthn_credential`; the service creates the table
when it starts, so an app's migration that declares such a trigger declares the
table as the service does.

The issuer is the configured issuer URL, with the preset's accepted ID-token
aliases treated as that same issuer. Replacing an issuer never transfers its
subjects or browser sessions. Removing a provider also ends cookie adoption.
For an existing link table without issuers, add an `issuer text` column and
populate it with each row's original issuer before starting auth; startup
refuses unassigned rows because the provider label cannot identify their issuer.
