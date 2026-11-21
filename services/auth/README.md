# The auth service's token contract

Three components read these tokens and only one mints them, so the shape is
stated here rather than in each: this service issues, PostgREST verifies, and
the emitter writes the policies that call `auth_uid()`.

- **HS256**, claims `{role, iss, sub, handle, acr?, amr?, auth_time?, name?, email?, exp}`, secret from `PGRST_JWT_SECRET`.
  A dev default ships so a fresh cluster boots; production overrides it.
- **A user token** carries role `app_user`, `iss` = the stack's own issuer
  (`STACK_ISSUER`, `mecha:stack`, the only one the database floor lets the
  cluster's roles act on), `sub` = the `app_user` row id, and how it was signed in, in OpenID
  Connect's claims (`claims.ts`): `acr` `"0"` for a guest (Core's level of no
  confidence that the same person is there), `phr` for a passkey with `amr`
  `["pop"]`, a proof of possession of its key — where the key lives is
  unattested, so neither `hwk` nor `swk`, and never `phrh` — plus `"mfa"`
  where it reports verifying its person (a PIN or biometric), and what a
  provider says of itself for a provider's sign-in; `auth_time` is when, kept
  when a session is renewed, and absent where a provider does not say (a
  provider session reused is no fresh sign-in). A policy for people asks for
  an `acr` other than `"0"`. `name` and verified `email` come from a provider
  link.
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

## Passkeys

Usernameless WebAuthn: no identifier is ever collected, and the credential
names its account (a resident key).

- `POST /auth/register/start` answers the creation options and a `state`.
  Its body may carry `{name}`, the account's handle then (`handles.ts`): the
  name's letters, marks and digits joined by `-`, and the four hex digits that
  end the account's id — of an address (`davi@example.com`), only what
  precedes the `@`; 400 when nothing of the name is left, 409
  `name taken` when another account goes by it. Without one a new account is
  named as a guest is. The passkey's user name is the handle's name without
  its suffix, what the person's own password manager shows. With no session it makes a new identity. A guest's session promotes the
  guest, keeping its id, handle and rows, while it is still a guest — no
  passkey, no provider link: a guest token that outlives its promotion adds
  nothing (409 `already an account`), and promotions of one guest are
  serialized, so racing ones make one passkey. An account's session
  is refused (409): a passkey added on the strength of a bearer token would
  outlive the token and its sign-out.
- `POST /auth/register/verify` and `POST /auth/login/verify` answer
  `{token, user: {id, handle}, passkey: {rpId, userId}}` and make the account
  the device's session ([Device session](#device-session)). `passkey` names the
  person's passkeys to the WebAuthn Signal API (`signalCurrentUserDetails`):
  `userId` is the user handle they were made under, base64url without padding
  of the UTF-8 `app_user` id.
- A login sent with a guest's session, whose passkey is another account's,
  answers 409 `{"error": "login_required", user: {handle}, offer}`: OpenID
  Connect's answer when the person signed in is not the one hinted. The
  account is held, the passkey being proven, for the reader to take or leave.
- A registration's challenge is spent with the account it makes, and stays
  spent after that account is deleted: one answer makes one account, once.
- `POST /auth/rename {name}` with a session renames its account, guest or
  person: the handle's name changes and its suffix stays (400, 409 as above),
  and the session comes back issued again as it was signed in and until it
  was to end. A guest's token renames only while its account is still a
  guest's (409 `already an account` after its promotion).
- A login's challenge is spent by its first verify: the same answer again is
  401, which a synced passkey's counter, always 0, could not refuse. The
  counter only climbs, and 0 follows only 0.
- A login with a credential the service does not hold answers 401
  `{"error": "authentication verification failed", "unknownCredential": true}`,
  so the browser signals it unknown and the authenticator stops offering it.

Every route here is `core.ts`, written once over a two-method database
(`AuthDb`): this service runs it on Postgres, and the edge cluster on its
PGlite ([mecha-edge](../../packages/mecha-edge/README.md)), so the two answer
alike by construction.

Native Android passkey ceremonies verify against `WEBAUTHN_ORIGIN` plus any
`android:apk-key-hash:<sha256-b64url>` entries from `ANDROID_APK_KEY_HASHES`.

## Refresh tokens and account deletion

A browser renews by its HttpOnly cookie, so a refresh token goes only to a
native host, which has none and asks: `refresh: true` in the body of
`POST /auth/guest` or a WebAuthn verify; `POST /auth/oidc/session` and
`POST /auth/refresh` always answer one. It is opaque and rotating, beside
`token` and `user`. `mecha_auth.auth_refresh_token` stores only the SHA-256
hash, `family_id`, the sign-in's proof and way, expiry (90 days), and
replacement pointer. A family renews only while its way stands, as a device
session does — its passkey still the account's, its link still there, its
guest still a guest — and says how the session was signed in (`acr`, `amr`,
`auth_time`). It rotates under a lock of its own, so replaying an
already-rotated token revokes the whole family, its newest token included.

`DELETE /auth/account` requires a valid `app_user` Bearer token — a guest's
only while it is still a guest, so one that outlived its promotion deletes
nothing (409) — deletes the
`app_user` row, cascading credentials, links, tickets, refresh tokens, and
`ON DELETE CASCADE` owned rows, and signs the device out.

The alternative was server-side sessions. It was refused because the WebAuthn
challenge is the only state a ceremony needs, and a short-lived `state` JWT
carries it without giving the service anything to lose on restart.

## Provider sign-in

A provider `signIn` names (`oidc.ts`) signs a person in by OpenID Connect's
authorization code flow with PKCE, by redirect, so no provider script runs in
a page the door serves:

- `GET /auth/oidc/<provider>/start?return=<path>` sends the browser to the
  provider's authorization endpoint with a signed `state`, a nonce and the
  PKCE challenge. A guest starts by `POST` from this origin with its token as
  the form's `id_token_hint` and `return`, so the token is in no URL; the verifier stays in an HttpOnly state cookie (scoped to the
  callback over plain http), and the state carries only its hash. Speculative `GET`s
  (`Service-Worker-Navigation-Preload` and `prefetch`/`preview`) are refused on
  both `start` and `callback` without touching cookies or spending a code.
- `GET /auth/oidc/<provider>/callback` redeems the code at the provider's token
  endpoint with that verifier, verifies the ID token (RS256 or ES256) against
  the provider's published keys, issuer, client and nonce, and links the
  subject to an `app_user` in `identity_link`, making both the first time. It
  makes the account the device's session, which stands while the provider is
  enabled under the same issuer and the link is there, and returns to
  `return`, a same-origin path.
- A guest's sign-in links the subject to the guest, keeping its id, suffix and
  rows and taking the provider's first name (else its whole one) where no
  account goes by it, while the guest is still one and no account holds the
  subject. One another account holds is held, never merged, in a browser or
  an app.

## Device session

A browser holds one account (`session.ts`): every sign-in — a passkey's, a
provider's, a guest's mint — leaves an HttpOnly session cookie and a readable `mecha_session_hint` (see Cookie names). The cookie is never renewed, so
it lasts 30 days from the sign-in that set it, and it names the way the
account came in, which must still stand when it is taken up: the passkey still
the account's, the provider's link still there, the guest still a guest. Only
a request from the door's own origin is given one: a page elsewhere may sign
in for a token, never replace this browser's session.

- `POST /auth/session` answers the cookie's account as a **user token**,
  signed in as it was: the terminal keeps the token in localStorage, which a
  redirect cannot write and a bearer outlives by a week at most. 401 when no
  way stands.
- An account a sign-in found while another is the device's is held in an
  HttpOnly `mecha_session_held` cookie for five minutes, which `/session`
  answers first, 409 `{"error": "login_required", user: {handle, name?}, offer}`.
  `POST /auth/session/switch {offer}` makes it the device's session;
  `POST /auth/session/stay {offer}` lets it go. Each names the offer it
  answers, so one tab cannot take or drop the account another tab shows: an
  older offer is answered 409 with the current one, to show instead.
- `POST /auth/guest {cookie: false}` mints a guest without the cookie, for a
  page minting ahead of its reader; `POST /auth/session/adopt` with that
  guest's token makes it the device's session, unless the device has one (409)
  — a sign-in that finished first keeps it. The same route takes up a guest an
  earlier release kept in a tab's sessionStorage (`guest: true`, no `acr`).
- `POST /auth/signout` clears every cookie, under both of their names.

Each is refused (403) from another origin.

### Cookie names

Over https the credential-bearing cookies are `__Host-` cookies: no `Domain`, `Path=/`, `Secure`,
which a browser accepts only from the exact host that sets them. A sibling site under the same
parent domain can otherwise set a `Domain=<parent>` cookie of the same name here and sign a
visitor into its own account (login fixation).

| https | plain http (local) |
| --- | --- |
| `__Host-mecha_session` | `mecha_session`, `Path=/auth` |
| `__Host-mecha_session_held` | `mecha_session_held`, `Path=/auth` |
| `__Host-mecha_oidc_state_<provider>` | `mecha_oidc_state`, `Path=/auth/oidc/<provider>/callback` |

Browsers refuse `__Host-` without https, so plain http keeps the bare names. Each provider's state
cookie has a name of its own since they now share `Path=/`. `mecha_session_hint` holds no
credential and keeps its name and `Path=/`.

`OIDC_LEGACY_COOKIE` (`on`, the default, or `off`; anything else stops the service at startup) is the
upgrade switch. Over https, a plain `mecha_session` is read only when no `__Host-` session exists, so
a release does not sign everyone out; the next sign-in sets the prefixed one. Only a session minted
before the prefix stands under the plain name: every session minted over https since carries
`host: true`, and one read from the plain name is refused, since a sibling site could have planted it
(its own sign-in, under `Domain=<parent>`). Sessions are never renewed, so legacy reads end by
themselves within 30 days (the session's lifetime) of the release that brought the prefix; set
`off` to end them at once, where no plain cookie of ours can exist (an origin new since). A plain
`mecha_session_held` is never read (an offer lasts five minutes). Sign-out clears both names.

Residual risks. A session from before the prefix, planted by a sibling during those 30 days, is
still taken up while the switch is on. `Path=/` sends the session cookie on every route behind the
door, so a proxy should drop `Cookie` on routes that serve no cookie (the bundled Caddyfile does for
`/crud`, `/electric`, `/img` and `/poke`), and an app with a door of its own should do the same. Old
browsers that do not implement cookie prefixes, or that accept a cookie with an empty name and a
value spelling `__Host-...`, can still be spoofed; the prefix protects only where the browser
enforces it.

## Provider settings
- `POST /auth/oidc/session` serves a native host: when `/start` ran with
  `?return=native&code_challenge=<S256>[&scheme=<scheme>]` against an
  allowlisted `NATIVE_SCHEMES` entry, the callback redirects to
  `<scheme>://auth/callback?ticket=<id>`, and this atomically consumes the
  60-second single-use ticket against `{ ticket, code_verifier }` for
  `{ token, refresh_token, user }`. A native start carrying a guest's token
  (`Authorization: Bearer <jwt>` or `promote_token`) is a browser's
  `id_token_hint`, under the same rule: a subject no account holds becomes
  the guest's; one another account holds is held, its ticket answering 409
  `{"error": "login_required", user: {handle, name?}, ticket}`, and
  redeeming that `ticket` with the same verifier switches to the account.
  Nothing moves between them; left alone, the ticket expires and the guest
  stays. An app sends no guest token for a guest that wrote nothing.

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
| `OIDC_LEGACY_COOKIE` | `on` (default) or `off`, else the service refuses to start: `off` stops reading a plain `mecha_session` over https (see Cookie names) |
| `OIDC_<NAME>_AUTHORIZE_PARAMS` | further authorization parameters, URL-encoded; never one the flow sets |

A person signed in through a provider and one holding a passkey are two
`app_user`s: a guest becomes one or the other, once.

All auth tables (`webauthn_credential`, `identity_link`, `webauthn_challenge`,
`auth_native_ticket`, `auth_refresh_token`) live in `mecha_auth`, which no app
role may use.

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
