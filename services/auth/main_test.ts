// Requires DATABASE_URL pointing at a throwaway postgres, and the rest of the
// environment main.ts reads as the dev cluster sets it (cluster.cue). app_user is owned elsewhere (see main.ts); tests
// create a minimal stand-in before running the service's own migration
// against it.
import { fileURLToPath } from "node:url";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
// deno-lint-ignore no-import-prefix
} from "jsr:@std/assert@1.0.13";
import { isoBase64URL, isoCBOR, isoUint8Array, toHash } from "@simplewebauthn/server/helpers";
import {
  admittedOrigin,
  androidOrigins,
  ceremonyOrigin,
  ceremonyOrigins,
  doorOrigin,
  createHandler,
  handler,
  issueUserToken,
  links,
  migrate,
  REFRESH_TOKEN_TTL_S,
  signJwt,
  sql,
  verifyJwt,
} from "./main.ts";
import { encodeBase64Url, randomToken, sha256url } from "./jwt.ts";
import { PUBLIC_WHERE } from "./where.ts";
import { HELD_COOKIE, HINT_COOKIE, SESSION_COOKIE } from "./session.ts";
import { nameHandle } from "./handles.ts";
import { type Profile, providersFrom, type User } from "./oidc.ts";
import { PUBLIC_WHERE as CLIENT_PUBLIC_WHERE } from "../../packages/client/src/public-where.ts";

/** An account's session, as a passkey would sign it in. */
const accountToken = (id: string, handle: string, profile: { name?: string; email?: string } = {}) =>
  issueUserToken({ id, handle, ...profile }, { acr: "phr", amr: ["swk"], auth_time: Math.floor(Date.now() / 1000) });

await sql`CREATE TABLE IF NOT EXISTS app_user (
  id uuid primary key,
  handle text not null unique,
  created_at timestamptz not null default now()
)`;
// The gatekeeper asks whether a table is floored, so the table it is asked
// about has to exist and carry the column that answers.
await sql`CREATE TABLE IF NOT EXISTS article (
  id uuid primary key default gen_random_uuid(),
  scope_id text generated always as ('public:') stored not null
)`;
await sql`CREATE TABLE IF NOT EXISTS scoped_article (
  id uuid primary key default gen_random_uuid(),
  scope_id text not null default 'public:'
)`;
await sql`CREATE TABLE IF NOT EXISTS mutable_article (
  id uuid primary key default gen_random_uuid(),
  scope_id text not null
)`;
await sql`CREATE TABLE IF NOT EXISTS owned_article (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  scope_id text generated always as ('user:' || owner_id) stored not null
)`;
await sql`CREATE TABLE IF NOT EXISTS private_article (
  id uuid primary key default gen_random_uuid(),
  scope_id text generated always as ('user:private') stored not null
)`;
await sql`CREATE TABLE IF NOT EXISTS virtual_article (
  id uuid primary key default gen_random_uuid(),
  scope_id text generated always as ('public:') virtual not null
)`;
await sql`CREATE TABLE IF NOT EXISTS nullable_article (
  id uuid primary key default gen_random_uuid(),
  scope_id text generated always as ('public:') stored
)`;
await sql`CREATE TABLE IF NOT EXISTS partitioned_article (
  id int,
  owner_id uuid not null,
  scope_id text generated always as ('public:') stored not null
) PARTITION BY RANGE (id)`;
await sql`CREATE TABLE IF NOT EXISTS partitioned_article_child (
  id int,
  owner_id uuid not null,
  scope_id text generated always as ('user:' || owner_id) stored not null
)`;
await sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_inherits
    WHERE inhparent = 'partitioned_article'::regclass AND inhrelid = 'partitioned_article_child'::regclass) THEN
    ALTER TABLE partitioned_article ATTACH PARTITION partitioned_article_child FOR VALUES FROM (0) TO (10);
  END IF;
END $$`;
await sql`CREATE TABLE IF NOT EXISTS inherited_article (
  id int,
  owner_id uuid not null,
  scope_id text generated always as ('public:') stored not null
)`;
await sql`CREATE TABLE IF NOT EXISTS inherited_article_child (
  scope_id text generated always as ('user:' || owner_id) stored not null
) INHERITS (inherited_article)`;
// A per-row shape is answered as the subject, so the role the gate switches
// to has to exist, and the fixture needs a policy for it to read through:
// gk_doc is readable by its owner, gk_line is content of a doc.
await sql`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF;
END $$`;
await sql`GRANT USAGE ON SCHEMA public, mecha TO app_user`;
await sql`CREATE TABLE IF NOT EXISTS gk_doc (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null
)`;
await sql`CREATE TABLE IF NOT EXISTS gk_line (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references gk_doc(id),
  scope_id text generated always as ('public:') stored not null
)`;
await sql`ALTER TABLE gk_doc ENABLE ROW LEVEL SECURITY`;
await sql`DROP POLICY IF EXISTS gk_doc_own ON gk_doc`;
await sql`CREATE POLICY gk_doc_own ON gk_doc FOR SELECT TO app_user USING (owner_id = auth_uid())`;
await sql`GRANT SELECT ON gk_doc, gk_line TO app_user`;
await sql`INSERT INTO mecha.shape_key VALUES
  ('public.gk_doc', 'id', 'public.gk_doc', 'id'),
  ('public.gk_line', 'doc_id', 'public.gk_doc', 'id')
  ON CONFLICT DO NOTHING`;
await migrate();
await sql`delete from mecha_auth.webauthn_credential`;
await sql`delete from mecha_auth.identity_link`;
await sql`delete from app_user`;

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://auth:9999${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const opts = { sanitizeResources: false, sanitizeOps: false };

Deno.test({
  name: "register/start is usernameless: generated identity, resident key",
  ...opts,
  fn: async () => {
    const res = await handler(post("/auth/register/start", {}));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.challenge, "string");
    assertEquals(body.rp.id, "localhost");
    // The passkey manager names the account by its words, without the suffix others see.
    assert(/^[a-z]+ [a-z]+$/.test(body.user.name) && body.user.displayName === body.user.name, `the generated name, got ${body.user.name}`);
    assertEquals(body.authenticatorSelection.residentKey, "required");
    assert(Array.isArray(body.pubKeyCredParams) && body.pubKeyCredParams.length > 0);
    const st = await verifyJwt(body.state);
    assert(st !== null);
    assertEquals(st.purpose, "register");
    assertEquals(String(st.handle).replace(/-[0-9a-f]{4}$/, "").replaceAll("-", " "), body.user.name);
    assertEquals(st.challenge, body.challenge);
    assertEquals(typeof st.userId, "string");
  },
});

Deno.test({
  name: "login/start is discoverable: no identifier, empty allowCredentials",
  ...opts,
  fn: async () => {
    const res = await handler(post("/auth/login/start", {}));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.challenge, "string");
    assertEquals(body.rpId, "localhost");
    assertEquals(body.allowCredentials.length, 0);
    const st = await verifyJwt(body.state);
    assert(st !== null);
    assertEquals(st.purpose, "login");
    assertEquals(st.challenge, body.challenge);
  },
});

Deno.test({
  name: "register/start from a guest's session keeps the guest's identity",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const res = await handler(post("/auth/register/start", {}, guest.token));
    assertEquals(res.status, 200);
    const st = await verifyJwt((await res.json()).state);
    assertEquals([st?.userId, st?.handle, st?.promote], [guest.user.id, guest.user.handle, true]);
  },
});

Deno.test({
  name: "a guest's token says it is a guest, and an account's does not",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    assertEquals([(await verifyJwt(guest.token))?.acr, guest.user.guest], ["0", true]);
    // Every session says when it was signed in, so a policy can refuse a token
    // that says nothing rather than take it for an account.
    const account = await verifyJwt(await accountToken(guest.user.id, guest.user.handle));
    assertEquals([account?.acr, typeof account?.auth_time, account?.guest], ["phr", "number", undefined]);
  },
});

Deno.test({
  name: "register/start refuses to add a passkey to an account's session",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const account = await accountToken(guest.user.id, guest.user.handle);
    const res = await handler(post("/auth/register/start", {}, account));
    assertEquals(res.status, 409);
    await res.body?.cancel();
  },
});

Deno.test({
  name: "register/start refuses a token that is not a session",
  ...opts,
  async fn() {
    const res = await handler(post("/auth/register/start", {}, "garbage"));
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
});

Deno.test({
  name: "register/verify rejects garbage state and garbage response",
  ...opts,
  fn: async () => {
    let res = await handler(
      post("/auth/register/verify", { state: "garbage", response: {} }),
    );
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "invalid state");

    const start = await handler(post("/auth/register/start", {}));
    const { state } = await start.json();
    res = await handler(
      post("/auth/register/verify", { state, response: { junk: true } }),
    );
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "registration verification failed");
  },
});

Deno.test({
  name: "login/verify rejects garbage cleanly",
  ...opts,
  fn: async () => {
    const start = await handler(post("/auth/login/start", { handle: "bob" }));
    const { state } = await start.json();
    const res = await handler(
      post("/auth/login/verify", { state, response: { id: "dGVzdC1jcmVk" } }),
    );
    assertEquals(res.status, 401);
    // The browser signals the credential unknown, so the authenticator stops offering it.
    assertEquals(await res.json(), { error: "authentication verification failed", unknownCredential: true });
  },
});

Deno.test({
  name: "whoami 401s without a token",
  ...opts,
  fn: async () => {
    const res = await handler(new Request("http://auth:9999/auth/whoami"));
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "invalid token");
  },
});

Deno.test({
  name: "issued user JWT carries the frozen claims and satisfies whoami",
  ...opts,
  fn: async () => {
    const id = crypto.randomUUID();
    await sql`insert into app_user (id, handle) values (${id}, ${`alice-${id.slice(-4)}`})`;
    const token = await accountToken(id, "alice");
    const claims = await verifyJwt(token);
    assert(claims !== null);
    assertEquals(claims.role, "app_user");
    assertEquals(claims.sub, id);
    assertEquals(claims.handle, "alice");
    const exp = claims.exp as number;
    const sevenDays = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    assert(Math.abs(exp - sevenDays) < 60, `exp ${exp} not ~7d out`);
    const res = await handler(
      new Request("http://auth:9999/auth/whoami", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id, handle: "alice" });
    // A token outlives its account's deletion; whoami does not answer for it.
    await sql`delete from app_user where id = ${id}`;
    assertEquals((await handler(new Request("http://auth:9999/auth/whoami", { headers: { authorization: `Bearer ${token}` } }))).status, 401);
  },
});

Deno.test({
  name: "guest mints a fresh app_user per call with a valid token",
  ...opts,
  fn: async () => {
    const res = await handler(post("/auth/guest", {}));
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/.test(body.user.handle), `generated handle, got ${body.user.handle}`);
    const claims = await verifyJwt(body.token);
    assert(claims !== null);
    assertEquals(claims.role, "app_user");
    assertEquals(claims.sub, body.user.id);
    assertEquals(claims.handle, body.user.handle);
    const rows = await sql`select handle from app_user where id = ${body.user.id}`;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].handle, body.user.handle);
    // Each call is a fresh guest — the endpoint never reuses an identity.
    const again = await (await handler(post("/auth/guest", {}))).json();
    assert(again.user.id !== body.user.id, "second guest call reused the identity");
  },
});

// --- the sync path's gatekeeper ---
//
// The refusals are the substance. A mint that works proves the happy path; what
// makes this a boundary is that every parameter deciding reach is compared, and
// that a token for one shape cannot be spent on another.

function shapeReq(token: string, uri: string, method = "GET"): Request {
  return new Request("http://auth:9999/auth/shape/verify", {
    headers: {
      authorization: `Bearer ${token}`,
      "x-forwarded-uri": uri,
      "x-forwarded-method": method,
    },
  });
}

async function mint(table: string) {
  const user = await sql`INSERT INTO app_user (id, handle)
    VALUES (gen_random_uuid(), ${"gk-" + crypto.randomUUID().slice(0, 8)}) RETURNING id, handle`;
  const userToken = await accountToken(user[0].id, user[0].handle);
  const res = await handler(
    new Request("http://auth:9999/auth/shape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ table }),
    }),
  );
  return { res, userToken, uid: user[0].id as string };
}

Deno.test({
  name: "the shape token carries the subject's scopes, not the client's request",
  ...opts,
  async fn() {
    const { res, uid } = await mint("scoped_article");
    assertEquals(res.status, 200);
    const body = await res.json();
    // The same derivation the CRUD path reads, so the two cannot disagree.
    assertEquals(body.where, `scope_id IN ('public:','user:${uid}')`);
    const claims = await verifyJwt(body.token);
    assertEquals(claims!.table, "scoped_article");
    assertEquals(claims!.where, body.where);
  },
});

Deno.test({
  name: "public stored-generated leaf scopes share one predicate while keeping distinct subjects",
  ...opts,
  async fn() {
    const first = await mint("article");
    const second = await mint("article");
    assert(first.uid !== second.uid);
    for (const minted of [first, second]) {
      assertEquals(minted.res.status, 200);
      const body = await minted.res.json();
      assertEquals(body.where, "scope_id IN ('public:')");
      const claims = await verifyJwt(body.token);
      assertEquals(claims!.sub, minted.uid);
      assertEquals(claims!.table, "article");
      assertEquals(claims!.where, body.where);
      const uri = `/v1/shape?table=article&where=${encodeURIComponent(body.where)}`;
      assertEquals((await handler(shapeReq(body.token, uri))).status, 200);
      const wider = `scope_id IN ('public:','user:${minted.uid}')`;
      assertEquals((await handler(shapeReq(body.token, `/v1/shape?table=article&where=${encodeURIComponent(wider)}`))).status, 403);
    }
  },
});

Deno.test({
  name: "defaults, mutable scopes, private generated scopes and virtual scopes retain full subject reach",
  ...opts,
  async fn() {
    for (const table of ["scoped_article", "mutable_article", "owned_article", "private_article", "virtual_article"]) {
      const minted = await mint(table);
      assertEquals(minted.res.status, 200, table);
      const body = await minted.res.json();
      assertEquals(body.where, `scope_id IN ('public:','user:${minted.uid}')`, table);
      assertEquals((await verifyJwt(body.token))!.where, body.where);
    }
    assertEquals((await mint("nullable_article")).res.status, 409);
  },
});

Deno.test({
  name: "public parent expressions cannot remove reachable private scopes stored by descendants",
  ...opts,
  async fn() {
    for (const [table, insertInto] of [
      ["partitioned_article", "partitioned_article"],
      ["inherited_article", "inherited_article_child"],
    ]) {
      const { res, uid } = await mint(table);
      assertEquals(res.status, 200);
      await sql`INSERT INTO ${sql(insertInto)} (id, owner_id) VALUES (1, ${uid}::uuid)`;
      const rows = await sql`SELECT scope_id FROM ${sql(table)} WHERE owner_id = ${uid}::uuid`;
      assertEquals(rows.map((row) => row.scope_id), [`user:${uid}`]);
      assertEquals((await res.json()).where, `scope_id IN ('public:','user:${uid}')`, table);
    }
  },
});

Deno.test({
  name: "a shape request matching its token is allowed",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const uri = `/v1/shape?table=article&where=${encodeURIComponent(where)}`;
    assertEquals((await handler(shapeReq(token, uri))).status, 200);
  },
});

Deno.test({
  name: "a token for one table cannot be spent on another",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const uri = `/v1/shape?table=app_user&where=${encodeURIComponent(where)}`;
    assertEquals((await handler(shapeReq(token, uri))).status, 403);
  },
});

Deno.test({
  name: "a widened predicate is refused, and so is a dropped one",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token } = await res.json();
    const wide = encodeURIComponent("scope_id IS NOT NULL");
    assertEquals((await handler(shapeReq(token, `/v1/shape?table=article&where=${wide}`))).status, 403);
    // Absent is not equal. A `??` in the comparison would read this as allowed.
    assertEquals((await handler(shapeReq(token, `/v1/shape?table=article`))).status, 403);
  },
});

Deno.test({
  name: "columns, params and the secret stay server-owned",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    for (const extra of ["columns=id,body", "params[1]=x", "secret=guessed"]) {
      const uri = `/v1/shape?table=article&where=${w}&${extra}`;
      assertEquals((await handler(shapeReq(token, uri))).status, 403);
    }
  },
});

Deno.test({
  name: "a repeated parameter is refused, whichever copy matches",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    // Electric keeps the last copy of a repeated parameter; a gate that read
    // the first would pass `table=article&table=app_user` and hand Electric
    // the second. Neither order may pass, and nor may a benign duplicate.
    for (
      const uri of [
        `/v1/shape?table=article&table=app_user&where=${w}&where=true`,
        `/v1/shape?table=app_user&table=article&where=true&where=${w}`,
        `/v1/shape?table=article&where=${w}&where=${w}`,
        `/v1/shape?table=article&table=article&where=${w}`,
      ]
    ) {
      assertEquals((await handler(shapeReq(token, uri))).status, 403, uri);
    }
  },
});

Deno.test({
  name: "a fragment does not hide a parameter",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    // A request line has no fragment: the proxy and Electric read `#` as query
    // text, and a WHATWG parse would stop there and pass a request that
    // carries a second table behind it.
    for (const uri of [
      `/v1/shape?table=article&where=${w}#&table=app_user&where=true`,
      `/v1/shape?table=article&where=${w}%23&table=app_user&where=true`,
      `/v1/shape?table=article&where=${w}#`,
    ]) {
      assertEquals((await handler(shapeReq(token, uri))).status, 403, uri);
    }
  },
});

Deno.test({
  name: "a parameter the gate does not know is refused",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    // Electric's paging and streaming parameters pass; anything else is a
    // parameter added after this gate was written, and its reach is unknown.
    const paging = `/v1/shape?table=article&where=${w}&offset=-1&live=true&handle=abc&cursor=1&experimental_live_sse=true`;
    assertEquals((await handler(shapeReq(token, paging))).status, 200);
    for (const extra of ["table[]=app_user", "schema=other", "columns=secret", "params=x"]) {
      const uri = `/v1/shape?table=article&where=${w}&${extra}`;
      assertEquals((await handler(shapeReq(token, uri))).status, 403, extra);
    }
  },
});

// An on-demand collection asks for its rows as subset snapshots of the one
// shape its token names, from `offset=now` with only changes logged, and
// replica=full so an update of a row it never loaded is a whole row. The
// premises that make a subset only narrow the token are tests/entrypoint.sh's,
// against Electric itself; this holds the vocabulary and the grammar.
Deno.test({
  name: "a subset snapshot passes, and only in the form the client sends it",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    const subset = `/v1/shape?table=article&where=${w}&offset=now&log=changes_only&replica=full` +
      `&subset__where=${encodeURIComponent('"x" = $1')}&subset__params=${encodeURIComponent('{"1":"a"}')}` +
      `&subset__limit=1&subset__order_by=${encodeURIComponent('"x" DESC')}`;
    assertEquals((await handler(shapeReq(token, subset))).status, 200);
    for (const extra of ["replica=default", "replica=", "replica=full&replica=default"]) {
      const uri = `/v1/shape?table=article&where=${w}&${extra}`;
      assertEquals((await handler(shapeReq(token, uri))).status, 403, extra);
    }
    // A subset outside the grammar is refused as Electric refuses one, which
    // the store reads as the program's error and asks no further.
    for (const [extra, param] of [
      ["subset__offset=1", "offset"],
      // Regression: a repeated subset parameter was a 403, which the store
      // takes for a token to re-mint and asks again seven times.
      ["subset__where=true&subset__where=false", "where"],
      [`subset__params=${encodeURIComponent("{}")}&subset__params=${encodeURIComponent("{}")}`, "params"],
      ["subset__offset=1&subset__offset=2", "offset"],
      [`subset__where_expr=${encodeURIComponent("{}")}`, "where_expr"],
      [`subset__order_by_expr=${encodeURIComponent("[]")}`, "order_by_expr"],
      // Regression: the gate admitted any subset__where Electric parses, and
      // Electric parses a cast. Postgres ran it on rows outside the token's
      // where and answered `invalid input syntax for type integer:
      // "secret_1"`, a value of a row the token does not reach.
      [`subset__where=${encodeURIComponent('"x"::int4 > 0')}`, "where"],
      [`subset__where=${encodeURIComponent('"x" + 1 > 0')}`, "where"],
      [`subset__where=${encodeURIComponent('"pg_sleep"(1) IS NULL')}`, "where"],
      [`subset__where=${encodeURIComponent('true) OR (true')}`, "where"],
      [`subset__order_by=${encodeURIComponent('"x"::int4')}`, "order_by"],
      ["subset__limit=1e3", "limit"],
    ]) {
      const res = await handler(shapeReq(token, `/v1/shape?table=article&where=${w}&${extra}`));
      assertEquals(res.status, 400, extra);
      assertEquals(Object.keys((await res.json()).errors.subset), [param], extra);
    }
    assertEquals((await handler(shapeReq(token, subset, "POST"))).status, 403);
  },
});

// Regression: the grammar admitted `"handle" LIKE $1` whatever $1 held, and
// Postgres raises "LIKE pattern must not end with escape character" only once
// a row's value has matched the pattern up to that escape. Against Electric,
// `{"1":"Fla\\"}` on the team table answered 500 and `{"1":"Zzz\\"}` 200: a
// bit per request about rows the token does not reach. No view the store
// maintains filters by a pattern, so a pattern is refused whatever it binds.
Deno.test({
  name: "a subset states no pattern, and binds its params by position",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const uri = (subsetWhere: string, params?: string) =>
      `/v1/shape?table=article&where=${encodeURIComponent(where)}&offset=now&log=changes_only&replica=full` +
      `&subset__where=${encodeURIComponent(subsetWhere)}` +
      (params === undefined ? "" : `&subset__params=${encodeURIComponent(params)}`);
    const status = async (subsetWhere: string, params?: string) => (await handler(shapeReq(token, uri(subsetWhere, params)))).status;
    for (const [w, p] of [
      ['"x" = $1', '{"1":"a"}'],
      ['"x" = ANY($1)', '{"1":"{a,b}"}'],
      // A null the client compiled is left out of the params, so $2 is unbound.
      ['"x" = $1 OR "x" = $2 OR "y" = $3', '{"1":"a","3":"b"}'],
    ]) assertEquals(await status(w, p), 200, `${w} ${p}`);
    for (const [w, p] of [
      ['"x" LIKE $1', '{"1":"adm%"}'],
      ['"x" ILIKE $1', '{"1":"adm%"}'],
      ['"x" LIKE $1', String.raw`{"1":"adm\\"}`],
      [String.raw`"x" LIKE 'adm\'`, undefined],
      ['LOWER("x") = $1', '{"1":"a"}'],
      ['"x" = $1', '{"1":1}'],
      ['"x" = $1', '["a"]'],
      ['"x" = $1', '{"01":"a"}'],
      ['"x" = $1', "not json"],
    ] as const) assertEquals(await status(w, p), 400, `${w} ${p}`);
  },
});

// Regression: the grammar admitted a column compared with a column, and
// Postgres casts one of two numeric types to the other on every row:
// `"amount" = "ratio"` (numeric, float8) raised `value out of range` on a row
// holding 1e400, a bit per request about rows the token does not reach. A
// typed literal picks the column's cast the same way, as two adjacent
// operands: `"amount" = "float8" '1'` raises on that row where
// `"amount" = 1.5` reads none. A comparison is a column against a $n or a
// literal, whose type Postgres infers from the column.
Deno.test({
  name: "a subset compares a column with a value only",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const answer = async (subsetWhere: string) => {
      const res = await handler(shapeReq(token,
        `/v1/shape?table=article&where=${encodeURIComponent(where)}&offset=now&log=changes_only&replica=full` +
          `&subset__where=${encodeURIComponent(subsetWhere)}&subset__params=${encodeURIComponent('{"1":"a","2":"b","3":"c"}')}`));
      return res.status === 400 ? Object.keys((await res.json()).errors.subset) : res.status;
    };
    // What electric-db-collection 0.4.0's compiler emits.
    for (const w of [
      "true = true", "true", "false", '"x" = $1', '$1 = "x"', '"x" >= $1', '"x" <> $1', '"x" = ANY($1)',
      '"x" IS NULL', '"x" IS NOT NULL', 'NOT ("x" = $1)', '("x" = $1) AND ("y" > $2) AND ("z" < $3)',
      '"x" > $1 OR ("x" = $1 AND "id" > $2)', `"x" = 8 AND "y" = 'f' AND "z" = 1.5`,
    ]) assertEquals(await answer(w), 200, w);
    for (const w of [
      '"amount" = "ratio"', `"amount" = "float8" '1'`, '"x" < "y"', '"x" = ANY("y")', '$1 = ANY("x")', `"x" = "int4" '1'`, `"x" = "numeric" $1`,
      '"x" = $1 $2', '"x" = NULL', '$1 IS NULL', '"x"', 'NOT "x"', '"x" = $1 AND', '("x" = $1', '"x" = ($1)', '"x" = $1 "y" = $2',
    ]) assertEquals(await answer(w), ["where"], w);
  },
});

// Regression: URLSearchParams read `where=title%20%3D%20'a;b'` as the
// token's predicate and passed it, and Caddy's re-encoding through Go's
// ParseQuery dropped the pair, so Electric served the whole table.
Deno.test({
  name: "a query Caddy would read differently from the gate is refused",
  ...opts,
  async fn() {
    const where = `"title" = 'a;b%'`;
    const token = await signJwt({ typ: "shape", table: "article", where, exp: Math.floor(Date.now() / 1000) + 60 });
    const encoded = encodeURIComponent(where);
    assertEquals((await handler(shapeReq(token, `/v1/shape?table=article&where=${encoded}`))).status, 200);
    for (const raw of [encoded.replace("%3B", ";"), encoded.replace("%25", "%"), `${encoded}&offset=-1%zz`, `${encoded}&offset=%FF`]) {
      assertEquals((await handler(shapeReq(token, `/v1/shape?table=article&where=${raw}`))).status, 403, raw);
    }
  },
});

Deno.test({
  name: "only GET reaches a shape",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const uri = `/v1/shape?table=article&where=${encodeURIComponent(where)}`;
    for (const method of ["POST", "DELETE", "PUT"]) {
      assertEquals((await handler(shapeReq(token, uri, method))).status, 403, method);
    }
    // Absent is not GET: a proxy that forwards no method has not said.
    const unsaid = new Request("http://auth:9999/auth/shape/verify", {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-uri": uri },
    });
    assertEquals((await handler(unsaid)).status, 403);
  },
});

Deno.test({
  name: "only the shape route passes, whatever the token says",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    assertEquals((await handler(shapeReq(token, `/v1/shape?table=article&where=${w}`))).status, 200);
    for (const uri of [`/v1/health?table=article&where=${w}`, `/v1/shapes?table=article&where=${w}`, `/v1/shape/x?table=article&where=${w}`]) {
      assertEquals((await handler(shapeReq(token, uri))).status, 403, uri);
    }
  },
});

Deno.test({
  name: "a shape needs a session: the floor is all a shape carries",
  ...opts,
  async fn() {
    // The CRUD path keeps anon out of a table by its permissive policies, which
    // sit above the floor; a shape carries the floor alone, so a subject
    // holding only public: would read on the sync path what CRUD refuses.
    const post = (headers: Record<string, string>) =>
      handler(new Request("http://auth:9999/auth/shape", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ table: "article" }),
      }));
    assertEquals((await post({})).status, 401);
    assertEquals((await post({ authorization: "Bearer nope" })).status, 401);
  },
});

Deno.test({
  name: "a session opens a table's public rows and nothing wider; a shape token is no session",
  ...opts,
  async fn() {
    const { res, userToken, uid } = await mint("article");
    const { token } = await res.json();
    const shape = (table: string, where: string) =>
      handler(shapeReq(userToken, `/v1/shape?table=${table}&where=${encodeURIComponent(where)}`));
    // Every subject's scopes open with public:, so the session reaches no row
    // a minted token would not, and a screen mounts without a mint per table.
    assertEquals(PUBLIC_WHERE, CLIENT_PUBLIC_WHERE);
    assertEquals((await shape("article", PUBLIC_WHERE)).status, 200);
    assertEquals((await shape("scoped_article", PUBLIC_WHERE)).status, 200);
    // Its own rows still need the mint, which reads the subject's scopes.
    assertEquals((await shape("scoped_article", `scope_id IN ('public:','user:${uid}')`)).status, 403);
    assertEquals((await shape("article", "true")).status, 403);
    assertEquals((await shape("article; drop table article", PUBLIC_WHERE)).status, 403);
    // And the shape token cannot stand in for a session.
    const mintWithShape = await handler(
      new Request("http://auth:9999/auth/shape", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ table: "article" }),
      }),
    );
    assertEquals(mintWithShape.status, 401);
  },
});

Deno.test({
  name: "a table name that could carry a predicate is refused",
  ...opts,
  async fn() {
    for (const t of ["article; drop table article", "article WHERE 1=1", "Article", ""]) {
      const { res } = await mint(t);
      assertEquals(res.status, 400, `accepted ${JSON.stringify(t)}`);
    }
  },
});

// --- per-row shapes ---
//
// A row the floor does not deliver is reached one shape at a time, keyed on a
// column the app declared (mecha.shape_key), and the gate answers as the
// subject: the app's own policies decide whether the parent row is readable.

async function mintRow(userToken: string, table: string, column: string, value: string) {
  return await handler(
    new Request("http://auth:9999/auth/shape", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ table, key: { column, value } }),
    }),
  );
}

Deno.test({
  name: "a per-row shape is minted for a row the subject reads, keyed by itself or by its parent",
  ...opts,
  async fn() {
    const { userToken, uid } = await mint("article");
    const [doc] = await sql`INSERT INTO gk_doc (owner_id) VALUES (${uid}::uuid) RETURNING id`;
    const own = await mintRow(userToken, "gk_doc", "id", doc.id);
    assertEquals(own.status, 200);
    const body = await own.json();
    assertEquals(body.where, `id = '${doc.id}'`);
    const claims = await verifyJwt(body.token);
    assertEquals(claims!.table, "gk_doc");
    assertEquals(claims!.where, body.where);
    const uri = `/v1/shape?table=gk_doc&where=${encodeURIComponent(body.where)}`;
    assertEquals((await handler(shapeReq(body.token, uri))).status, 200);

    const lines = await mintRow(userToken, "gk_line", "doc_id", doc.id);
    assertEquals(lines.status, 200);
    assertEquals((await lines.json()).where, `doc_id = '${doc.id}'`);
  },
});

Deno.test({
  name: "a per-row shape over another subject's row is refused, and so is one over no row",
  ...opts,
  async fn() {
    const { userToken } = await mint("article");
    const other = await mint("article");
    const [doc] = await sql`INSERT INTO gk_doc (owner_id) VALUES (${other.uid}::uuid) RETURNING id`;
    // The policy is the judge: the row exists, and this subject is not its owner.
    assertEquals((await mintRow(userToken, "gk_doc", "id", doc.id)).status, 403);
    assertEquals((await mintRow(userToken, "gk_line", "doc_id", doc.id)).status, 403);
    assertEquals((await mintRow(userToken, "gk_doc", "id", crypto.randomUUID())).status, 403);
  },
});

Deno.test({
  name: "a per-row shape keyed on an undeclared column is refused, whatever the row",
  ...opts,
  async fn() {
    const { userToken, uid } = await mint("article");
    const [doc] = await sql`INSERT INTO gk_doc (owner_id) VALUES (${uid}::uuid) RETURNING id`;
    // owner_id names a row the subject reads (their own app_user), but no edge
    // says gk_doc rows keyed by owner are that row's content.
    assertEquals((await mintRow(userToken, "gk_doc", "owner_id", uid)).status, 403);
    assertEquals((await mintRow(userToken, "article", "id", doc.id)).status, 403);
  },
});

Deno.test({
  name: "a per-row key that could carry a predicate is refused",
  ...opts,
  async fn() {
    const { userToken, uid } = await mint("article");
    const [doc] = await sql`INSERT INTO gk_doc (owner_id) VALUES (${uid}::uuid) RETURNING id`;
    for (const column of ["id = 'x' OR 1=1 --", "Id", ""]) {
      assertEquals((await mintRow(userToken, "gk_doc", column, doc.id)).status, 400, column);
    }
    // A key that is not an object is a bad request, not an outage.
    for (const key of [null, 5, "id"]) {
      const res = await handler(
        new Request("http://auth:9999/auth/shape", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
          body: JSON.stringify({ table: "gk_doc", key }),
        }),
      );
      assertEquals(res.status, 400, JSON.stringify(key));
    }
    // A value is a literal whatever it holds: quoted on the way out, and never
    // reaching a row it does not name.
    const res = await mintRow(userToken, "gk_doc", "id", `${doc.id}' OR '1'='1`);
    assertEquals(res.status, 403);
  },
});

Deno.test({
  name: "a table the floor does not reach cannot be shaped",
  ...opts,
  async fn() {
    // No scope_id: a predicate naming one would be answered 400 by Electric and
    // read as a sync fault, so the gate refuses where the reason is known.
    await sql`CREATE TABLE IF NOT EXISTS gk_unfloored (id int primary key)`;
    const { res } = await mint("gk_unfloored");
    assertEquals(res.status, 409);
    assert((await res.text()).includes("scope_id"));
    await sql`DROP TABLE gk_unfloored`;
    // A table that does not exist is not floored either; a regclass cast would
    // throw and turn the answer into a 500.
    assertEquals((await mint("gk_absent")).res.status, 409);
  },
});

// A passkey as a browser makes one: an EC2 P-256 key under a "none"
// attestation, and client data naming the page's origin.
type Cbor = Parameters<typeof isoCBOR.encode>[0];
async function passkey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const id = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = await toHash(isoUint8Array.fromUTF8String("localhost"));
  const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(bytes);
  const clientData = (type: string, challenge: string, origin: string) =>
    isoUint8Array.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  // WebCrypto signs r||s; WebAuthn carries ECDSA signatures as DER.
  const der = (sig: Uint8Array) => {
    const int = (n: Uint8Array) => {
      let i = 0;
      while (i < n.length - 1 && n[i] === 0) i++;
      const v = n[i] & 0x80 ? [0, ...n.slice(i)] : [...n.slice(i)];
      return [0x02, v.length, ...v];
    };
    const body = [...int(sig.slice(0, 32)), ...int(sig.slice(32))];
    return new Uint8Array([0x30, body.length, ...body]);
  };
  return {
    id: b64(id),
    register(challenge: string, origin: string) {
      const key = isoCBOR.encode(
        new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]),
      );
      const authData = isoUint8Array.concat([
        rpIdHash,
        new Uint8Array([0x41, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, id.length]),
        id,
        key,
      ]);
      const attestation = isoCBOR.encode(
        new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]),
      );
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        response: { clientDataJSON: b64(clientData("webauthn.create", challenge, origin)), attestationObject: b64(attestation) },
        clientExtensionResults: {},
      };
    },
    /** An assertion: user present (0x01), and verified too (0x05) where
     * `flags` says; a synced passkey's counter stays 0. */
    async login(challenge: string, origin: string, { flags = 0x01, counter = 1 } = {}) {
      const authData = isoUint8Array.concat([rpIdHash, new Uint8Array([flags, 0, 0, 0, counter])]);
      const data = clientData("webauthn.get", challenge, origin);
      const signed = isoUint8Array.concat([authData, await toHash(data)]);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(signed)));
      return {
        id: b64(id),
        rawId: b64(id),
        type: "public-key",
        response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(der(sig)) },
        clientExtensionResults: {},
      };
    },
  };
}

function atDoor(path: string, body: unknown, host: string, token?: string, jar?: Record<string, string>, origin?: string): Request {
  return new Request(`http://auth:9999${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(jar ? { cookie: Object.entries(jar).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
}
/** The cookies a response sets, by name. */
const cookies = (res: Response) =>
  Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, ...v]) => [k, v.join("=")]));

const door = "localhost:54321";
/** A passkey registered at the door, under `token`'s session and with `name`
 * when given. */
async function enroll(key: Awaited<ReturnType<typeof passkey>>, token?: string, name?: string) {
  const start = await (await handler(atDoor("/auth/register/start", name === undefined ? {} : { name }, door, token))).json();
  const res = await handler(
    atDoor("/auth/register/verify", { state: start.state, response: key.register(start.challenge, `https://${door}`) }, door),
  );
  assertEquals(res.status, 200, await res.clone().text());
  return { start, made: await res.json(), key };
}
async function signIn(key: Awaited<ReturnType<typeof passkey>>) {
  const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
  const res = await handler(
    atDoor("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, `https://${door}`) }, door),
  );
  assertEquals(res.status, 200, await res.clone().text());
  return await res.json();
}
// The user handle a credential was made under, as the Signal API takes it.
const userHandle = (id: string) => isoBase64URL.fromBuffer(new TextEncoder().encode(id));

Deno.test({
  name: "a guest is promoted once: its token adds no second passkey after",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const promoted = await enroll(await passkey(), guest.token);
    assertEquals(promoted.made.user, { id: guest.user.id, handle: guest.user.handle });
    // The Signal API's user handle is the one the authenticator stored, the
    // bytes register/start sent as user.id.
    assertEquals(promoted.made.passkey, { rpId: "localhost", userId: promoted.start.user.id });
    assertEquals(promoted.start.user.id, userHandle(guest.user.id));
    assertEquals((await signIn(promoted.key)).passkey, promoted.made.passkey);
    const start = await (await handler(atDoor("/auth/register/start", {}, door, guest.token))).json();
    const res = await handler(
      atDoor("/auth/register/verify", { state: start.state, response: (await passkey()).register(start.challenge, `https://${door}`) }, door),
    );
    assertEquals(res.status, 409);
    assertEquals(await res.json(), { error: "already an account" });
  },
});

Deno.test({
  name: "tokens say how they were signed in: a guest at acr 0, a passkey at phr, its binding as the authenticator reports it",
  ...opts,
  async fn() {
    const guest = await (await handler(atDoor("/auth/guest", {}, door))).json();
    const g = await verifyJwt(guest.token);
    assertEquals([g?.iss, g?.acr, g?.guest, g?.amr], ["mecha:stack", "0", undefined, undefined]);
    assert(typeof g?.auth_time === "number");
    // The test's authenticator sets no backup-eligible flag: a single-device passkey.
    const a = await verifyJwt((await enroll(await passkey(), guest.token)).made.token);
    assertEquals([a?.iss, a?.sub, a?.acr, a?.amr, a?.guest], ["mecha:stack", guest.user.id, "phr", ["pop"], undefined]);
  },
});

Deno.test({
  name: "a passkey unlocked by its person is two factors: amr says mfa only when the authenticator verified the user",
  ...opts,
  async fn() {
    const { key } = await enroll(await passkey());
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const res = await handler(
      atDoor("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, `https://${door}`, { flags: 0x05 }) }, door),
    );
    assertEquals(res.status, 200);
    assertEquals((await verifyJwt((await res.json()).token))?.amr, ["pop", "mfa"]);
  },
});

Deno.test({
  name: "a passkey's answer signs in once: replayed within its challenge's life it is refused, though a synced passkey's counter never climbs",
  ...opts,
  async fn() {
    const { key } = await enroll(await passkey());
    const answer = async () => {
      const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
      return { state: login.state, response: await key.login(login.challenge, `https://${door}`, { counter: 0 }) };
    };
    const first = await answer();
    const signed = await handler(atDoor("/auth/login/verify", first, door));
    assertEquals(signed.status, 200);
    await signed.body?.cancel();
    const replayed = await handler(atDoor("/auth/login/verify", first, door));
    assertEquals([replayed.status, await replayed.json()], [401, { error: "authentication verification failed" }]);
    // A new challenge answered at the same counter is the synced passkey's next sign-in.
    const again = await handler(atDoor("/auth/login/verify", await answer(), door));
    assertEquals(again.status, 200);
    await again.body?.cancel();
  },
});

Deno.test({
  name: "a guest's passkey sign-in into another account is login_required, holding that account for the reader to take or leave",
  ...opts,
  async fn() {
    const owner = await enroll(await passkey());
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const res = await handler(
      atDoor("/auth/login/verify", { state: login.state, response: await owner.key.login(login.challenge, `https://${door}`) }, door, guest.token),
    );
    assertEquals(res.status, 409);
    // No token: the guest stays the device's until the reader takes the account.
    const refused = await res.json();
    assertEquals([refused.error, refused.user, typeof refused.offer], ["login_required", { handle: owner.made.user.handle }, "string"]);
    const held = cookies(res);
    assertEquals(held[SESSION_COOKIE], undefined);
    const asked = await handler(atDoor("/auth/session", {}, door, undefined, held));
    assertEquals([asked.status, (await asked.json()).error], [409, "login_required"]);
    // Taking names the offer: another tab's older one answers the current offer.
    const stale = await handler(atDoor("/auth/session/switch", { offer: "another" }, door, undefined, held));
    assertEquals([stale.status, (await stale.json()).offer], [409, refused.offer]);
    const taken = await handler(atDoor("/auth/session/switch", { offer: refused.offer }, door, undefined, held));
    assertEquals(taken.status, 200);
    const session = await taken.json();
    assertEquals([session.user, (await verifyJwt(session.token))?.amr], [owner.made.user, ["pop"]]);
    const after = cookies(taken);
    assertEquals(after[HELD_COOKIE], "");
    assertEquals((await (await handler(atDoor("/auth/session", {}, door, undefined, after))).json()).user, owner.made.user);
  },
});

Deno.test({
  name: "a passkey's sign-in is the device's session: the cookie takes it up again until the passkey is gone",
  ...opts,
  async fn() {
    const { key, made } = await enroll(await passkey());
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const res = await handler(
      atDoor("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, `https://${door}`) }, door),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const jar = cookies(res);
    assert(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.includes("HttpOnly") && c.includes("Path=/;")));
    assertEquals(jar[HINT_COOKIE], "1");
    const again = await handler(atDoor("/auth/session", {}, door, undefined, jar));
    assertEquals(again.status, 200);
    const session = await again.json();
    assertEquals(session.user, made.user);
    const claims = await verifyJwt(session.token);
    assertEquals([claims?.sub, claims?.acr], [made.user.id, "phr"]);
    // From another origin the cookie is nobody's.
    const foreign = await handler(atDoor("/auth/session", {}, door, undefined, jar, "https://evil.test"));
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
    // The passkey removed, the session is over.
    await sql`delete from mecha_auth.webauthn_credential where user_id = ${made.user.id}`;
    const gone = await handler(atDoor("/auth/session", {}, door, undefined, jar));
    assertEquals(gone.status, 401);
    await gone.body?.cancel();
    // Signing out clears the cookies.
    const out = await handler(atDoor("/auth/signout", {}, door, undefined, jar));
    assertEquals([out.status, cookies(out)], [204, { [SESSION_COOKIE]: "", [HELD_COOKIE]: "", [HINT_COOKIE]: "" }]);
  },
});

Deno.test({
  name: "a guest's mint is the device's session while it is a guest; promoted, its cookie takes up nothing",
  ...opts,
  async fn() {
    const minted = await handler(atDoor("/auth/guest", {}, door));
    const guest = await minted.json();
    const jar = cookies(minted);
    const again = await handler(atDoor("/auth/session", {}, door, undefined, jar));
    const session = await again.json();
    assertEquals(session.user, { id: guest.user.id, handle: guest.user.handle, guest: true });
    assertEquals((await verifyJwt(session.token))?.acr, "0");
    await enroll(await passkey(), guest.token);
    const promoted = await handler(atDoor("/auth/session", {}, door, undefined, jar));
    assertEquals(promoted.status, 401);
    await promoted.body?.cancel();
  },
});

Deno.test({
  name: "a guest takes a provider's subject no account holds, once; one another account holds is taken",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const promoted = await signInAs({ ...alice, sub: "g-promote" }, guest.user.id);
    // It keeps its id and suffix and takes the provider's name.
    assertEquals(promoted, { id: guest.user.id, handle: `Alice-${guest.user.handle.slice(-4)}`, name: "Alice", email: "alice@example.test" });
    // Promoted, the guest's token adds no passkey.
    const start = await (await handler(atDoor("/auth/register/start", {}, door, guest.token))).json();
    const res = await handler(
      atDoor("/auth/register/verify", { state: start.state, response: (await passkey()).register(start.challenge, `https://${door}`) }, door),
    );
    assertEquals(res.status, 409);
    await res.body?.cancel();

    const other = await (await handler(post("/auth/guest", {}))).json();
    assertEquals(await links.userFor({ ...alice, sub: "g-promote" }, other.user.id), { taken: promoted });
    assertEquals((await sql`select count(*)::int as n from mecha_auth.identity_link where user_id = ${other.user.id}`)[0].n, 0);
  },
});

Deno.test({
  name: "a name given with the passkey is the handle's, ending in the account's own suffix",
  ...opts,
  async fn() {
    const made = await enroll(await passkey(), undefined, "  Ana  Maria ");
    assertEquals(made.made.user.handle, `Ana-Maria-${made.made.user.id.replaceAll("-", "").slice(-4)}`);
    // A guest named so keeps its id and suffix and takes the name.
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const promoted = await enroll(await passkey(), guest.token, "Davi");
    assertEquals(promoted.made.user, { id: guest.user.id, handle: `Davi-${guest.user.handle.slice(-4)}` });
    // The passkey is made under the name alone: the authenticator shows it.
    assertEquals([promoted.start.user.name, promoted.start.user.displayName], ["Davi", "Davi"]);
    // Nothing of a name left is no name.
    const empty = await handler(atDoor("/auth/register/start", { name: "🎉 !!" }, door));
    assertEquals([empty.status, await empty.json()], [400, { error: "a name needs a letter or a digit" }]);
  },
});

Deno.test({
  name: "a rename keeps the suffix and how the session was signed in; a name another account holds is refused",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const before = await verifyJwt(guest.token);
    const res = await handler(post("/auth/rename", { name: "Mango Lover" }, guest.token));
    assertEquals(res.status, 200);
    const renamed = await res.json();
    const suffix = guest.user.handle.slice(-4);
    assertEquals(renamed.user, { id: guest.user.id, handle: `Mango-Lover-${suffix}`, guest: true });
    const after = await verifyJwt(renamed.token);
    // Renaming renews nothing: the session ends when it was going to.
    assertEquals([after?.handle, after?.acr, after?.auth_time, after?.exp], [`Mango-Lover-${suffix}`, before?.acr, before?.auth_time, before?.exp]);
    assertEquals((await sql`select handle from app_user where id = ${guest.user.id}`)[0].handle, `Mango-Lover-${suffix}`);
    // Only an account with the same suffix can collide, and then it is said.
    await sql`insert into app_user (id, handle) values (gen_random_uuid(), ${`Taken-${suffix}`})`;
    const taken = await handler(post("/auth/rename", { name: "Taken" }, renamed.token));
    assertEquals([taken.status, await taken.json()], [409, { error: "name taken" }]);
    const blank = await handler(post("/auth/rename", { name: "  " }, renamed.token));
    assertEquals(blank.status, 400);
    await blank.body?.cancel();
    const nobody = await handler(post("/auth/rename", { name: "X" }));
    assertEquals(nobody.status, 401);
    await nobody.body?.cancel();
  },
});

Deno.test({
  name: "a guest's token outlives its promotion and renames nothing: it is no way into the account it became",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const promoted = await enroll(await passkey(), guest.token, "Davi");
    const res = await handler(post("/auth/rename", { name: "Mallory" }, guest.token));
    assertEquals([res.status, await res.json()], [409, { error: "already an account" }]);
    assertEquals((await sql`select handle from app_user where id = ${guest.user.id}`)[0].handle, promoted.made.user.handle);
  },
});

Deno.test({
  name: "a provider's first name names a new account, and the guest it promotes",
  ...opts,
  async fn() {
    const made = await signInAs({ ...alice, sub: "g-named", given: "Alice", name: "Alice Liddell" });
    assertEquals(made.handle, `Alice-${made.id.replaceAll("-", "").slice(-4)}`);
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const promoted = await signInAs({ ...alice, sub: "g-named-guest", given: null, name: "Bea Lima" }, guest.user.id);
    assertEquals(promoted.handle, `Bea-Lima-${guest.user.handle.slice(-4)}`);
    // Signing in again leaves the name the person chose since.
    await handler(post("/auth/rename", { name: "Bia" }, await accountToken(promoted.id, promoted.handle)));
    assertEquals((await signInAs({ ...alice, sub: "g-named-guest", given: null, name: "Bea Lima" })).handle, `Bia-${guest.user.handle.slice(-4)}`);
    // An account a provider made under a drawn name takes the provider's on
    // its next session, and keeps one it was renamed to.
    const drawn = (await (await handler(post("/auth/guest", {}))).json()).user;
    await sql`insert into mecha_auth.identity_link (provider, issuer, sub, user_id, name) values ('google', ${alice.issuer}, 'g-drawn', ${drawn.id}, 'Caio Prado')`;
    assertEquals((await links.handleOf("google", alice.issuer, "g-drawn", drawn.id))?.handle, `Caio-Prado-${drawn.handle.slice(-4)}`);
  },
});

// Regression: two promotions racing on one guest token both found it without
// a passkey, and the guest ended with two ways in.
Deno.test({
  name: "a guest's racing promotions make one passkey",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const starts = await Promise.all([0, 1].map(async () => await (await handler(atDoor("/auth/register/start", {}, door, guest.token))).json()));
    const keys = await Promise.all(starts.map(() => passkey()));
    const results = await Promise.all(starts.map((start, i) =>
      handler(atDoor("/auth/register/verify", { state: start.state, response: keys[i].register(start.challenge, `https://${door}`) }, door))
    ));
    assertEquals(results.map((r) => r.status).sort(), [200, 409]);
    assertEquals(await sql`select count(*)::int as n from mecha_auth.webauthn_credential where user_id = ${guest.user.id}`.then((r) => r[0].n), 1);
  },
});

Deno.test({
  name: "a passkey made at the dev door registers and signs in, whatever port the host gave the door",
  ...opts,
  async fn() {
    // The door publishes on an ephemeral port while the expected origin named
    // 8443, so every ceremony on a cluster launched without the port pinned
    // failed its origin check.
    const key = await passkey();
    const reg = await (await handler(atDoor("/auth/register/start", {}, door))).json();
    const made = await handler(
      atDoor("/auth/register/verify", { state: reg.state, response: key.register(reg.challenge, `https://${door}`) }, door),
    );
    assertEquals(made.status, 200, await made.clone().text());
    const user = (await made.json()).user;
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const signed = await handler(
      atDoor("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, `https://${door}`) }, door),
    );
    assertEquals(signed.status, 200, await signed.clone().text());
    assertEquals((await signed.json()).user, user);
  },
});

Deno.test({
  name: "a ceremony made anywhere but the door it reached is refused",
  ...opts,
  async fn() {
    const key = await passkey();
    for (const [origin, door] of [["https://evil.example", "localhost:54321"], ["https://localhost:54321", "localhost:1"]]) {
      const reg = await (await handler(atDoor("/auth/register/start", {}, door))).json();
      const res = await handler(
        atDoor("/auth/register/verify", { state: reg.state, response: key.register(reg.challenge, origin) }, door),
      );
      assertEquals(res.status, 401, `${origin} at ${door}`);
    }
  },
});

Deno.test("the dev door admits only the localhost relying party, at startup", async () => {
  // The compose default fills a forgotten WEBAUTHN_ORIGIN with the dev door;
  // a deployment naming its own relying party then booted and refused every
  // ceremony with a bare 401.
  assertEquals(admittedOrigin("localhost", "https://localhost:*"), "https://localhost:*");
  assertEquals(admittedOrigin("app.example", "https://app.example"), "https://app.example");
  assertThrows(() => admittedOrigin("app.example", "https://localhost:*"), Error, "WEBAUTHN_ORIGIN");
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--frozen", fileURLToPath(new URL("./main.ts", import.meta.url))],
    env: { WEBAUTHN_RP_ID: "app.example", WEBAUTHN_ORIGIN: "https://localhost:*" },
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(!success);
  assertStringIncludes(new TextDecoder().decode(stderr), "serves only WEBAUTHN_RP_ID=localhost");
});

Deno.test("an origin off the relying party's domain is refused at startup", async () => {
  // Checked only from the dev door's side, an origin the compose default RP id
  // (localhost) cannot cover booted and refused every ceremony with a 401.
  assertEquals(admittedOrigin("example.com", "https://app.example.com"), "https://app.example.com");
  assertEquals(admittedOrigin("localhost", "https://localhost:8443"), "https://localhost:8443");
  assertThrows(() => admittedOrigin("localhost", "https://app.example"), Error, "is not on WEBAUTHN_RP_ID");
  assertThrows(() => admittedOrigin("example.com", "https://badexample.com"), Error, "is not on WEBAUTHN_RP_ID");
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--frozen", fileURLToPath(new URL("./main.ts", import.meta.url))],
    env: { WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGIN: "https://app.example" },
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(!success);
  assertStringIncludes(new TextDecoder().decode(stderr), "is not on WEBAUTHN_RP_ID");
});

Deno.test("an origin no ceremony can have is refused at startup", async () => {
  // Compared exactly with the ceremony's bare https origin, an origin with a
  // trailing slash or a path, or http on a real host, booted and refused
  // every ceremony with a 401.
  assertEquals(admittedOrigin("localhost", "http://localhost:8080"), "http://localhost:8080");
  for (const origin of ["https://app.example/", "https://app.example/auth", "https://APP.example"]) {
    assertThrows(() => admittedOrigin("app.example", origin), Error, "is not an origin", origin);
  }
  assertThrows(() => admittedOrigin("app.example", "http://app.example"), Error, "is not https");
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--frozen", fileURLToPath(new URL("./main.ts", import.meta.url))],
    env: { WEBAUTHN_RP_ID: "app.example", WEBAUTHN_ORIGIN: "https://app.example/" },
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(!success);
  assertStringIncludes(new TextDecoder().decode(stderr), "set it to https://app.example");
});

Deno.test("a configured origin is exact, and only localhost stands for the dev door", () => {
  assertEquals(ceremonyOrigin("https://app.example", "localhost:54321"), "https://app.example");
  assertEquals(ceremonyOrigin("https://localhost:*", "localhost:54321"), "https://localhost:54321");
  assert(ceremonyOrigin("https://localhost:*", "evil.example:54321") !== "https://evil.example:54321");
  assert(ceremonyOrigin("https://localhost:*", null).endsWith("*"));
});

// A stack's own browser reaches the dev door as https://caddy:8443; with the
// ceremony's localhost-only origin standing in for the door's, every guest's
// adoption there answered 403 "another origin" and acceptance never settled.
Deno.test("the dev door's origin is the forwarded Host's, a container's name included, never a dotted one", () => {
  assertEquals(doorOrigin("https://app.example", "caddy:8443"), "https://app.example");
  assertEquals(doorOrigin("https://localhost:*", "localhost:54321"), "https://localhost:54321");
  assertEquals(doorOrigin("https://localhost:*", "caddy:8443"), "https://caddy:8443");
  assert(doorOrigin("https://localhost:*", "evil.example:8443") !== "https://evil.example:8443");
  assert(doorOrigin("https://localhost:*", null).endsWith("*"));
  assert(ceremonyOrigin("https://localhost:*", "caddy:8443") !== "https://caddy:8443");
});

/** A provider's sign-in, hinted at a guest or not. */
const signInAs = (p: Profile, guest: string | null = null) => links.userFor(p, guest) as Promise<User>;

const alice: Profile = {
  proof: { auth_time: Math.floor(Date.now() / 1000) },
  given: null,
  provider: "google",
  issuer: "https://accounts.google.com",
  sub: "g-alice",
  name: "Alice",
  picture: null,
  email: "alice@example.test",
};

Deno.test({
  name: "a provider's subject is one person, however many sign-ins race to make it",
  ...opts,
  fn: async () => {
    // Connections opened first: a sign-in on the one already open commits
    // before the others have connected, and nothing races.
    await Promise.all(Array.from({ length: 8 }, () => sql`select pg_sleep(0.05)`));
    for (const sub of ["g-race-1", "g-race-2", "g-race-3"]) {
      const racers = await Promise.all(Array.from({ length: 8 }, () => signInAs({ ...alice, sub })));
      assertEquals(new Set(racers.map((u) => u.id)).size, 1, sub);
    }
    const users = [await signInAs(alice)];
    const [link] = await sql`select user_id, email from mecha_auth.identity_link where provider = 'google' and sub = 'g-alice'`;
    assertEquals(link.user_id, users[0].id);
    assertEquals(link.email, "alice@example.test");
    await signInAs({ ...alice, name: "Alice B.", email: "alice.b@example.test" });
    assertEquals((await sql`select name, email from mecha_auth.identity_link where sub = 'g-alice'`)[0], {
      name: "Alice B.",
      email: "alice.b@example.test",
    });
    assertEquals(await links.handleOf("google", alice.issuer, alice.sub, users[0].id), {
      handle: users[0].handle,
      name: "Alice B.",
      email: "alice.b@example.test",
    });
    const token = await accountToken(users[0].id, users[0].handle, { name: "Alice B.", email: "alice.b@example.test" });
    const who = await handler(new Request("http://auth:9999/auth/whoami", { headers: { authorization: `Bearer ${token}` } }));
    assertEquals(who.status, 200);
    assertEquals(await who.json(), { id: users[0].id, handle: users[0].handle, name: "Alice B.", email: "alice.b@example.test" });
  },
});

Deno.test({
  name: "a session is only a provider's while its link is there",
  ...opts,
  fn: async () => {
    const guest = (await (await handler(post("/auth/guest", {}))).json()).user;
    assertEquals(await links.handleOf("google", alice.issuer, alice.sub, guest.id), null);
    const u = await signInAs({ ...alice, sub: "g-revoked" });
    assertEquals((await links.handleOf("google", alice.issuer, "g-revoked", u.id))?.handle, u.handle);
    // Regression: a way named only its provider, so a link of the provider
    // put in a removed one's place took the removed subject's sessions back.
    await sql`delete from mecha_auth.identity_link where sub = 'g-revoked'`;
    await sql`insert into mecha_auth.identity_link (provider, issuer, sub, user_id) values ('google', ${alice.issuer}, 'g-replacement', ${u.id})`;
    assertEquals(await links.handleOf("google", alice.issuer, "g-revoked", u.id), null);
  },
});

Deno.test({
  name: "legacy links require their original issuer before migration can admit sign-in",
  ...opts,
  fn: async () => {
    // The shape its auth service made, in public, with a row signed in through the broker.
    await sql`drop view public.identity_link`;
    await sql`drop table mecha_auth.identity_link`;
    await sql`create table identity_link (
      provider text not null, sub text not null,
      user_id uuid not null unique references app_user(id) on delete cascade,
      created_at timestamptz not null default now(), primary key (provider, sub))`;
    const guest = (await (await handler(post("/auth/guest", {}))).json()).user;
    await sql`insert into identity_link (provider, sub, user_id) values ('google', 'pairwise-1', ${guest.id})`;
    await assertRejects(() => migrate(), Error, "identity_link has unassigned issuers");
    await sql`alter table identity_link add column issuer text`;
    await sql`update identity_link set issuer = ${alice.issuer}`;
    await migrate();
    assertEquals((await signInAs({ ...alice, sub: "pairwise-1", name: null, picture: null, email: null })).id, guest.id);
    const replacement = await signInAs({ ...alice, issuer: "https://broker.test", sub: "pairwise-1" });
    assert(replacement.id !== guest.id);
    assertEquals(await links.handleOf("google", "https://broker.test", "pairwise-1", guest.id), null);
    assertEquals(await links.handleOf("google", alice.issuer, "pairwise-1", guest.id), { handle: guest.handle, name: null, email: null });
  },
});

// An app grants every table in public, BYPASSRLS roles included, and the CRUD
// API serves public: the links and passkeys decide who signs in as whom, so
// no app grant reaches them.
Deno.test({
  name: "no app grant reaches the links or the passkeys",
  ...opts,
  fn: async () => {
    const owner = await signInAs({ ...alice, sub: "g-closed" });
    const rollback = new Error("rolled back");
    const tried = await sql.begin(async (tx) => {
      await tx`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_probe') THEN CREATE ROLE service_probe NOLOGIN BYPASSRLS; END IF;
      END $$`;
      await tx`GRANT USAGE ON SCHEMA public TO app_user, service_probe`;
      await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, service_probe`;
      await tx`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, service_probe`;
      const seen: Record<string, string> = {};
      for (const role of ["app_user", "service_probe"]) {
        for (const query of ["select * from mecha_auth.identity_link", "select * from mecha_auth.webauthn_credential",
          `insert into mecha_auth.webauthn_credential (id, user_id, public_key) values ('stolen', '${owner.id}', '\\x00')`,
          "select * from identity_link", "select * from webauthn_credential"]) {
          await tx`SAVEPOINT probe`;
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          seen[`${role}: ${query}`] = await tx.unsafe(query).then(() => "answered", (e: Error) => e.message);
          await tx`ROLLBACK TO SAVEPOINT probe`;
        }
      }
      throw Object.assign(rollback, { seen });
    }).catch((e) => e === rollback ? (e as Error & { seen: Record<string, string> }).seen : Promise.reject(e));
    for (const [probe, outcome] of Object.entries(tried)) {
      if (probe.includes("mecha_auth.")) assertEquals(outcome, "permission denied for schema mecha_auth", probe);
      else assert(outcome.startsWith("permission denied for "), `${probe}: ${outcome}`);
    }
    const left = await sql`select c.relname, c.relkind, to_jsonb(c.reloptions) as reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('identity_link', 'webauthn_credential') order by 1`;
    assertEquals(left.map((r) => [r.relname, r.relkind, r.reloptions]), [
      ["identity_link", "v", ["security_invoker=true"]],
      ["webauthn_credential", "v", ["security_invoker=true"]],
    ]);
    assertEquals((await signInAs({ ...alice, sub: "g-closed", name: "Still Alice" })).id, owner.id);
  },
});

// A release before mecha_auth made both tables in public, where an app's
// grants reached them; they move with their rows and without those grants,
// and an earlier release still running reads and writes through the views
// left behind, while one starting again fails rather than making empty tables.
Deno.test({
  name: "tables an earlier release made in public move with their rows and none of public's grants",
  ...opts,
  fn: async () => {
    const owner = await signInAs({ ...alice, sub: "g-moved" });
    await sql`insert into mecha_auth.webauthn_credential (id, user_id, public_key) values ('moved', ${owner.id}, '\\x01')`;
    for (const table of ["webauthn_credential", "identity_link"]) {
      await sql.unsafe(`drop view public.${table}`);
      await sql.unsafe(`alter table mecha_auth.${table} set schema public`);
      await sql.unsafe(`grant select, insert, update, delete on public.${table} to app_user`);
    }
    await sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'column_probe') THEN CREATE ROLE column_probe NOLOGIN; END IF;
    END $$`;
    await sql`grant select (user_id) on public.webauthn_credential to column_probe`;
    await sql`grant usage on schema mecha_auth to app_user`;
    await migrate();
    const [schema] = await sql`select has_schema_privilege('app_user', 'mecha_auth', 'USAGE') as usable`;
    assertEquals(schema.usable, false);
    const [column] = await sql`select has_column_privilege('column_probe', 'mecha_auth.webauthn_credential', 'user_id', 'select') as granted`;
    assertEquals(column.granted, false);
    for (const table of ["webauthn_credential", "identity_link"]) {
      const [acl] = await sql`select has_table_privilege('app_user', ${"mecha_auth." + table}, 'select, insert, update, delete') as granted`;
      assertEquals(acl.granted, false, table);

    }
    assertEquals((await sql`select user_id from mecha_auth.webauthn_credential where id = 'moved'`)[0].user_id, owner.id);
    assertEquals((await signInAs({ ...alice, sub: "g-moved" })).id, owner.id);
    await sql`insert into webauthn_credential (id, user_id, public_key) values ('through-view', ${owner.id}, '\\x02')`;
    assertEquals((await sql`select count(*)::int as n from mecha_auth.webauthn_credential where id = 'through-view'`)[0].n, 1);
    await assertRejects(() => sql`ALTER TABLE identity_link ADD COLUMN IF NOT EXISTS issuer text`, Error, "cannot be performed on relation");
  },
});

Deno.test("a provider named without its client is refused at startup", async () => {
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--frozen", fileURLToPath(new URL("./main.ts", import.meta.url))],
    env: { OIDC_PROVIDERS: "google" },
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(!success);
  assertStringIncludes(new TextDecoder().decode(stderr), "OIDC_GOOGLE_CLIENT_ID is required");
});

Deno.test({
  name: "ANDROID_APK_KEY_HASHES normalizes bare and prefixed hashes, verifies Android ceremonies, and refuses bad hashes",
  ...opts,
  async fn() {
    const hashA = await sha256url("release-signing-cert-a");
    const hashB = await sha256url("debug-signing-cert-b");
    const hashUnlisted = await sha256url("attacker-signing-cert");
    assertEquals(
      androidOrigins(`${hashA}, android:apk-key-hash:${hashB}, ${hashA}=`),
      [`android:apk-key-hash:${hashA}`, `android:apk-key-hash:${hashB}`],
    );
    assertEquals(
      ceremonyOrigins("https://snapcards.fun", null, androidOrigins(hashA)),
      ["https://snapcards.fun", `android:apk-key-hash:${hashA}`],
    );
    for (const bad of ["not-a-sha256", "ab+cd/ef".padEnd(43, "a"), "a".repeat(42)]) {
      assertThrows(() => androidOrigins(bad), Error, "not a base64url SHA-256 hash", bad);
    }
    const { success, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--frozen", fileURLToPath(new URL("./main.ts", import.meta.url))],
      env: { WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGIN: "https://localhost:*", ANDROID_APK_KEY_HASHES: "bad-hash" },
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(!success);
    assertStringIncludes(new TextDecoder().decode(stderr), "ANDROID_APK_KEY_HASHES");

    const androidServe = createHandler({
      rpId: "localhost",
      origin: "https://localhost:54321",
      androidApkKeyHashes: `${hashA},android:apk-key-hash:${hashB}`,
    });
    const apkOrigin = `android:apk-key-hash:${hashA}`;
    const key = await passkey();

    const reg = await (await androidServe(post("/auth/register/start", {}))).json();
    // Unlisted APK signing key is refused.
    const badReg = await androidServe(
      post("/auth/register/verify", { state: reg.state, response: key.register(reg.challenge, `android:apk-key-hash:${hashUnlisted}`) }),
    );
    assertEquals(badReg.status, 401);

    const made = await androidServe(
      post("/auth/register/verify", { state: reg.state, response: key.register(reg.challenge, apkOrigin), refresh: true }),
    );
    assertEquals(made.status, 200, await made.clone().text());
    const registered = await made.json();
    assertEquals(typeof registered.refresh_token, "string");

    const login = await (await androidServe(post("/auth/login/start", {}))).json();
    const badLogin = await androidServe(
      post("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, `android:apk-key-hash:${hashUnlisted}`) }),
    );
    assertEquals(badLogin.status, 401);

    const signed = await androidServe(
      post("/auth/login/verify", { state: login.state, response: await key.login(login.challenge, apkOrigin), refresh: true }),
    );
    assertEquals(signed.status, 200, await signed.clone().text());
    const loggedIn = await signed.json();
    assertEquals(loggedIn.user, registered.user);
    assertEquals(typeof loggedIn.refresh_token, "string");
  },
});

Deno.test({
  name: "POST /auth/refresh rotates refresh tokens across guest and account sessions and revokes the family on replay",
  ...opts,
  async fn() {
    assertEquals((await handler(post("/auth/refresh", {}))).status, 400);
    assertEquals((await handler(post("/auth/refresh", { refresh_token: "unknown-token" }))).status, 401);

    // Guest session mints an opaque refresh_token stored hashed in mecha_auth.auth_refresh_token.
    // A browser renews by its cookie and is given no refresh token; a native host asks.
    assertEquals((await (await handler(post("/auth/guest", {}))).json()).refresh_token, undefined);
    const guest1 = await (await handler(post("/auth/guest", { refresh: true }))).json();
    assertEquals(typeof guest1.refresh_token, "string");
    const hash1 = await sha256url(guest1.refresh_token);
    const [stored1] = await sql`select family_id, expires_at, replaced_by, revoked_at
      from mecha_auth.auth_refresh_token where token_hash = ${hash1}`;
    assert(stored1 !== undefined);
    assertEquals(stored1.replaced_by, null);
    assertEquals(stored1.revoked_at, null);
    const ttlSeconds = Math.round((new Date(stored1.expires_at as Date).getTime() - Date.now()) / 1000);
    assert(Math.abs(ttlSeconds - REFRESH_TOKEN_TTL_S) < 120, `expected ~90d TTL, got ${ttlSeconds}s`);

    // Rotating a guest refresh token keeps the user and how it signed in: a
    // renewal is no new sign-in.
    const rot1Res = await handler(post("/auth/refresh", { refresh_token: guest1.refresh_token }));
    assertEquals(rot1Res.status, 200);
    const rot1 = await rot1Res.json();
    assertEquals(rot1.user, guest1.user);
    const [first, renewed] = [await verifyJwt(guest1.token), await verifyJwt(rot1.token)];
    assertEquals(renewed?.acr, "0");
    assertEquals(renewed?.auth_time, first?.auth_time);
    assert(rot1.refresh_token !== guest1.refresh_token);

    // Rotating a second time advances the chain inside the same family.
    const rot2Res = await handler(post("/auth/refresh", { refresh_token: rot1.refresh_token }));
    assertEquals(rot2Res.status, 200);
    const rot2 = await rot2Res.json();
    assertEquals(rot2.user, guest1.user);

    // Replaying the already-rotated first token revokes the entire family, including rot2.refresh_token.
    const replay = await handler(post("/auth/refresh", { refresh_token: guest1.refresh_token }));
    assertEquals(replay.status, 401);
    const descendant = await handler(post("/auth/refresh", { refresh_token: rot2.refresh_token }));
    assertEquals(descendant.status, 401);
    const family = await sql`select count(*)::int as total, count(revoked_at)::int as revoked
      from mecha_auth.auth_refresh_token where family_id = ${stored1.family_id}`;
    assertEquals(family[0].total, 3);
    assertEquals(family[0].revoked, 3);

    // Expired refresh token is refused.
    const guest2 = await (await handler(post("/auth/guest", { refresh: true }))).json();
    await sql`update mecha_auth.auth_refresh_token set expires_at = now() - interval '1 second'
      where token_hash = ${await sha256url(guest2.refresh_token)}`;
    assertEquals((await handler(post("/auth/refresh", { refresh_token: guest2.refresh_token }))).status, 401);
  },
});

Deno.test({
  name: "native OIDC PKCE ticket flow, guest-to-OIDC promotion, a second guest held and never merged, and DELETE /auth/account",
  ...opts,
  async fn() {
    await sql`CREATE TABLE IF NOT EXISTS owned_deck (
      id uuid primary key default gen_random_uuid(),
      owner uuid not null references app_user(id) on delete cascade,
      title text not null,
      scope_id text generated always as ('public:') stored not null
    )`;
    await sql`CREATE TABLE IF NOT EXISTS owned_fav (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references app_user(id) on delete cascade,
      slug text not null,
      scope_id text generated always as ('user:' || user_id) stored not null,
      unique (user_id, slug)
    )`;
    await sql`CALL rls_protect('owned_deck')`;
    await sql`CALL rls_protect('owned_fav')`;

    const issuer = "https://accounts.google.com";
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
    const codes = new Map<string, { client: string; redirect: string; challenge: string; nonce: string }>();
    let currentSub = "oidc-native-1";
    let currentName = "Native Alice";
    let currentEmail = "native.alice@example.test";

    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(String(init?.body));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!grant || (await sha256url(form.get("code_verifier") ?? "")) !== grant.challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s));
        const head = b64(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" }));
        const payload = b64(JSON.stringify({
          iss: issuer,
          aud: grant.client,
          sub: currentSub,
          name: currentName,
          email: currentEmail,
          email_verified: true,
          nonce: grant.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        }));
        const sig = new Uint8Array(
          await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(`${head}.${payload}`)),
        );
        return Response.json({ id_token: `${head}.${payload}.${encodeBase64Url(sig)}` });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const providers = providersFrom((k) => ({ OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "origin" }[k]));
    const serve = createHandler({
      rpId: "localhost",
      origin: "https://localhost:54321",
      nativeSchemes: "snapcards",
      providers,
      fetcher,
    });

    const nativeSignIn = async (queryExtra = "", headers: Record<string, string> = {}) => {
      const verifier = randomToken(32);
      const challenge = await sha256url(verifier);
      const startRes = await serve(
        new Request(`https://localhost:54321/auth/oidc/google/start?return=native&code_challenge=${challenge}${queryExtra}`, { headers }),
      );
      assertEquals(startRes.status, 303);
      assertEquals(startRes.headers.getSetCookie(), []);
      const authUrl = new URL(startRes.headers.get("location")!);
      const code = crypto.randomUUID();
      codes.set(code, {
        client: authUrl.searchParams.get("client_id")!,
        redirect: authUrl.searchParams.get("redirect_uri")!,
        challenge: authUrl.searchParams.get("code_challenge")!,
        nonce: authUrl.searchParams.get("nonce")!,
      });
      const cbRes = await serve(
        new Request(`https://localhost:54321/auth/oidc/google/callback?code=${code}&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`),
      );
      assertEquals(cbRes.status, 303);
      assertEquals(cbRes.headers.getSetCookie(), []);
      const loc = new URL(cbRes.headers.get("location")!);
      assertEquals(`${loc.protocol}//${loc.host}${loc.pathname}`, "snapcards://auth/callback");
      return { ticket: loc.searchParams.get("ticket")!, verifier };
    };

    // 1. Guest promotes onto an unlinked OIDC identity: keeps guest UUID and all owned rows, and takes
    //    the provider's name, as a browser's guest does.
    const guestA = await (await serve(post("/auth/guest", {}))).json();
    await sql`insert into owned_deck (owner, title) values (${guestA.user.id}, 'Birds of Brazil')`;
    await sql`insert into owned_fav (user_id, slug) values (${guestA.user.id}, 'deck-shared'), (${guestA.user.id}, 'deck-a')`;

    const flow1 = await nativeSignIn(`&promote_token=${encodeURIComponent(guestA.token)}`);
    const redeemed1 = await serve(
      new Request("https://localhost:54321/auth/oidc/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: flow1.ticket, code_verifier: flow1.verifier }),
      }),
    );
    assertEquals(redeemed1.status, 200);
    const sessionA = await redeemed1.json();
    assertEquals(sessionA.user, {
      id: guestA.user.id,
      handle: nameHandle("Native Alice", guestA.user.id),
      name: "Native Alice",
      email: "native.alice@example.test",
    });
    assert((await verifyJwt(sessionA.token))?.acr !== "0", "a promoted guest's session is no guest's");
    assertEquals(typeof sessionA.refresh_token, "string");
    // Ticket row was atomically deleted on consumption; replay fails.
    assertEquals((await sql`select count(*)::int as n from mecha_auth.auth_native_ticket where id = ${flow1.ticket}`)[0].n, 0);
    const replayRes = await serve(
      new Request("https://localhost:54321/auth/oidc/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: flow1.ticket, code_verifier: flow1.verifier }),
      }),
    );
    assertEquals(replayRes.status, 401);

    // Refreshing an OIDC-promoted account preserves non-guest claims and profile fields.
    const refreshedA = await (await serve(post("/auth/refresh", { refresh_token: sessionA.refresh_token }))).json();
    assertEquals(refreshedA.user, sessionA.user);
    assert((await verifyJwt(refreshedA.token))?.acr !== "0", "its renewal neither");
    assertEquals((await verifyJwt(refreshedA.token))?.email, "native.alice@example.test");

    // guestA's token outlived its promotion: it is no way into the account it became, so it
    // deletes nothing.
    const staleDelete = await serve(new Request("https://localhost:54321/auth/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${guestA.token}` },
    }));
    assertEquals(staleDelete.status, 409);
    assertEquals((await sql`select count(*)::int as n from app_user where id = ${guestA.user.id}`)[0].n, 1);

    // 2. A second guest signing in to the subject guestA's account holds is login_required, as in a browser:
    //    nothing moves between them, and switching is the ticket the refusal hands back.
    const guestB = await (await serve(post("/auth/guest", {}))).json();
    await sql`insert into owned_deck (owner, title) values (${guestB.user.id}, 'Offline Trees')`;
    await sql`insert into owned_fav (user_id, slug) values (${guestB.user.id}, 'deck-shared'), (${guestB.user.id}, 'deck-b')`;

    const flow2 = await nativeSignIn("", { authorization: `Bearer ${guestB.token}` });
    const redeem = (ticket: string, verifier: string) =>
      serve(new Request("https://localhost:54321/auth/oidc/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, code_verifier: verifier }),
      }));
    const heldRes = await redeem(flow2.ticket, flow2.verifier);
    assertEquals(heldRes.status, 409);
    const held = await heldRes.json();
    assertEquals(held.error, "login_required");
    assertEquals(held.user.handle, sessionA.user.handle);
    const titles = async (owner: string) => (await sql`select title from owned_deck where owner = ${owner} order by 1`).map((d) => d.title);
    assertEquals(await titles(guestA.user.id), ["Birds of Brazil"]);
    assertEquals(await titles(guestB.user.id), ["Offline Trees"]);
    const favs = await sql`select slug from owned_fav where user_id = ${guestA.user.id} order by 1`;
    assertEquals(favs.map((f) => f.slug), ["deck-a", "deck-shared"]);
    const switched = await (await redeem(held.ticket, flow2.verifier)).json();
    assertEquals(switched.user.id, guestA.user.id);
    assertEquals((await sql`select count(*)::int as n from app_user where id = ${guestB.user.id}`)[0].n, 1);

    // 3. Wrong code_verifier and expired ticket in Postgres are both refused with 401.
    currentSub = "oidc-native-2";
    currentName = "Bob";
    currentEmail = "bob@example.test";
    const flowWrong = await nativeSignIn();
    const wrongRes = await serve(
      new Request("https://localhost:54321/auth/oidc/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: flowWrong.ticket, code_verifier: randomToken(32) }),
      }),
    );
    assertEquals(wrongRes.status, 401);
    assertEquals((await sql`select count(*)::int as n from mecha_auth.auth_native_ticket where id = ${flowWrong.ticket}`)[0].n, 0);

    const flowExpired = await nativeSignIn();
    await sql`update mecha_auth.auth_native_ticket set expires_at = now() - interval '1 second' where id = ${flowExpired.ticket}`;
    const expiredRes = await serve(
      new Request("https://localhost:54321/auth/oidc/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: flowExpired.ticket, code_verifier: flowExpired.verifier }),
      }),
    );
    assertEquals(expiredRes.status, 401);

    // 4. DELETE /auth/account requires an app_user bearer token and cascades credentials, links, refresh tokens, and owned rows.
    assertEquals((await serve(new Request("https://localhost:54321/auth/account", { method: "DELETE" }))).status, 401);
    const shapeOnly = await signJwt({ typ: "shape", table: "article", where: PUBLIC_WHERE, sub: guestA.user.id, exp: Math.floor(Date.now() / 1000) + 60 });
    assertEquals(
      (await serve(new Request("https://localhost:54321/auth/account", {
        method: "DELETE",
        headers: { authorization: `Bearer ${shapeOnly}` },
      }))).status,
      401,
    );

    const delRes = await serve(
      new Request("https://localhost:54321/auth/account", {
        method: "DELETE",
        headers: { authorization: `Bearer ${refreshedA.token}` },
      }),
    );
    assertEquals(delRes.status, 200);
    assertEquals(await delRes.json(), { deleted: true });
    assertEquals((await sql`select count(*)::int as n from app_user where id = ${guestA.user.id}`)[0].n, 0);
    assertEquals((await sql`select count(*)::int as n from mecha_auth.identity_link where user_id = ${guestA.user.id}`)[0].n, 0);
    assertEquals((await sql`select count(*)::int as n from mecha_auth.auth_refresh_token where user_id = ${guestA.user.id}`)[0].n, 0);
    assertEquals((await sql`select count(*)::int as n from owned_deck where owner = ${guestA.user.id}`)[0].n, 0);
    assertEquals((await sql`select count(*)::int as n from owned_fav where user_id = ${guestA.user.id}`)[0].n, 0);
    assertEquals((await serve(post("/auth/refresh", { refresh_token: refreshedA.refresh_token }))).status, 401);

    // New auth tables are sealed in mecha_auth and exempt in rls_exempt; nothing merges a guest.
    for (const rel of ["mecha_auth.auth_native_ticket", "mecha_auth.auth_refresh_token"]) {
      const [acl] = await sql`select has_table_privilege('app_user', ${rel}, 'select, insert, update, delete') as granted,
        exists (select 1 from mecha.rls_exempt where table_name = ${rel}) as exempt`;
      assertEquals(acl.granted, false, rel);
      assertEquals(acl.exempt, true, rel);
    }
    const [merge] = await sql`select to_regprocedure('mecha_auth.adopt_guest(uuid, uuid)') is null as gone`;
    assertEquals(merge.gone, true);

    await sql`DROP TABLE owned_fav, owned_deck`;
  },
});

Deno.test({
  name: "guest adoption ignores legacy and invalid cookies but preserves a valid device session",
  ...opts,
  async fn() {
    const origin = `https://${door}`;
    const minted = await handler(atDoor("/auth/guest", { cookie: false }, door, undefined, undefined, origin));
    const { token } = await minted.json();
    const own = cookies(await handler(atDoor("/auth/guest", {}, door, undefined, undefined, origin)));
    for (const planted of [{ mecha_session: own[SESSION_COOKIE] }, { [SESSION_COOKIE]: "invalid" }] as Record<string, string>[]) {
      const adopted = await handler(atDoor("/auth/session/adopt", {}, door, token, planted, origin));
      assertEquals(adopted.status, 200);
      assert(cookies(adopted)[SESSION_COOKIE]);
      await adopted.body?.cancel();
    }
    const refused = await handler(atDoor("/auth/session/adopt", {}, door, token, own, origin));
    assertEquals(refused.status, 409);
    await refused.body?.cancel();
  },
});

// Last, and it has to be: Deno runs tests in source order, and this closes the
// pool every test above it queries through.
Deno.test({
  name: "a page elsewhere may mint a guest for its own token, never this browser's session",
  ...opts,
  async fn() {
    const foreign = await handler(atDoor("/auth/guest", {}, door, undefined, undefined, "https://evil.test"));
    assertEquals(foreign.status, 200);
    assertEquals(typeof (await foreign.json()).token, "string");
    assertEquals(foreign.headers.getSetCookie(), []);
    const own = await handler(atDoor("/auth/guest", {}, door, undefined, undefined, `https://${door}`));
    assert(cookies(own)[SESSION_COOKIE], "the door's own page is given the device's session");
    // Minted ahead of the reader, it waits to be adopted: a sign-in finished meanwhile keeps the device.
    const ahead = await handler(atDoor("/auth/guest", { cookie: false }, door, undefined, undefined, `https://${door}`));
    assertEquals(ahead.headers.getSetCookie(), []);
    const kept = await ahead.json();
    const adopted = await handler(atDoor("/auth/session/adopt", {}, door, kept.token, undefined, `https://${door}`));
    assertEquals([adopted.status, Boolean(cookies(adopted)[SESSION_COOKIE])], [200, true]);
    assertEquals((await handler(atDoor("/auth/session/adopt", {}, door, kept.token, cookies(adopted), `https://${door}`))).status, 409);
    const inStack = await (await handler(atDoor("/auth/guest", { cookie: false }, "caddy:8443", undefined, undefined, "https://caddy:8443"))).json();
    const there = await handler(atDoor("/auth/session/adopt", {}, "caddy:8443", inStack.token, undefined, "https://caddy:8443"));
    assertEquals([there.status, Boolean(cookies(there)[SESSION_COOKIE])], [200, true]);
    assertEquals((await handler(atDoor("/auth/session/adopt", {}, "caddy:8443", inStack.token, undefined, "https://evil.test"))).status, 403);
  },
});

Deno.test({
  name: "a registration's answer makes one account, once, even after that account is deleted",
  ...opts,
  async fn() {
    const key = await passkey();
    const start = await (await handler(atDoor("/auth/register/start", {}, door))).json();
    const answer = { state: start.state, response: key.register(start.challenge, `https://${door}`) };
    const made = await (await handler(atDoor("/auth/register/verify", answer, door))).json();
    const gone = await handler(new Request("http://auth:9999/auth/account", { method: "DELETE", headers: { authorization: `Bearer ${made.token}` } }));
    assertEquals(gone.status, 200);
    assertEquals((await handler(atDoor("/auth/register/verify", answer, door))).status, 401);
    assertEquals((await sql`select count(*)::int as n from app_user where id = ${made.user.id}`)[0].n, 0);
  },
});

Deno.test({
  name: "a native host's refresh family renews only while the passkey it signed in with is the account's",
  ...opts,
  async fn() {
    const key = await passkey();
    const start = await (await handler(atDoor("/auth/register/start", {}, door))).json();
    const made = await (await handler(
      atDoor("/auth/register/verify", { state: start.state, response: key.register(start.challenge, `https://${door}`), refresh: true }, door),
    )).json();
    const renewed = await (await handler(post("/auth/refresh", { refresh_token: made.refresh_token }))).json();
    assertEquals(renewed.user.id, made.user.id);
    await sql`delete from mecha_auth.webauthn_credential where user_id = ${made.user.id}`;
    assertEquals((await handler(post("/auth/refresh", { refresh_token: renewed.refresh_token }))).status, 401);
  },
});

Deno.test({
  name: "a counter that climbed is not reset by a zero: 0 follows only 0",
  ...opts,
  async fn() {
    const owner = await enroll(await passkey());
    const answer = async (counter: number) => {
      const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
      return await handler(atDoor("/auth/login/verify", { state: login.state, response: await owner.key.login(login.challenge, `https://${door}`, { counter }) }, door));
    };
    assertEquals((await answer(5)).status, 200);
    assertEquals((await answer(0)).status, 401);
    assertEquals((await answer(6)).status, 200);
  },
});

Deno.test({
  name: "a guest a tab kept from before sessions said how they were signed in becomes this device's session, once",
  ...opts,
  async fn() {
    const id = crypto.randomUUID();
    await sql`insert into app_user (id, handle) values (${id}, ${`fig-ibis-${id.slice(-4)}`})`;
    const legacy = await signJwt({ iss: "mecha:stack", role: "app_user", sub: id, handle: `fig-ibis-${id.slice(-4)}`, guest: true, exp: Math.floor(Date.now() / 1000) + 600 });
    const up = await handler(atDoor("/auth/session/adopt", {}, door, legacy));
    assertEquals(up.status, 200, await up.clone().text());
    const body = await up.json();
    assertEquals([body.user.id, body.user.guest, (await verifyJwt(body.token))?.acr], [id, true, "0"]);
    const jar = cookies(up);
    assert(jar[SESSION_COOKIE]);
    // Once: a browser holding a session takes up no earlier guest over it.
    assertEquals((await handler(atDoor("/auth/session/adopt", {}, door, legacy, jar))).status, 409);
    // And only a guest's: an account's session is no such token.
    const key = await passkey();
    const person = (await enroll(key)).made;
    assertEquals((await handler(atDoor("/auth/session/adopt", {}, door, person.token))).status, 400);
  },
});


Deno.test({
  name: "a connection runs no query of its own, so a statement timeout can only fail a request, not end the process",
  ...opts,
  fn: () => {
    // Regression: the array-type fetch postgres.js runs on connect timed out
    // under load, its rejection unhandled, and the auth service exited.
    assertEquals(sql.options.fetch_types, false);
  },
});

/** A new account at the door, signed in by a passkey, with the cookies the
 * browser keeps. */
async function account() {
  const key = await passkey();
  const start = await (await handler(atDoor("/auth/register/start", {}, door))).json();
  const res = await handler(atDoor("/auth/register/verify", { state: start.state, response: key.register(start.challenge, `https://${door}`) }, door));
  assertEquals(res.status, 200, await res.clone().text());
  return { user: (await res.json()).user as { id: string; handle: string }, jar: cookies(res), key };
}
const ways = async (jar: Record<string, string>) => await (await handler(atDoor("/auth/ways", {}, door, undefined, jar, `https://${door}`))).json();
const atWays = (path: string, body: unknown, jar: Record<string, string>) => handler(atDoor(`/auth/ways${path}`, body, door, undefined, jar, `https://${door}`));
/** Another passkey added to the account this jar is signed in to. */
async function addPasskey(jar: Record<string, string>) {
  const key = await passkey();
  const start = await (await atWays("/passkey", {}, jar)).json();
  const res = await atWays("/passkey/verify", { state: start.state, response: key.register(start.challenge, `https://${door}`) }, jar);
  return { key, start, res };
}

Deno.test({
  name: "an account's ways in: one added on a recent sign-in, and one removed while another stays, never the way this device came in by",
  ...opts,
  async fn() {
    const a = await account();
    const first = await ways(a.jar);
    assertEquals(first.ways.map((w: { kind: string; id: string; current: boolean }) => [w.kind, w.id, w.current]), [["passkey", a.key.id, true]]);
    assertEquals([first.recent, first.recovery], [true, false]);
    const second = await addPasskey(a.jar);
    assertEquals(second.res.status, 200, await second.res.clone().text());
    // An authenticator already holding one of the account's passkeys makes no second.
    assertEquals(second.start.excludeCredentials.map((c: { id: string }) => c.id), [a.key.id]);
    assertEquals((await signIn(second.key)).user.id, a.user.id);
    assertEquals((await ways(a.jar)).ways.length, 2);
    const current = await atWays("/remove", { kind: "passkey", id: a.key.id }, a.jar);
    assertEquals([current.status, await current.json()], [409, { error: "the way this device signed in by" }]);
    const removed = await atWays("/remove", { kind: "passkey", id: second.key.id }, a.jar);
    assertEquals(removed.status, 200);
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const gone = await handler(atDoor("/auth/login/verify", { state: login.state, response: await second.key.login(login.challenge, `https://${door}`, { counter: 2 }) }, door));
    assertEquals([gone.status, (await gone.json()).unknownCredential], [401, true]);
    // Another account's way is none of this one's.
    const b = await account();
    assertEquals((await atWays("/remove", { kind: "passkey", id: b.key.id }, a.jar)).status, 404);
  },
});

Deno.test({
  name: "the ways change only on this device's own session, signed in within ten minutes: never a guest's, a bearer's, or another origin's",
  ...opts,
  async fn() {
    const a = await account();
    const now = Math.floor(Date.now() / 1000);
    const session = (since: number | undefined) =>
      signJwt({ purpose: "device-session", sub: a.user.id, way: { kind: "passkey", credential: a.key.id }, ...(since === undefined ? {} : { since }), exp: now + 3600 });
    for (const stale of [await session(now - 601), await session(undefined)]) {
      const jar = { [SESSION_COOKIE]: stale };
      assertEquals((await ways(jar)).recent, false);
      const refused = await atWays("/passkey", {}, jar);
      assertEquals([refused.status, await refused.json()], [401, { error: "insufficient_user_authentication", max_age: 600 }]);
      assertEquals((await atWays("/remove", { kind: "passkey", id: a.key.id }, jar)).status, 401);
    }
    const token = (await signIn(a.key)).token;
    assertEquals((await handler(atDoor("/auth/ways/passkey", {}, door, token))).status, 401);
    assertEquals((await handler(atDoor("/auth/ways/passkey", {}, door, undefined, a.jar, "https://elsewhere.test"))).status, 403);
    const guest = await handler(atDoor("/auth/guest", {}, door));
    assertEquals((await atWays("", {}, cookies(guest))).status, 403);
  },
});

Deno.test({
  name: "a provider's subject added to an account signs in to it, and one another account holds stays that account's",
  ...opts,
  async fn() {
    const a = await account();
    const b = await account();
    const carol: Profile = { ...alice, sub: `g-carol-${crypto.randomUUID()}`, name: "Carol", email: "carol@example.test" };
    const byA = { way: { kind: "passkey" as const, credential: a.key.id }, since: Math.floor(Date.now() / 1000) };
    assertEquals(await links.addTo(carol, a.user.id, byA), "added");
    assertEquals(await links.addTo(carol, a.user.id, byA), "added");
    assertEquals(await links.addTo(carol, b.user.id, { way: { kind: "passkey", credential: b.key.id }, since: Math.floor(Date.now() / 1000) }), "taken");
    // Regression: a session's way names its provider, not the subject, so a
    // second subject of one provider would outlive the first's removal.
    assertEquals(await links.addTo({ ...carol, sub: `g-dave-${crypto.randomUUID()}` }, a.user.id, byA), "held");
    assertEquals((await signInAs(carol)).id, a.user.id);
    const listed = (await ways(a.jar)).ways;
    assertEquals(listed.map((w: { kind: string; current: boolean }) => [w.kind, w.current]), [["passkey", true], ["provider", false]]);
    assertEquals([listed[1].provider, listed[1].email], ["google", "carol@example.test"]);
    const removed = await atWays("/remove", { kind: "provider", provider: "google", issuer: carol.issuer, sub: carol.sub }, a.jar);
    assertEquals(removed.status, 200);
    assert((await signInAs(carol)).id !== a.user.id, "a link removed is no way into the account");
  },
});

Deno.test({
  name: "set up recovery is asked of an account with one way in that had an external effect before this sign-in, until Not now or a second way",
  ...opts,
  async fn() {
    // The airlock's ledger as airlock.sql makes it, which the service stamps
    // when it finds it at start.
    await sql`CREATE SCHEMA IF NOT EXISTS airlock`;
    await sql`CREATE TABLE IF NOT EXISTS airlock.external_effect_ledger (key text primary key, effect text not null, row jsonb not null, input jsonb not null)`;
    await migrate();
    const effect = (claims: Record<string, unknown>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`insert into airlock.external_effect_ledger values (${crypto.randomUUID()}, 'charge', '{}', '{}')`;
      });
    const a = await account();
    await effect({ role: "app_user", sub: a.user.id });
    // The service's own moves stamp no one.
    await effect({ role: "service", sub: a.user.id });
    assertEquals((await ways(a.jar)).recovery, false, "the effect is this sign-in's");
    await new Promise((r) => setTimeout(r, 1100));
    const again = await handler(atDoor("/auth/login/start", {}, door));
    const login = await again.json();
    const res = await handler(atDoor("/auth/login/verify", { state: login.state, response: await a.key.login(login.challenge, `https://${door}`, { counter: 2 }) }, door));
    const jar = cookies(res);
    assertEquals((await ways(jar)).recovery, true);
    const b = await account();
    await effect({ role: "service", sub: b.user.id });
    await new Promise((r) => setTimeout(r, 1100));
    assertEquals((await ways(b.jar)).recovery, false);
    assertEquals((await atWays("/later", {}, jar)).status, 200);
    assertEquals((await ways(jar)).recovery, false);
    const [later] = await sql`select declines, ask_after - now() > interval '23 hours' as day from mecha_auth.account_recovery where user_id = ${a.user.id}`;
    assertEquals([later.declines, later.day], [1, true]);
    await sql`update mecha_auth.account_recovery set ask_after = now() where user_id = ${a.user.id}`;
    assertEquals((await ways(jar)).recovery, true);
    assertEquals((await addPasskey(jar)).res.status, 200);
    assertEquals((await ways(jar)).recovery, false);
  },
});

Deno.test({
  name: "a change to the ways is made only while the way that authorized it stands",
  ...opts,
  async fn() {
    const a = await account();
    const second = await addPasskey(a.jar);
    assertEquals(second.res.status, 200);
    // Signed in by the second passkey, which the first then removes.
    const login = await (await handler(atDoor("/auth/login/start", {}, door))).json();
    const bySecond = cookies(await handler(atDoor("/auth/login/verify", { state: login.state, response: await second.key.login(login.challenge, `https://${door}`, { counter: 2 }) }, door)));
    const start = await (await atWays("/passkey", {}, bySecond)).json();
    assertEquals((await atWays("/remove", { kind: "passkey", id: second.key.id }, a.jar)).status, 200);
    const third = await passkey();
    const late = await atWays("/passkey/verify", { state: start.state, response: third.register(start.challenge, `https://${door}`) }, bySecond);
    assertEquals(late.status, 401);
    assertEquals(await links.addTo({ ...alice, sub: `g-late-${crypto.randomUUID()}` }, a.user.id, { way: { kind: "passkey", credential: second.key.id }, since: Math.floor(Date.now() / 1000) }), "revoked");
    assertEquals((await ways(a.jar)).ways.length, 1);
    // A change that waited past its sign-in's ten minutes is made by no one.
    assertEquals(await links.addTo({ ...alice, sub: `g-stale-${crypto.randomUUID()}` }, a.user.id, { way: { kind: "passkey", credential: a.key.id }, since: Math.floor(Date.now() / 1000) - 601 }), "revoked");
  },
});

Deno.test({
  name: "an effect whose subject names no account stamps none and is still claimed, and Not now's wait stops growing",
  ...opts,
  async fn() {
    await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "app_user", sub: "not-a-uuid" })}, true)`;
      await tx`insert into airlock.external_effect_ledger values (${crypto.randomUUID()}, 'charge', '{}', '{}')`;
    });
    const a = await account();
    await sql`insert into mecha_auth.account_recovery (user_id, effected_at, declines) values (${a.user.id}, now(), 40)`;
    assertEquals((await atWays("/later", {}, a.jar)).status, 200);
    const [r] = await sql`select ask_after - now() < interval '65 days' as capped from mecha_auth.account_recovery where user_id = ${a.user.id}`;
    assertEquals(r.capped, true);
  },
});

Deno.test({
  name: "teardown",
  ...opts,
  fn: async () => {
    await sql.end();
  },
});
