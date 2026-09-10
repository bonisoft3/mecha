// Requires DATABASE_URL pointing at a throwaway postgres. app_user is owned
// elsewhere (see main.ts); tests create a minimal stand-in before running
// the service's own migration against it.
import {
  assert,
  assertEquals,
} from "jsr:@std/assert@1.0.13";
import { handler, issueUserToken, migrate, sql, verifyJwt } from "./main.ts";

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
await sql`CREATE OR REPLACE FUNCTION auth_uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$`;
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

function post(path: string, body: unknown): Request {
  return new Request(`http://auth:9999${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  name: "columns, replica, params and the secret stay server-owned",
  ...opts,
  async fn() {
    const { res } = await mint("article");
    const { token, where } = await res.json();
    const w = encodeURIComponent(where);
    for (const extra of ["columns=id,body", "replica=full", "params[1]=x", "secret=guessed"]) {
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
    for (const extra of ["subset__where=true", "table[]=app_user", "schema=other"]) {
      const uri = `/v1/shape?table=article&where=${w}&${extra}`;
      assertEquals((await handler(shapeReq(token, uri))).status, 403, extra);
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

// Last, and it has to be: Deno runs tests in source order, and this closes the
// pool every test above it queries through.
Deno.test({
  name: "teardown",
  ...opts,
  fn: async () => {
    await sql.end();
  },
});
