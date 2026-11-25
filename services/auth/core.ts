// The auth routes every mecha cluster serves, written once over the database it
// is handed: the Deno service's Postgres (main.ts) and the edge's PGlite
// (mecha-edge's cluster.ts) adapt their drivers to AuthDb, so the two answer
// alike by construction. WebAuthn passkeys, provider sign-in (oidc.ts), the
// device's session (session.ts), refresh tokens for native hosts, renaming,
// deleting, and the guest mint. The contract is README.md.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { GUEST_ACR, guestProof, isGuest, passkeyProof, type Person, type Proof, proofOf, sessionClaims } from "./claims.ts";
import { guestHandle, nameHandle, nameOf } from "./handles.ts";
import { encodeBase64Url, randomToken, sha256url, signJwt, STACK_ISSUER, verifyJwt } from "./jwt.ts";
import { type Authority, type Links, oidc, type Profile, type Provider, providerStill, type Tickets } from "./oidc.ts";
import { deviceSession, type User, type Way } from "./session.ts";

export type Row = Record<string, unknown>;
/** One statement and the rows it returns (a write's, by RETURNING). */
export type Query = (text: string, params?: unknown[]) => Promise<Row[]>;
/** What the routes need of a database: a statement, and a transaction whose
 * statements go through the Query it is handed. */
export type AuthDb = {
  query: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
};

export type AuthCoreConfig = {
  db: AuthDb;
  secret: string;
  /** The relying party a ceremony through this request is made for. */
  rpId: (req: Request) => string;
  /** The door this request came through. */
  origin: (req: Request) => string;
  /** The origins a WebAuthn ceremony may have been made on. */
  ceremonyOrigins: (req: Request) => string[];
  providers: Record<string, Provider>;
  nativeSchemes: readonly string[];
  fetcher?: typeof fetch;
};

const USER_TOKEN_TTL_S = 7 * 24 * 3600;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;
const STATE_TTL_S = 300;
/** How recent the sign-in that adds or removes a way stands: NIST's
 * reauthentication before binding an authenticator, the step-up default. */
export const RECENT_S = 600;
/** Not now puts asking to set up recovery off a day, then two, four, … 2^6. */
const LATER_MAX_EXP = 6;
const NAME_EMPTY = "a name needs a letter or a digit";

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const unique = (e: unknown) => (e as { code?: string }).code === "23505";

function json(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}
const jsonError = (status: number, error: string) => json(status, { error });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text === "") return {};
  try {
    const body = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Whether `id` is still a guest, holding neither a passkey nor a link, under
 * a lock its promotion takes too: a guest becomes an account once. */
async function stillGuest(q: Query, id: string): Promise<boolean> {
  await q("select pg_advisory_xact_lock(hashtext($1))", [`mecha auth: promote ${id}`]);
  const [row] = await q(
    `select not exists (select 1 from mecha_auth.webauthn_credential where user_id = $1::uuid)
       and not exists (select 1 from mecha_auth.identity_link where user_id = $1::uuid) as guest`,
    [id],
  );
  return row.guest as boolean;
}

/** An account still under the name it was drawn takes the one its provider
 * gives, where no other account goes by it; one renamed since keeps its own. */
async function namedByProvider(q: Query, id: string, called: string): Promise<void> {
  const named = nameHandle(called, id);
  if (named === null) return;
  await q(
    `update app_user set handle = $1 where id = $2::uuid and handle = $3
       and not exists (select 1 from app_user where handle = $1)`,
    [named, id, guestHandle(id)],
  );
}

/** The account's ways taken in hand, and whether the sign-in that authorized
 * a change to them is still recent and its way still signs it in: a way
 * removed, or a deadline passed while the change waited, changes nothing. */
async function authorizedBy(q: Query, id: string, { way, since }: Authority): Promise<boolean> {
  await q("select pg_advisory_xact_lock(hashtext($1))", [`mecha auth: ways ${id}`]);
  if (since === null || since < Math.floor(Date.now() / 1000) - RECENT_S) return false;
  const rows = way.kind === "passkey"
    ? await q("select 1 from mecha_auth.webauthn_credential where id = $1 and user_id = $2::uuid", [way.credential, id])
    : way.kind === "provider"
    ? await q("select 1 from mecha_auth.identity_link where issuer = $1 and sub = $2 and user_id = $3::uuid limit 1", [way.issuer, way.sub, id])
    : [];
  return rows.length === 1;
}

/** A challenge spent: the first answer to it signs in, any other is a replay. */
async function spend(q: Query, challenge: string, exp: number): Promise<boolean> {
  await q("delete from mecha_auth.webauthn_challenge where expires_at < now()");
  const fresh = await q(
    `insert into mecha_auth.webauthn_challenge (challenge, expires_at) values ($1, to_timestamp($2))
       on conflict do nothing returning 1`,
    [challenge, exp],
  );
  return fresh.length === 1;
}

export function authCore(cfg: AuthCoreConfig) {
  const { db, secret } = cfg;
  const sign = (claims: Row) => signJwt(secret, claims);

  /** A session for `user`, signed in as `proof` says, until `exp`, issued as
   * the stack (the database floor acts only on the stack's tokens). */
  const issueUserToken = (user: Person, proof: Proof, exp = now() + USER_TOKEN_TTL_S) =>
    sign(sessionClaims(STACK_ISSUER, user, proof, exp));

  // A request's subject: a session's claims, no claims when no token was sent,
  // and refused when a token was sent and is not a session.
  type Subject = { claims: Row | null } | "refused";
  async function subjectOf(req: Request): Promise<Subject> {
    const auth = req.headers.get("authorization");
    if (!auth) return { claims: null };
    const claims = auth.startsWith("Bearer ") ? await verifyJwt(secret, auth.slice("Bearer ".length)) : null;
    if (!claims || claims.role !== "app_user") return "refused";
    return { claims };
  }

  async function readState(body: Row, purpose: string): Promise<Row | null> {
    if (typeof body.state !== "string") return null;
    const st = await verifyJwt(secret, body.state);
    return st && st.purpose === purpose ? st : null;
  }

  /** What the browser hands the WebAuthn Signal API to name a person's
   * passkeys: the relying party and the user handle they were made under. */
  const passkeyOf = (req: Request, userId: string) => ({ rpId: cfg.rpId(req), userId: encodeBase64Url(enc.encode(userId)) });

  // --- Who signs in -------------------------------------------------------

  const links: Links = {
    userFor(p: Profile, guest: string | null) {
      return db.tx(async (q) => {
        // Lock by (issuer, sub) so sibling provider entries sharing an issuer
        // (e.g. google and email on the same broker) resolve to one person.
        await q("select pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([p.issuer, p.sub])]);
        const [existing] = await q(
          `select provider, user_id from mecha_auth.identity_link
             where issuer = $1 and sub = $2
             order by (provider = $3) desc, created_at asc limit 1`,
          [p.issuer, p.sub, p.provider],
        );
        const [link] = existing
          ? await q(
            `update mecha_auth.identity_link set name = $1, picture = $2, email = $3
               where provider = $4 and issuer = $5 and sub = $6 returning user_id`,
            [p.name, p.picture, p.email, existing.provider as string, p.issuer, p.sub],
          )
          : [];
        // The name the provider gives, the first name before the whole one.
        const called = p.given ?? p.name ?? "";
        const link_ = async (id: string) =>
          await q(
            `insert into mecha_auth.identity_link (provider, issuer, sub, user_id, name, picture, email)
               values ($1, $2, $3, $4::uuid, $5, $6, $7)`,
            [p.provider, p.issuer, p.sub, id, p.name, p.picture, p.email],
          );
        const handleOf = async (id: string) => (await q("select handle from app_user where id = $1::uuid", [id]))[0].handle as string;
        if (link) {
          const id = link.user_id as string;
          await namedByProvider(q, id, called);
          const user = { id, handle: await handleOf(id), name: p.name, email: p.email };
          return guest !== null && guest !== id ? { taken: user } : user;
        }
        // A guest keeps its own name where another account goes by the provider's.
        if (guest !== null && (await stillGuest(q, guest))) {
          const named = nameHandle(called, guest);
          if (named !== null) {
            await q(
              "update app_user set handle = $1 where id = $2::uuid and not exists (select 1 from app_user where handle = $1)",
              [named, guest],
            );
          }
          await link_(guest);
          return { id: guest, handle: await handleOf(guest), name: p.name, email: p.email };
        }
        // A name another account goes by is a draw of another id, whose suffix differs.
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = crypto.randomUUID();
          const handle = nameHandle(called, id) ?? guestHandle(id);
          await q("savepoint alloc");
          try {
            await q("insert into app_user (id, handle) values ($1::uuid, $2)", [id, handle]);
            await q("release savepoint alloc");
          } catch (e) {
            await q("rollback to savepoint alloc");
            if (unique(e)) continue;
            throw e;
          }
          await link_(id);
          return { id, handle, name: p.name, email: p.email };
        }
        throw new Error("could not allocate identity");
      });
    },
    addTo(p: Profile, owner: string, by: Authority) {
      return db.tx(async (q) => {
        await q("select pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([p.issuer, p.sub])]);
        if (!(await authorizedBy(q, owner, by))) return "revoked";
        const [existing] = await q(
          `select provider, user_id from mecha_auth.identity_link
             where issuer = $1 and sub = $2
             order by (provider = $3) desc, created_at asc limit 1`,
          [p.issuer, p.sub, p.provider],
        );
        const [link] = existing
          ? await q(
            `update mecha_auth.identity_link set name = $1, picture = $2, email = $3
               where provider = $4 and issuer = $5 and sub = $6 returning user_id`,
            [p.name, p.picture, p.email, existing.provider as string, p.issuer, p.sub],
          )
          : [];
        if (link) return link.user_id === owner ? "added" : "taken";
        // One link per issuer: a second subject from the same issuer would outlive
        // removing the first, and sibling providers at a shared broker share one sub.
        const [held] = await q("select 1 from mecha_auth.identity_link where issuer = $1 and user_id = $2::uuid", [p.issuer, owner]);
        if (held) return "held";
        await q(
          `insert into mecha_auth.identity_link (provider, issuer, sub, user_id, name, picture, email)
             values ($1, $2, $3, $4::uuid, $5, $6, $7)`,
          [p.provider, p.issuer, p.sub, owner, p.name, p.picture, p.email],
        );
        return "added";
      });
    },
    async handleOf(provider: string, issuer: string, sub: string, id: string) {
      return await db.tx(async (q) => {
        const [l] = await q(
          `select name from mecha_auth.identity_link
             where user_id = $1::uuid and issuer = $2 and sub = $3
             order by (provider = $4) desc, created_at asc limit 1`,
          [id, issuer, sub, provider],
        );
        if (l?.name) await namedByProvider(q, id, l.name as string);
        const [u] = await q(
          `select u.handle, l.name, l.email from app_user u
             join mecha_auth.identity_link l on l.user_id = u.id and l.issuer = $2 and l.sub = $3
             where u.id = $1::uuid
             order by (l.provider = $4) desc, l.created_at asc limit 1`,
          [id, issuer, sub, provider],
        );
        return u ? { handle: u.handle as string, name: (u.name as string | null) ?? null, email: (u.email as string | null) ?? null } : null;
      });
    },
  };

  const providerStands = providerStill(cfg.providers, links);

  /** The account a way still signs in: its passkey still the account's, its
   * provider's link still there, its guest still a guest. */
  async function still(way: Way, sub: string): Promise<User | null> {
    if (way.kind === "provider") return await providerStands(way, sub);
    return await db.tx(async (q) => {
      if (way.kind === "passkey") {
        const [u] = await q(
          `select u.handle from mecha_auth.webauthn_credential c join app_user u on u.id = c.user_id
             where c.id = $1 and c.user_id = $2::uuid`,
          [way.credential, sub],
        );
        return u ? { id: sub, handle: u.handle as string } : null;
      }
      if (!(await stillGuest(q, sub))) return null;
      const [u] = await q("select handle from app_user where id = $1::uuid", [sub]);
      return u ? { id: sub, handle: u.handle as string, guest: true } : null;
    });
  }

  const device = deviceSession({ secret, origin: cfg.origin, still, issue: (user, proof) => issueUserToken(user, proof) });

  // --- Ways in: an account's, added and removed while signed in -----------
  //
  // On the strength of this device's own session, never a bearer token, which
  // outlives its sign-out: the cookie, from the door's own origin, of an
  // account (a guest's ways are signing in), and for a change one signed in
  // within RECENT_S, so a session left open is no way to add a way in.

  type Owner = { user: User; way: Way; since: number | null };
  async function owner(req: Request, recent: boolean): Promise<Owner | Response> {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== cfg.origin(req)) return jsonError(403, "another origin");
    const own = await device.current(req);
    if (own === null) return jsonError(401, "not signed in");
    if (own.way.kind === "guest") return jsonError(403, "a guest's ways in are signing in");
    if (recent && (own.since === null || own.since < now() - RECENT_S)) {
      return json(401, { error: "insufficient_user_authentication", max_age: RECENT_S });
    }
    return own;
  }

  type Listed =
    | { kind: "passkey"; id: string; added: string | null }
    | { kind: "provider"; provider: string; issuer: string; sub: string; name: string | null; email: string | null; added: string };
  async function waysOf(q: Query, id: string): Promise<Listed[]> {
    const passkeys = await q("select id, created_at from mecha_auth.webauthn_credential where user_id = $1::uuid order by created_at nulls first, id", [id]);
    const providers = await q(
      "select provider, issuer, sub, name, email, created_at from mecha_auth.identity_link where user_id = $1::uuid order by created_at, provider",
      [id],
    );
    const at = (t: unknown) => t === null ? null : new Date(t as string).toISOString();
    return [
      ...passkeys.map((r) => ({ kind: "passkey" as const, id: r.id as string, added: at(r.created_at) })),
      ...providers.map((r) => ({
        kind: "provider" as const,
        provider: r.provider as string,
        issuer: r.issuer as string,
        sub: r.sub as string,
        name: (r.name as string | null) ?? null,
        email: (r.email as string | null) ?? null,
        added: at(r.created_at)!,
      })),
    ];
  }
  const isWay = (listed: Listed, way: Way) =>
    listed.kind === "passkey" ? way.kind === "passkey" && way.credential === listed.id
    : way.kind === "provider" && way.issuer === listed.issuer && way.sub === listed.sub;

  /** The account's ways in, which one this device came in by, whether a
   * change needs a sign-in first, and whether to ask to set up recovery: an
   * account whose one way in is all it has, that had an external effect
   * before this sign-in, unless Not now put the question off. */
  async function ways(req: Request): Promise<Response> {
    const own = await owner(req, false);
    if (own instanceof Response) return own;
    const listed = await db.tx((q) => waysOf(q, own.user.id));
    // A provider this deployment no longer signs in by is no way back in.
    const usable = listed.filter((w) => w.kind === "passkey" || Object.values(cfg.providers).some((p) => p.issuer === w.issuer));
    const [r] = await db.query(
      `select effected_at < to_timestamp($2) and (ask_after is null or ask_after <= now()) as ask
         from mecha_auth.account_recovery where user_id = $1::uuid`,
      [own.user.id, own.since ?? 0],
    );
    return json(200, {
      ways: listed.map((w) => ({ ...w, current: isWay(w, own.way) })),
      recent: own.since !== null && own.since >= now() - RECENT_S,
      recovery: usable.length < 2 && own.since !== null && r?.ask === true,
    });
  }

  /** A way removed while another stays, never the one this device came in
   * by: signing in by another removes it. Every session that came in by it
   * ends at its next exchange (still). */
  async function removeWay(req: Request): Promise<Response> {
    const own = await owner(req, true);
    if (own instanceof Response) return own;
    const body = await readBody(req);
    if (!body) return jsonError(400, "invalid json body");
    const outcome = await db.tx(async (q) => {
      if (!(await authorizedBy(q, own.user.id, own))) return "revoked";
      const listed = await waysOf(q, own.user.id);
      const target = listed.find((w) =>
        w.kind === "passkey" ? body.kind === "passkey" && body.id === w.id
        : body.kind === "provider" && body.provider === w.provider && body.issuer === w.issuer && body.sub === w.sub
      );
      if (target === undefined) return "none";
      if (isWay(target, own.way)) return "current";
      if (listed.length < 2) return "last";
      if (target.kind === "passkey") await q("delete from mecha_auth.webauthn_credential where id = $1 and user_id = $2::uuid", [target.id, own.user.id]);
      else {
        await q(
          "delete from mecha_auth.identity_link where issuer = $1 and sub = $2 and user_id = $3::uuid",
          [target.issuer, target.sub, own.user.id],
        );
      }
      return "removed";
    });
    if (outcome === "revoked") return jsonError(401, "not signed in");
    if (outcome === "none") return jsonError(404, "no such way in");
    if (outcome === "current") return jsonError(409, "the way this device signed in by");
    if (outcome === "last") return jsonError(409, "the last way in");
    return json(200, { removed: true });
  }

  /** Not now: asked again after a day, two, four, … up to LATER_MAX_DAYS. */
  async function later(req: Request): Promise<Response> {
    const own = await owner(req, false);
    if (own instanceof Response) return own;
    await db.query(
      `update mecha_auth.account_recovery set declines = declines + 1,
         ask_after = now() + make_interval(days => power(2, least(declines, $2))::int)
         where user_id = $1::uuid`,
      [own.user.id, LATER_MAX_EXP],
    );
    return json(200, { later: true });
  }

  /** A passkey's creation options for the account, its own passkeys
   * excluded so an authenticator holding one makes no second. */
  async function addPasskeyStart(req: Request): Promise<Response> {
    const own = await owner(req, true);
    if (own instanceof Response) return own;
    const held = await db.query("select id from mecha_auth.webauthn_credential where user_id = $1::uuid", [own.user.id]);
    const rpId = cfg.rpId(req);
    const options = await generateRegistrationOptions({
      rpName: rpId,
      rpID: rpId,
      userName: nameOf(own.user.handle),
      userDisplayName: nameOf(own.user.handle),
      userID: enc.encode(own.user.id),
      excludeCredentials: held.map((r) => ({ id: r.id as string })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const state = await sign({ purpose: "add-passkey", userId: own.user.id, challenge: options.challenge, exp: now() + STATE_TTL_S });
    return json(200, { ...options, state });
  }

  async function addPasskeyVerify(req: Request): Promise<Response> {
    const own = await owner(req, true);
    if (own instanceof Response) return own;
    const body = await readBody(req);
    if (!body) return jsonError(400, "invalid json body");
    const st = await readState(body, "add-passkey");
    if (!st) return jsonError(401, "invalid state");
    if (st.userId !== own.user.id) return jsonError(409, "this device signed in to another account since");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: cfg.ceremonyOrigins(req),
        expectedRPID: cfg.rpId(req),
        requireUserVerification: false,
      });
    } catch {
      return jsonError(401, "registration verification failed");
    }
    if (!verification.verified || !verification.registrationInfo) return jsonError(401, "registration verification failed");
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const made = await db.tx(async (q) => {
      if (!(await spend(q, st.challenge as string, st.exp as number))) return "replayed";
      if (!(await authorizedBy(q, own.user.id, own))) return "revoked";
      await q(
        "insert into mecha_auth.webauthn_credential (id, user_id, public_key, counter) values ($1, $2::uuid, $3::bytea, $4)",
        [credentialID, own.user.id, credentialPublicKey, counter],
      );
      return "made";
    });
    if (made === "replayed") return jsonError(401, "registration verification failed");
    if (made === "revoked") return jsonError(401, "not signed in");
    return json(200, { added: true, passkey: passkeyOf(req, own.user.id) });
  }

  /** The account a provider's way is added to, and the way that authorizes
   * it (oidc.ts). */
  async function adding(req: Request): Promise<{ owner: string } & Authority | Response> {
    const own = await owner(req, true);
    return own instanceof Response ? own : { owner: own.user.id, way: own.way, since: own.since };
  }

  // --- Refresh tokens: a native host's renewal ----------------------------
  //
  // A browser renews by its HttpOnly cookie, so only a native host, which has
  // none, asks for one (`refresh: true`). A family is the sign-in's: it keeps
  // the way and proof, renews only while the way stands, and a token spent
  // twice revokes it.

  async function issueRefreshToken(userId: string, proof: Proof, way: Way): Promise<string> {
    const raw = randomToken(32);
    await db.query(
      `insert into mecha_auth.auth_refresh_token (token_hash, user_id, family_id, proof, way, expires_at)
         values ($1, $2::uuid, $3::uuid, $4::text::jsonb, $5::text::jsonb, now() + make_interval(secs => $6))`,
      [await sha256url(raw), userId, crypto.randomUUID(), JSON.stringify(proof), JSON.stringify(way), REFRESH_TOKEN_TTL_S],
    );
    return raw;
  }

  /** A session, and for a native host the refresh token that renews it. */
  const sessionFor = async (user: Person, proof: Proof, way: Way, native: boolean) => ({
    token: await issueUserToken(user, proof),
    ...(native ? { refresh_token: await issueRefreshToken(user.id, proof, way) } : {}),
  });
  const nativeSession = (user: Person, proof: Proof, way: Way) =>
    sessionFor(user, proof, way, true) as Promise<{ token: string; refresh_token: string }>;

  async function refresh(req: Request): Promise<Response> {
    const body = await readBody(req);
    if (!body || typeof body.refresh_token !== "string" || body.refresh_token === "") {
      return jsonError(400, "refresh_token required");
    }
    const hash = await sha256url(body.refresh_token);
    const nextRaw = randomToken(32);
    const nextHash = await sha256url(nextRaw);
    const rotated = await db.tx(async (q) => {
      const [found] = await q("select family_id from mecha_auth.auth_refresh_token where token_hash = $1", [hash]);
      if (!found) return null;
      // A family rotates and is revoked one statement at a time, so a replay
      // revokes every token the family has, its newest included.
      await q("select pg_advisory_xact_lock(hashtext($1))", [`mecha auth: refresh ${found.family_id}`]);
      const [row] = await q(
        `select user_id, family_id, proof, way, expires_at <= now() as expired, replaced_by, revoked_at
           from mecha_auth.auth_refresh_token where token_hash = $1`,
        [hash],
      );
      if (row.replaced_by !== null) {
        await q("update mecha_auth.auth_refresh_token set revoked_at = coalesce(revoked_at, now()) where family_id = $1::uuid", [row.family_id]);
        return null;
      }
      if (row.revoked_at !== null || row.expired || row.proof === null || row.way === null) return null;
      await q("update mecha_auth.auth_refresh_token set replaced_by = $1 where token_hash = $2", [nextHash, hash]);
      await q(
        `insert into mecha_auth.auth_refresh_token (token_hash, user_id, family_id, proof, way, expires_at)
           values ($1, $2::uuid, $3::uuid, $4::text::jsonb, $5::text::jsonb, now() + make_interval(secs => $6))`,
        [nextHash, row.user_id, row.family_id, JSON.stringify(row.proof), JSON.stringify(row.way), REFRESH_TOKEN_TTL_S],
      );
      return { sub: row.user_id as string, proof: row.proof as Proof, way: row.way as Way };
    });
    if (rotated === null) return jsonError(401, "invalid refresh token");
    const who = await still(rotated.way, rotated.sub);
    if (who === null) return jsonError(401, "invalid refresh token");
    const [link] = rotated.way.kind === "provider"
      ? await db.query(
        `select name, email from mecha_auth.identity_link
           where user_id = $1::uuid and issuer = $2 and sub = $3
           order by (provider = $4) desc, created_at asc limit 1`,
        [rotated.sub, rotated.way.issuer, rotated.way.sub, rotated.way.provider],
      )
      : [];
    const user: Person = {
      id: rotated.sub,
      handle: who.handle,
      ...(link?.name ? { name: link.name as string } : {}),
      ...(link?.email ? { email: link.email as string } : {}),
    };
    return json(200, {
      token: await issueUserToken(user, rotated.proof),
      refresh_token: nextRaw,
      user: rotated.proof.acr === GUEST_ACR ? { id: user.id, handle: user.handle, guest: true } : user,
    });
  }

  // --- Passkeys -----------------------------------------------------------

  async function registerStart(req: Request): Promise<Response> {
    const subject = await subjectOf(req);
    if (subject === "refused") return jsonError(401, "invalid token");
    const claims = subject.claims;
    // Only a guest is promoted, keeping its handle and every row it wrote: a
    // passkey added to an account on the strength of a bearer token would
    // outlive the token and its sign-out. With no session, a new identity —
    // usernameless by doctrine: no identifier is ever collected.
    if (claims !== null && !isGuest(claims)) return jsonError(409, "already an account");
    const body = await readBody(req);
    if (!body) return jsonError(400, "invalid json body");
    const name = typeof body.name === "string" ? body.name : null;
    const promote = claims !== null;
    // The account the passkey is made under is fixed here, its id in the
    // passkey, so its handle is free before the ceremony starts: a new account
    // takes another id until it is.
    let userId = claims ? claims.sub as string : crypto.randomUUID();
    let handle = "";
    for (let attempt = 0; attempt < 3 && handle === ""; attempt++) {
      const named = name === null ? (claims ? claims.handle as string : guestHandle(userId)) : nameHandle(name, userId);
      if (named === null) return jsonError(400, NAME_EMPTY);
      const [taken] = await db.query(
        "select exists (select 1 from app_user where handle = $1 and id <> $2::uuid) as taken",
        [named, userId],
      );
      if (!taken.taken) handle = named;
      else if (promote) return jsonError(409, "name taken");
      else userId = crypto.randomUUID();
    }
    if (handle === "") return jsonError(500, "could not allocate identity");
    const rpId = cfg.rpId(req);
    const options = await generateRegistrationOptions({
      rpName: rpId,
      rpID: rpId,
      userName: nameOf(handle),
      userDisplayName: nameOf(handle),
      userID: enc.encode(userId),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const state = await sign({ purpose: "register", handle, userId, promote, challenge: options.challenge, exp: now() + STATE_TTL_S });
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
        expectedOrigin: cfg.ceremonyOrigins(req),
        expectedRPID: cfg.rpId(req),
        requireUserVerification: false,
      });
    } catch {
      return jsonError(401, "registration verification failed");
    }
    if (!verification.verified || !verification.registrationInfo) return jsonError(401, "registration verification failed");
    const { credentialID, credentialPublicKey, counter, userVerified } = verification.registrationInfo;
    const userId = st.userId as string;
    const handle = st.handle as string;
    const proof = passkeyProof(userVerified, now());
    // The challenge is spent with the account it makes, and outlives a
    // deletion of it: one answer makes one account, once.
    let made: "made" | "replayed" | "promoted";
    try {
      made = await db.tx(async (q) => {
        if (!(await spend(q, st.challenge as string, st.exp as number))) return "replayed";
        if (st.promote === true) {
          // A guest token that outlives its promotion is still a guest's, and
          // adds no second way in; racing promotions of one guest serialize on
          // it. The guest takes the name it was given with the passkey.
          if (!(await stillGuest(q, userId))) return "promoted";
          await q("update app_user set handle = $1 where id = $2::uuid", [handle, userId]);
        } else {
          await q("insert into app_user (id, handle) values ($1::uuid, $2)", [userId, handle]);
        }
        await q(
          "insert into mecha_auth.webauthn_credential (id, user_id, public_key, counter) values ($1, $2::uuid, $3::bytea, $4)",
          [credentialID, userId, credentialPublicKey, counter],
        );
        return "made";
      });
    } catch (e) {
      // Free when the ceremony started, taken since.
      if (unique(e)) return jsonError(409, "name taken");
      throw e;
    }
    if (made === "replayed") return jsonError(401, "registration verification failed");
    if (made === "promoted") return jsonError(409, "already an account");
    const user = { id: userId, handle };
    const way: Way = { kind: "passkey", credential: credentialID };
    return json(200, { ...(await sessionFor(user, proof, way, body.refresh === true)), user, passkey: passkeyOf(req, userId) }, await device.signedIn(req, userId, way, proof));
  }

  async function loginStart(req: Request): Promise<Response> {
    // Usernameless by doctrine: allowCredentials is empty so the authenticator
    // surfaces its discoverable (resident) credentials for this RP.
    const options = await generateAuthenticationOptions({ rpID: cfg.rpId(req), allowCredentials: [] });
    const state = await sign({ purpose: "login", challenge: options.challenge, exp: now() + STATE_TTL_S });
    return json(200, { ...options, state });
  }

  async function loginVerify(req: Request): Promise<Response> {
    // A guest signs in with its token, so a passkey that is another account's
    // is OpenID Connect's `login_required` rather than a silent switch.
    const subject = await subjectOf(req);
    if (subject === "refused") return jsonError(401, "invalid token");
    const hinted = subject.claims !== null && isGuest(subject.claims) ? subject.claims.sub as string : null;
    const body = await readBody(req);
    if (!body) return jsonError(400, "invalid json body");
    const st = await readState(body, "login");
    if (!st) return jsonError(401, "invalid state");
    const response = body.response as { id?: string } | undefined;
    if (!response || typeof response.id !== "string") return jsonError(401, "authentication verification failed");
    // The credential identifies the user (resident key).
    const [cred] = await db.query(
      `select c.id, c.public_key, c.counter, c.user_id, u.handle
         from mecha_auth.webauthn_credential c join app_user u on u.id = c.user_id where c.id = $1`,
      [response.id],
    );
    if (!cred) return json(401, { error: "authentication verification failed", unknownCredential: true });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: cfg.ceremonyOrigins(req),
        expectedRPID: cfg.rpId(req),
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
    if (!verification.verified) return jsonError(401, "authentication verification failed");
    const { newCounter, userVerified } = verification.authenticationInfo;
    // The challenge is spent, and the counter only climbs: an answer replayed,
    // or a cloned authenticator's behind the original, signs nobody in. A
    // synced passkey's counter stays 0, and 0 never follows a count.
    const spent = await db.tx(async (q) => {
      if (!(await spend(q, st.challenge as string, st.exp as number))) return false;
      const counted = await q(
        `update mecha_auth.webauthn_credential set counter = $1
           where id = $2 and (counter < $1 or ($1 = 0 and counter = 0)) returning 1`,
        [newCounter, cred.id],
      );
      if (counted.length === 1) return true;
      throw new CounterBehind();
    }).catch((e) => {
      if (e instanceof CounterBehind) return false;
      throw e;
    });
    if (!spent) return jsonError(401, "authentication verification failed");
    const user = { id: cred.user_id as string, handle: cred.handle as string };
    const proof = passkeyProof(userVerified, now());
    const way: Way = { kind: "passkey", credential: cred.id as string };
    // The account is held with the refusal: the passkey is proven, and
    // switching to it at /auth/session/switch needs no second ceremony.
    if (hinted !== null && hinted !== user.id) {
      const { cookies, offer } = await device.held(req, user.id, way, proof);
      return json(409, { error: "login_required", user: { handle: user.handle }, offer }, cookies);
    }
    return json(200, { ...(await sessionFor(user, proof, way, body.refresh === true)), user, passkey: passkeyOf(req, user.id) }, await device.signedIn(req, user.id, way, proof));
  }

  // --- Guests, names, and the account itself ------------------------------

  async function guest(req: Request): Promise<Response> {
    // Any origin may mint a guest for its own token; only the door's own is
    // given this browser's cookie (session.ts), and only when it asks: a page
    // minting ahead of the reader (`cookie: false`) adopts the guest once it
    // keeps it, so a sign-in finished first is not replaced by a mint landing
    // after. A guest's name is drawn from its id, so a name another account
    // holds is a draw of another id.
    const body = await readBody(req);
    if (!body) return jsonError(400, "invalid json body");
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = crypto.randomUUID();
      try {
        const [row] = await db.query("insert into app_user (id, handle) values ($1::uuid, $2) returning handle", [id, guestHandle(id)]);
        const user = { id, handle: row.handle as string };
        const proof = guestProof(now());
        const way: Way = { kind: "guest" };
        // A guest is told so: it is the one session a passkey or provider can still promote.
        const cookies = body.cookie === false ? [] : await device.signedIn(req, id, way, proof);
        return json(200, { ...(await sessionFor(user, proof, way, body.refresh === true)), user: { ...user, guest: true } }, cookies);
      } catch (e) {
        if (!unique(e)) throw e;
      }
    }
    return jsonError(500, "could not allocate identity");
  }

  /** The session's account called by another name: the handle's name part
   * changes, its suffix stays, and the session is issued again as it was
   * signed in and until it was to end, so renaming renews nothing. A guest is
   * renamed as a person is, while it is still a guest: its token outlives a
   * promotion and is no way into the account it became. */
  async function rename(req: Request): Promise<Response> {
    const subject = await subjectOf(req);
    if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
    const claims = subject.claims;
    const body = await readBody(req);
    if (!body || typeof body.name !== "string") return jsonError(400, "name required");
    const id = claims.sub as string;
    const handle = nameHandle(body.name, id);
    if (handle === null) return jsonError(400, NAME_EMPTY);
    let renamed;
    try {
      renamed = await db.tx(async (q) => {
        if (isGuest(claims) && !(await stillGuest(q, id))) return "promoted";
        return (await q("update app_user set handle = $1 where id = $2::uuid returning 1", [handle, id])).length;
      });
    } catch (e) {
      if (unique(e)) return jsonError(409, "name taken");
      throw e;
    }
    if (renamed === "promoted") return jsonError(409, "already an account");
    if (renamed === 0) return jsonError(401, "no such account");
    const user = {
      id,
      handle,
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    };
    const token = await issueUserToken(user, proofOf(claims), claims.exp as number);
    return json(200, { token, user: isGuest(claims) ? { ...user, guest: true } : user, passkey: passkeyOf(req, id) });
  }

  // The account and every row it owns, gone; the device signed out of it. A
  // guest's token deletes the guest alone: one that outlived its promotion is
  // no way into the account it became.
  async function deleteAccount(req: Request): Promise<Response> {
    const subject = await subjectOf(req);
    if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
    const claims = subject.claims;
    const id = claims.sub as string;
    const deleted = await db.tx(async (q) => {
      if (isGuest(claims) && !(await stillGuest(q, id))) return false;
      await q("delete from app_user where id = $1::uuid", [id]);
      return true;
    });
    if (!deleted) return jsonError(409, "already an account");
    return json(200, { deleted: true }, device.signedOut(req));
  }

  async function whoami(req: Request): Promise<Response> {
    const subject = await subjectOf(req);
    if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
    const claims = subject.claims;
    // A token outlives its account's deletion; the account does not.
    const [u] = await db.query("select 1 from app_user where id = $1::uuid", [claims.sub]);
    if (!u) return jsonError(401, "no such account");
    return json(200, {
      id: claims.sub,
      handle: claims.handle,
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    });
  }

  /** A guest's token taken up as this device's session, while it is still a
   * guest and this browser holds no session: one minted ahead of the reader,
   * and one an earlier release kept in a tab's sessionStorage, from before
   * sessions said how they were signed in (`guest: true`). */
  async function adopt(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== cfg.origin(req)) return jsonError(403, "another origin");
    if (await device.hasSession(req)) return jsonError(409, "a session is here");
    const subject = await subjectOf(req);
    if (subject === "refused" || subject.claims === null) return jsonError(401, "invalid token");
    const claims = subject.claims;
    const earlier = claims.guest === true && claims.acr === undefined;
    if (!earlier && !isGuest(claims)) return jsonError(400, "no guest's token");
    const id = claims.sub as string;
    const user = await db.tx(async (q) => {
      if (!(await stillGuest(q, id))) return null;
      const [u] = await q("select handle from app_user where id = $1::uuid", [id]);
      return u ? { id, handle: u.handle as string } : null;
    });
    if (user === null) return jsonError(409, "already an account");
    const proof = earlier ? guestProof(now()) : proofOf(claims);
    const way: Way = { kind: "guest" };
    return json(200, { token: await issueUserToken(user, proof), user: { ...user, guest: true } }, await device.signedIn(req, id, way, proof));
  }

  // --- Native tickets -----------------------------------------------------

  const tickets: Tickets = {
    async issue(t) {
      await db.tx(async (q) => {
        await q("delete from mecha_auth.auth_native_ticket where expires_at <= now()");
        await q(
          `insert into mecha_auth.auth_native_ticket (id, user_id, provider, issuer, sub, code_challenge, proof, held, expires_at)
             values ($1, $2::uuid, $3, $4, $5, $6, $7::text::jsonb, $8, now() + make_interval(secs => $9))`,
          [t.id, t.userId, t.provider, t.issuer, t.sub, t.codeChallenge, JSON.stringify(t.proof), t.held, t.ttlSeconds],
        );
      });
    },
    async consume(id) {
      const [row] = await db.query(
        `delete from mecha_auth.auth_native_ticket where id = $1 and expires_at > now()
           returning user_id, provider, issuer, sub, code_challenge, proof, held`,
        [id],
      );
      if (!row || row.proof === null || row.sub === null) return null;
      return {
        userId: row.user_id as string,
        provider: row.provider as string,
        issuer: row.issuer as string,
        sub: row.sub as string,
        codeChallenge: row.code_challenge as string,
        proof: row.proof as Proof,
        held: row.held as boolean,
      };
    },
  };

  const providerSignIn = oidc({
    secret,
    origin: cfg.origin,
    providers: cfg.providers,
    links,
    device,
    issue: nativeSession,
    tickets,
    nativeSchemes: cfg.nativeSchemes,
    fetcher: cfg.fetcher,
    adding,
  });

  const routes: Record<string, (req: Request) => Promise<Response>> = {
    "POST /auth/register/start": registerStart,
    "POST /auth/register/verify": registerVerify,
    "POST /auth/login/start": loginStart,
    "POST /auth/login/verify": loginVerify,
    "POST /auth/guest": guest,
    "POST /auth/rename": rename,
    "POST /auth/refresh": refresh,
    "POST /auth/session/adopt": adopt,
    "DELETE /auth/account": deleteAccount,
    "GET /auth/whoami": whoami,
    "POST /auth/ways": ways,
    "POST /auth/ways/remove": removeWay,
    "POST /auth/ways/later": later,
    "POST /auth/ways/passkey": addPasskeyStart,
    "POST /auth/ways/passkey/verify": addPasskeyVerify,
  };

  return {
    links,
    tickets,
    issueUserToken,
    subjectOf,
    /** An auth route's answer, or null for a path that is none of them. */
    route(req: Request): Promise<Response> | null {
      const signedIn = providerSignIn(req) ?? device.route(req);
      if (signedIn !== null) return signedIn;
      const key = `${req.method} ${new URL(req.url).pathname}`;
      return Object.hasOwn(routes, key) ? routes[key](req) : null;
    },
  };
}

/** A counter that did not climb: the transaction's challenge is not spent. */
class CounterBehind extends Error {}
