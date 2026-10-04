// Requires DATABASE_URL pointing at a throwaway postgres, and the rest of the
// environment main.ts reads as the dev cluster sets it (cluster.cue). app_user is owned elsewhere (see main.ts); tests
// create a minimal stand-in before running the service's own migration
// against it.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { isoBase64URL, isoCBOR, isoUint8Array, toHash } from "@simplewebauthn/server/helpers";
import { admittedOrigin, ceremonyOrigin, handler, issueUserToken, migrate, signJwt, sql, verifyJwt } from "./main.ts";

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
  doc_id uuid not null references gk_doc(id)
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
await sql`delete from webauthn_credential`;
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
    assert(/^[a-z]+-[a-z]+-\d\d$/.test(body.user.name), `generated handle, got ${body.user.name}`);
    assertEquals(body.authenticatorSelection.residentKey, "required");
    assert(Array.isArray(body.pubKeyCredParams) && body.pubKeyCredParams.length > 0);
    const st = await verifyJwt(body.state);
    assert(st !== null);
    assertEquals(st.purpose, "register");
    assertEquals(st.handle, body.user.name);
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
    assertEquals([(await verifyJwt(guest.token))?.guest, guest.user.guest], [true, true]);
    // Stated either way: a policy that admits only `guest = false` refuses a
    // token minted before the claim existed rather than taking it for an account.
    assertEquals((await verifyJwt(await issueUserToken(guest.user.id, guest.user.handle)))?.guest, false);
  },
});

Deno.test({
  name: "register/start refuses to add a passkey to an account's session",
  ...opts,
  async fn() {
    const guest = await (await handler(post("/auth/guest", {}))).json();
    const account = await issueUserToken(guest.user.id, guest.user.handle);
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
    assertEquals((await res.json()).error, "authentication verification failed");
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
    const token = await issueUserToken(id, "alice");
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
  },
});

Deno.test({
  name: "guest mints a fresh app_user per call with a valid token",
  ...opts,
  fn: async () => {
    const res = await handler(post("/auth/guest", {}));
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(/^[a-z]+-[a-z]+-\d\d$/.test(body.user.handle), `generated handle, got ${body.user.handle}`);
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
  const userToken = await issueUserToken(user[0].id, user[0].handle);
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
    const { res, uid } = await mint("article");
    assertEquals(res.status, 200);
    const body = await res.json();
    // The same derivation the CRUD path reads, so the two cannot disagree.
    assertEquals(body.where, `scope_id IN ('public:','user:${uid}')`);
    const claims = await verifyJwt(body.token);
    assertEquals(claims!.table, "article");
    assertEquals(claims!.where, body.where);
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
  name: "a user token is not a shape token, and vice versa",
  ...opts,
  async fn() {
    const { res, userToken } = await mint("article");
    const { token, where } = await res.json();
    const uri = `/v1/shape?table=article&where=${encodeURIComponent(where)}`;
    // The session token says nothing about a shape.
    assertEquals((await handler(shapeReq(userToken, uri))).status, 401);
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
    async login(challenge: string, origin: string) {
      const authData = isoUint8Array.concat([rpIdHash, new Uint8Array([0x01, 0, 0, 0, 1])]);
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

function atDoor(path: string, body: unknown, host: string): Request {
  return new Request(`http://auth:9999${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "a passkey made at the dev door registers and signs in, whatever port the host gave the door",
  ...opts,
  async fn() {
    // The door publishes on an ephemeral port while the expected origin named
    // 8443, so every ceremony on a cluster launched without the port pinned
    // failed its origin check.
    const door = "localhost:54321";
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
    args: ["run", "-A", "--frozen", new URL("./main.ts", import.meta.url).pathname],
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
    args: ["run", "-A", "--frozen", new URL("./main.ts", import.meta.url).pathname],
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
    args: ["run", "-A", "--frozen", new URL("./main.ts", import.meta.url).pathname],
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

// Last, and it has to be: Deno runs tests in source order, and this closes the
// pool every test above it queries through.
Deno.test({
  name: "teardown",
  ...opts,
  fn: async () => {
    await sql.end();
  },
});
