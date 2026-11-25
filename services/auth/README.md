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
  outlive the token and its sign-out. An account adds one at
  [Ways in](#ways-in).
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

- `GET /auth/oidc` answers `{"providers": [...], "credential": {...}}`: the
  providers this deployment turns on (`OIDC_PROVIDERS`), the ways in the
  terminal draws (a release turns on its program's, a local stack none), and
  for each signing in by its own button, the client the button asks with.
- **A provider's own button** (`OIDC_<NAME>_CREDENTIAL=true`, Google's
  Identity Services, FedCM where the browser has it) signs in on the page,
  with no redirect: `GET /auth/oidc/<name>/nonce` keeps a random secret in
  this browser (`__Host-mecha_oidc_nonce_<name>` over HTTPS, as the state cookie is named) and
  hands the page its hash as the nonce, and `POST /auth/oidc/<name>/credential`
  takes the ID token the button handed the page (`credential`, and a guest's
  `id_token_hint`), checks it for this client and the hash of the cookie's
  secret, and signs the device in as the callback would. A token alone, whose
  nonce anyone holding it reads, signs no one in. A nonce that lapsed or that
  another tab asked over answers 409, for the page to ask anew.
  `GET /auth/oidc/<name>/button?hl=<lang>` is the page the terminal frames to
  draw the button, with `prompt` the browser's account chooser in its
  place, and with `add` the button adding a way ([Ways in](#ways-in)), which
  tells the page framing it what came of it (`postMessage`, `{way: "added" |
  "taken" | "insufficient_user_authentication"}`): Google's script, under a policy of its own that admits it, so the
  app's page never runs it. Its client is one registered to the page's
  origins, never `origin`, and it has no redirect routes.
- **Bluesky** (`OIDC_PROVIDERS` naming `bluesky`, `atproto.ts`) signs in by
  AT Protocol's OAuth through `@atproto/oauth-client`, not OpenID Connect: a
  public client whose id is this origin's
  `GET /auth/oidc/bluesky/client-metadata.json`, asking for the `atproto`
  scope alone. `start` pushes the request (PAR, DPoP, PKCE) to the entryway
  (`OIDC_BLUESKY_ENTRYWAY`, Bluesky's by default), never a server a request
  names; the library's flow state, its DPoP key with it, goes sealed in the
  state cookie, so no server holds a flow. The callback redeems the code, and
  the library checks that the server answering holds the account of the DID
  it names, reading DID documents and server metadata only over https on 443
  at public names whose addresses are public (where the runtime can reach
  any other), following no redirect; a server out of reach, overloaded or
  unavailable is an error, not a refusal. The link is that DID's (issuer `atproto`), named as the public
  AppView (`OIDC_BLUESKY_APPVIEW`) shows them. No token is kept, and there is
  no native start.
- `GET /auth/oidc/<provider>/start?return=<path>` sends the browser to the
  provider's authorization endpoint with a signed `state`, a nonce and the
  PKCE challenge. A guest starts by `POST` from this origin with its token as
  the form's `id_token_hint` and `return`, so the token is in no URL; the verifier stays in an HttpOnly provider-state cookie, and the state carries only its hash. Speculative `GET`s
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
- A start `POST`ed with `add`, or a credential with `add`, adds the subject
  to this device's account as a way in ([Ways in](#ways-in)) and signs no one
  in: the credential answers `{added: true}`, or 409 `{"error": "taken"}`
  where another account holds the subject and `{"error": "held"}` where the
  account already has a way by that provider; a redirect returns to `return`
  with `#ways=<outcome>`, once this device is still signed in to that account,
  recently. A button adding asks its nonce with `?add`, which binds it to the
  account it adds to: a credential the chooser hands back after the device
  signed in to another account adds to neither.

## Device session

A browser holds one account (`session.ts`): every sign-in — a passkey's, a
provider's, a guest's mint — leaves an HttpOnly `__Host-mecha_session` cookie on
`/` and a readable `mecha_session_hint`. The cookie is never renewed, so
it lasts 30 days from the sign-in that set it (`since`), and it names the way the
account came in, which must still stand when it is taken up: the passkey still
the account's, the provider's link still there, the guest still a guest. Only
a request from the door's own origin is given one: a page elsewhere may sign
in for a token, never replace this browser's session.

- `POST /auth/session` answers the cookie's account as a **user token**,
  signed in as it was: the terminal keeps the token in localStorage, which a
  redirect cannot write and a bearer outlives by a week at most. 401 when no
  way stands.
- An account a sign-in found while another is the device's is held in an
  HttpOnly `__Host-mecha_session_held` cookie for five minutes, which `/session`
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
- `POST /auth/signout` clears every cookie.

Each is refused (403) from another origin than the door's: `WEBAUTHN_ORIGIN`
when configured; behind the dev door, the forwarded Host's when it is
localhost or a one-label container name such as `caddy`. Passkey ceremonies
there stay on localhost.

### Cookie isolation

HTTPS device-session, held-offer and provider-state cookies use `__Host-` names,
`Secure`, `Path=/`, and no `Domain`, preventing sibling subdomains from planting
credentials. Provider state names include the provider because their paths coincide.
Plain HTTP development uses unprefixed names on the auth paths. The readable
`mecha_session_hint` is not a credential. Doors strip these credential cookies
from non-auth requests while preserving unrelated application cookies.

HTTPS does not accept the former unprefixed cookies. Signed-in users must
authenticate again once existing access credentials stop working. A guest with
a valid stored bearer can restore its device cookie through session adoption.
A guest whose only
credential was the old cookie cannot recover that guest identity through it;
its stored data is not deleted. There is no compatibility switch.


## Ways in

An account's ways in — its passkeys and provider links — are listed, added and
removed on the strength of this device's session cookie, from the door's own
origin (403 otherwise), never a bearer token, which outlives its sign-out. A
guest has none to change (403): its ways are signing in. Adding or removing
one needs the session signed in within the last ten minutes (`since`), else
401 `{"error": "insufficient_user_authentication", "max_age": 600}`, RFC
9470's answer: NIST SP 800-63B's reauthentication before an authenticator is
bound.

- `POST /auth/ways` answers `{ways, recent, recovery}`: each way (`kind`
  `passkey` with its `id`, or `provider` with `provider`, `issuer`, `sub`,
  `name`, `email`; `added` when known), `current` on the one this device came
  in by; whether a change may be made now; and whether to ask to set up
  recovery, below.
- `POST /auth/ways/passkey` answers the creation options, the account's own
  passkeys excluded, and `POST /auth/ways/passkey/verify {state, response}`
  adds the passkey, the device still signed in to that account.
- A provider's way is added through its own sign-in, with `add` ([Provider
  sign-in](#provider-sign-in)).
- Every change is made under the account's lock while the way that
  authorized it still stands and its sign-in is still recent (401
  otherwise), at completion as at the start.
- A provider's way names its subject, so a session, refresh family or native
  ticket stands only while that very link does: a link put in a removed
  one's place is no way back for the removed subject's sessions. One from
  before ways named their subject is signed in again.
- A provider's sign-in counts as recent when it is made, as the provider
  vouches for the person then: requiring its own `auth_time` would leave an
  account signed in only by Google's button, which seldom gives one, no way
  to add a passkey.
- `POST /auth/ways/remove {kind, id}` or `{kind, provider, issuer, sub}`
  removes a way while another stays (409 `the last way in`), never the one
  this device came in by (409): signing in by another removes it. A session
  that came in by a way removed ends at its next exchange.
- **Set up recovery** is asked (`recovery: true`) of an account with one way
  in that had an external effect before this sign-in. The effect is stamped
  where the airlock claims it: the service puts a trigger on the airlock's
  ledger (`STAMP_EFFECTS`, `schema.ts`), whose insert runs under the claims
  of the request that moved the machine, so a person's write stamps their
  account in `mecha_auth.account_recovery` and the service's own moves stamp
  none, nor does a subject naming no account, whose effect goes on. A way by a
  provider this deployment no longer signs in by does not count. `POST /auth/ways/later` is Not now: asked again after a day, then
  two, four, … up to 64.

Not built yet: telling an account's other ways when one is added or removed,
and the broker's ways (email, phone, password, recovery codes).

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

`OIDC_PROVIDERS` names the providers on, a deployment's alone: the cluster
leaves it empty, and a release sets it to its program's. A provider is found
by its discovery document. Each setting is `signIn`'s
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

A person signed in through a provider and one holding a passkey are two
`app_user`s until one adds the other's way ([Ways in](#ways-in)): a guest
becomes one or the other, once, and accounts are never merged.

All auth tables (`webauthn_credential`, `identity_link`, `webauthn_challenge`,
`auth_native_ticket`, `auth_refresh_token`, `account_recovery`) live in
`mecha_auth`, which no app role may use.

`identity_link` is `(provider, issuer, sub, user_id, created_at)`, keyed by
`(provider, issuer, sub)` and indexed on `(issuer, sub)` so providers sharing a
broker issuer resolve to one account (at most one link per issuer per account),
with the provider's `name`, `picture` and verified `email` where it gives them,
refreshed on every sign-in. An app that keeps its people elsewhere copies them with a trigger on
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
