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
