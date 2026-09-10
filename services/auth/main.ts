// Auth service: WebAuthn passkey ceremonies plus a guest mint. The token
// contract three components share is README.md; endpoints are mounted WITH
// the /auth prefix (Caddy strips nothing). Stateless: the
// WebAuthn challenge travels in a short-lived HS256 `state` JWT instead of
// server-side sessions. app_user is a program entity created by the database
// migrations; this service only self-migrates webauthn_credential.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import postgres from "postgres";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
const JWT_SECRET = Deno.env.get("PGRST_JWT_SECRET") ??
  "pronto-dev-secret-please-override-32ch";
const RP_ID = Deno.env.get("WEBAUTHN_RP_ID") ?? "localhost";
const ORIGIN = Deno.env.get("WEBAUTHN_ORIGIN") ?? "http://localhost:8080";

const USER_TOKEN_TTL_S = 7 * 24 * 3600;
// A shape token outlives one long-poll cycle and little else: Electric holds a
// request open for 300s, so a token shorter than that expires mid-stream, and a
// long one is a scope set that cannot be revoked.
const SHAPE_TOKEN_TTL_S = 900;
const STATE_TTL_S = 300;

export const sql = postgres(DATABASE_URL);

export async function migrate(): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS webauthn_credential (
    id text primary key,
    user_id uuid not null references app_user(id) on delete cascade,
    public_key bytea not null,
    counter bigint not null default 0
  )`;
  // Read by this service alone, on its own connection; no app role reaches
  // it, and the audit is told so rather than left to report it.
  await sql`INSERT INTO mecha.rls_exempt VALUES
    ('public.webauthn_credential', 'the auth service''s own table: read by it alone, on its own connection')
    ON CONFLICT DO NOTHING`;
}

// --- HS256 JWT via WebCrypto ---

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const b = s.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b.length % 4 === 0 ? "" : "=".repeat(4 - (b.length % 4));
  return Uint8Array.from(atob(b + pad), (c) => c.charCodeAt(0));
}

let hmacKey: CryptoKey | undefined;
async function getKey(): Promise<CryptoKey> {
  hmacKey ??= await crypto.subtle.importKey(
    "raw",
    enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return hmacKey;
}

export async function signJwt(
  claims: Record<string, unknown>,
): Promise<string> {
  const head = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await getKey(), enc.encode(`${head}.${payload}`)),
  );
  return `${head}.${payload}.${b64urlEncode(sig)}`;
}

export async function verifyJwt(
  token: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await getKey(),
      b64urlDecode(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function issueUserToken(id: string, handle: string): Promise<string> {
  return signJwt({
    role: "app_user",
    sub: id,
    handle,
    exp: Math.floor(Date.now() / 1000) + USER_TOKEN_TTL_S,
  });
}

// --- The sync path's gatekeeper ---
//
// Electric names four parameters the server must own. Deciding them means
// asking Postgres which scopes a subject holds, so Caddy asks here over
// `forward_auth` (pronto/assets/Caddyfile) and this service decides.
//
// The predicate is built from `subject_scopes`, the same function
// `app_pre_request` uses for the CRUD path. One derivation, two deliveries: the
// paths cannot disagree about a subject's reach without disagreeing here first.

/** The `where` a shape may carry, canonical so the comparison can be equality. */
export function shapeWhere(scopes: string[]): string {
  return `scope_id IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(",")})`;
}

/**
 * Whether the floor reaches this table.
 *
 * A shape's predicate names `scope_id`, so a table without one cannot carry a
 * scoped shape: Electric answers 400 and the app reads it as a sync fault. The
 * refusal belongs here, where the reason is known — the table is exempt from
 * the floor, and until its scope derivation exists it has no business on a sync
 * path that is supposed to be scoped.
 */
async function isFloored(table: string): Promise<boolean> {
  // The floor's own precondition (has_scope in rls.sql); to_regclass is NULL
  // for a table that does not exist, and NULL has no scope.
  const rows = await sql`SELECT public.has_scope(to_regclass(${"public." + table})) AS ok`;
  return rows[0].ok as boolean;
}

async function subjectScopes(uid: string | null): Promise<string[]> {
  const rows = await sql`SELECT public.subject_scopes(${uid}) AS scopes`;
  return rows[0].scopes as string[];
}

/** A table name Electric will accept, and nothing that could be a predicate. */
function validTable(t: unknown): t is string {
  return typeof t === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(t);
}

/** The `where` of a per-row shape, canonical so the comparison can be equality. */
export function rowWhere(column: string, value: string): string {
  return `${column} = '${value.replaceAll("'", "''")}'`;
}

// Whether a shape over `table` keyed `column = value` reaches only rows this
// subject may read: mecha.shape_reach, asked as the subject. Role and claims
// are set here the way PostgREST sets them on a request, and rls.sql says why
// the switch has to be the caller's.
async function rowReach(uid: string, table: string, column: string, value: string): Promise<boolean> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE app_user`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "app_user" })}, true)`;
    await tx`SELECT public.app_pre_request()`;
    const rows = await tx`SELECT mecha.shape_reach(${"public." + table}, ${column}, ${value}) AS ok`;
    return rows[0].ok as boolean;
  });
}

async function bearerClaims(req: Request): Promise<Record<string, unknown> | null> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return await verifyJwt(auth.slice("Bearer ".length));
}

// A request's subject: a session's claims, no claims when no token was sent,
// and refused when a token was sent and is not a session.
type Subject = { claims: Record<string, unknown> | null } | "refused";
async function subjectOf(req: Request): Promise<Subject> {
  if (!req.headers.get("authorization")) return { claims: null };
  const claims = await bearerClaims(req);
  if (!claims || claims.role !== "app_user") return "refused";
  return { claims };
}

// Mints one token per shape, so a token names the table it was issued for and
// carries no reach beyond it.
async function shapeToken(req: Request): Promise<Response> {
  const subject = await subjectOf(req);
  if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
  const sub = subject.claims.sub as string;
  const body = await readBody(req);
  if (!body || !validTable(body.table)) return jsonError(400, "table required");

  // Two shapes a token can name. Keyed, it is one row's worth of a table,
  // reached by a subject the floor does not deliver it to; unkeyed, it is the
  // subject's scopes, over a table that carries one. Both need a session: a
  // shape carries the floor and nothing above it, and it is the permissive
  // layer above the floor that keeps anon out of a table on the CRUD path.
  let where: string;
  if (body.key !== undefined) {
    const key = body.key as Record<string, unknown> | null;
    if (
      typeof key !== "object" || key === null || !validTable(key.column) ||
      typeof key.value !== "string" || key.value.length > 200
    ) {
      return jsonError(400, "key must name a column and a value");
    }
    if (!(await rowReach(sub, body.table, key.column, key.value))) {
      return jsonError(403, "row not reachable");
    }
    where = rowWhere(key.column, key.value);
  } else {
    const [floored, scopes] = await Promise.all([isFloored(body.table), subjectScopes(sub)]);
    if (!floored) {
      return jsonError(
        409,
        `${body.table} carries no scope_id: it is exempt from the tenancy floor, ` +
          `so no shape over it can be scoped`,
      );
    }
    where = shapeWhere(scopes);
  }
  const token = await signJwt({
    typ: "shape",
    table: body.table,
    where,
    sub,
    exp: Math.floor(Date.now() / 1000) + SHAPE_TOKEN_TTL_S,
  });
  // `where` goes back so the client sends exactly what was authorized: the
  // check below is equality, and a client that rebuilds the string differently
  // is refused for a reason it cannot see.
  return json(200, { token, table: body.table, where, expires_in: SHAPE_TOKEN_TTL_S });
}

// The parameters a shape request may carry besides the two the token names:
// Electric's paging and streaming, none of which widens what a row predicate
// admits. Anything else is refused, `columns`, `replica`, `params` and the
// secret among them: a parameter this list does not know has a reach it does
// not know either.
const SHAPE_FREE_PARAMS = new Set([
  "offset",
  "handle",
  "live",
  "live_sse",
  "experimental_live_sse",
  "cursor",
  "expired_handle",
  "log",
  "cache-buster",
]);

// What Caddy asks before proxying to Electric. It answers about the request
// Caddy actually received, not about one the client describes: the method and
// URI arrive in X-Forwarded-Method and X-Forwarded-Uri, and every parameter
// that decides reach is compared.
async function shapeVerify(req: Request): Promise<Response> {
  const claims = await bearerClaims(req);
  if (!claims || claims.typ !== "shape") return jsonError(401, "invalid shape token");

  if (req.headers.get("x-forwarded-method") !== "GET") return jsonError(403, "method not allowed");
  const forwarded = req.headers.get("x-forwarded-uri");
  if (!forwarded) return jsonError(403, "no forwarded uri");
  // The shape route and nothing beside it: the proxy adds the secret to
  // whatever passes, and a token for a shape says nothing about any other
  // route Electric serves.
  if (!/^\/v1\/shape(\?|$)/.test(forwarded)) return jsonError(403, "not the shape route");
  // The raw query, not a parsed URL: a request line has no fragment, so `#`
  // is query text here as it is to Electric.
  if (forwarded.includes("#")) return jsonError(403, "fragment in uri");
  const q = forwarded.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : forwarded.slice(q + 1));

  // Electric keeps the last copy of a repeated parameter, so a parameter is
  // compared only once it is known to have one value.
  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length !== 1) return jsonError(403, `${key} repeated`);
    if (key !== "table" && key !== "where" && !SHAPE_FREE_PARAMS.has(key)) {
      return jsonError(403, `${key} is not a shape parameter`);
    }
  }
  // A missing parameter is not a matching one. `??` would let an absent `where`
  // read as authorized against a claim that named a predicate.
  if (params.get("table") !== claims.table) return jsonError(403, "table not authorized");
  if (params.get("where") !== claims.where) return jsonError(403, "where not authorized");
  return json(200, { ok: true });
}

// --- HTTP surface ---

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, error: string): Response {
  return json(status, { error });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

async function readState(
  body: Record<string, unknown>,
  purpose: string,
): Promise<Record<string, unknown> | null> {
  if (typeof body.state !== "string") return null;
  const st = await verifyJwt(body.state);
  if (!st || st.purpose !== purpose) return null;
  return st;
}

const ADJECTIVES = ["amber", "brisk", "calm", "dusk", "ember", "fern", "gold", "hazel", "ivory", "jade", "kind", "lunar", "mellow", "noble", "ochre", "pale", "quiet", "rustic", "sage", "tidal"];
const NOUNS = ["fox", "wren", "otter", "pine", "reed", "moth", "lark", "moss", "dune", "cove", "elk", "finch", "heron", "ibis", "kite", "lynx", "newt", "orca", "quail", "seal"];
function generateHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}-${10 + Math.floor(Math.random() * 90)}`;
}

async function registerStart(_req: Request): Promise<Response> {
  // Usernameless by doctrine: no identifier is ever collected.
  const handle = generateHandle();
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: "pronto",
    rpID: RP_ID,
    userName: handle,
    userID: enc.encode(userId),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  const state = await signJwt({
    purpose: "register",
    handle,
    userId,
    challenge: options.challenge,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_S,
  });
  return json(200, { ...options, state });
}

async function registerVerify(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonError(400, "invalid json body");
  const st = await readState(body, "register");
  if (!st) return jsonError(401, "invalid state");
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      // deno-lint-ignore no-explicit-any
      response: body.response as any,
      expectedChallenge: st.challenge as string,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });
  } catch {
    return jsonError(401, "registration verification failed");
  }
  if (!verification.verified || !verification.registrationInfo) {
    return jsonError(401, "registration verification failed");
  }
  const { credentialID, credentialPublicKey, counter } =
    verification.registrationInfo;
  const userId = st.userId as string;
  // Generated handles can collide; regenerate and retry — never a user error.
  let handle = st.handle as string;
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    try {
      await sql.begin(async (tx) => {
        await tx`insert into app_user (id, handle) values (${userId}, ${handle})`;
        await tx`insert into webauthn_credential (id, user_id, public_key, counter)
          values (${credentialID}, ${userId}, ${credentialPublicKey}, ${counter})`;
      });
      inserted = true;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") handle = generateHandle();
      else throw e;
    }
  }
  if (!inserted) return jsonError(500, "could not allocate identity");
  const token = await issueUserToken(userId, handle);
  return json(200, { token, user: { id: userId, handle } });
}

async function loginStart(_req: Request): Promise<Response> {
  // Discoverable credentials: the authenticator offers the resident passkey.
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [],
  });
  const state = await signJwt({
    purpose: "login",
    challenge: options.challenge,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_S,
  });
  return json(200, { ...options, state });
}

async function loginVerify(req: Request): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonError(400, "invalid json body");
  const st = await readState(body, "login");
  if (!st) return jsonError(401, "invalid state");
  const response = body.response as { id?: string } | undefined;
  if (!response || typeof response.id !== "string") {
    return jsonError(401, "authentication verification failed");
  }
  // The credential identifies the user (resident key).
  const creds = await sql`
    select c.id, c.public_key, c.counter, c.user_id, u.handle
    from webauthn_credential c join app_user u on u.id = c.user_id
    where c.id = ${response.id}`;
  if (creds.length === 0) {
    return jsonError(401, "authentication verification failed");
  }
  const cred = creds[0];
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      // deno-lint-ignore no-explicit-any
      response: body.response as any,
      expectedChallenge: st.challenge as string,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
      authenticator: {
        credentialID: cred.id as string,
        credentialPublicKey: new Uint8Array(cred.public_key as Uint8Array),
        counter: Number(cred.counter),
      },
    });
  } catch {
    return jsonError(401, "authentication verification failed");
  }
  if (!verification.verified) {
    return jsonError(401, "authentication verification failed");
  }
  await sql`update webauthn_credential
    set counter = ${verification.authenticationInfo.newCounter}
    where id = ${cred.id as string}`;
  const userId = cred.user_id as string;
  const handle = cred.handle as string;
  const token = await issueUserToken(userId, handle);
  return json(200, { token, user: { id: userId, handle } });
}

async function guest(_req: Request): Promise<Response> {
  // Origin-independent by terminal doctrine: no WebAuthn, no origin check —
  // this door must open from any origin the cluster is reachable on.
  const userId = crypto.randomUUID();
  let handle = generateHandle();
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    try {
      await sql`insert into app_user (id, handle) values (${userId}, ${handle})`;
      inserted = true;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") handle = generateHandle();
      else throw e;
    }
  }
  if (!inserted) return jsonError(500, "could not allocate identity");
  const token = await issueUserToken(userId, handle);
  return json(200, { token, user: { id: userId, handle } });
}

async function whoami(req: Request): Promise<Response> {
  const subject = await subjectOf(req);
  if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
  const claims = subject.claims;
  return json(200, { id: claims.sub, handle: claims.handle });
}

export async function handler(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  try {
    if (req.method === "POST" && path === "/auth/register/start") {
      return await registerStart(req);
    }
    if (req.method === "POST" && path === "/auth/register/verify") {
      return await registerVerify(req);
    }
    if (req.method === "POST" && path === "/auth/login/start") {
      return await loginStart(req);
    }
    if (req.method === "POST" && path === "/auth/login/verify") {
      return await loginVerify(req);
    }
    if (req.method === "POST" && path === "/auth/guest") {
      return await guest(req);
    }
    if (req.method === "GET" && path === "/auth/whoami") {
      return await whoami(req);
    }
    if (req.method === "POST" && path === "/auth/shape") {
      return await shapeToken(req);
    }
    if (req.method === "GET" && path === "/auth/shape/verify") {
      return await shapeVerify(req);
    }
    return jsonError(404, "not found");
  } catch (e) {
    console.error(e);
    return jsonError(500, "internal error");
  }
}

if (import.meta.main) {
  await migrate();
  Deno.serve({ port: 9999 }, handler);
}
