// The device's session: one account per browser, kept in an HttpOnly cookie
// whatever way it came in by — a passkey, a provider, a guest's mint — so a
// tab whose bearer expired, or whose storage was cleared, takes it up again
// at POST /auth/session without a second ceremony. The cookie is never
// renewed, so it lasts from the sign-in that set it (`since`), which is also
// how recent a sign-in adding or removing a way stands on; every exchange
// asks again whether the way still stands (`still`), so a passkey or a link
// removed, or a guest promoted, is a session ended. Only a request from the
// door's own origin is given a cookie: a page elsewhere may still sign in for
// a token, never replace this browser's session.
//
// An account a sign-in found while another was this device's waits in its own
// cookie, for the reader to take at /auth/session/switch or leave at
// /auth/session/stay: OpenID Connect's `login_required`, never a merge. Each
// such offer has an id the choice must name, so one tab cannot take or drop
// the offer another tab is showing. A readable hint cookie says a session may
// be there.
import { type Proof, proofClaims, proofOf } from "./claims.ts";
import { randomToken, signJwt, verifyJwt } from "./jwt.ts";

export const SESSION_COOKIE = "__Host-mecha_session";
export const HELD_COOKIE = "__Host-mecha_session_held";
export const HINT_COOKIE = "mecha_session_hint";
const PATH = "/auth";
const SESSION_TTL_S = 30 * 24 * 3600;
const HELD_TTL_S = 300;

/** How a session came in, which must still stand for it to be taken up. */
export type Way =
  | { kind: "passkey"; credential: string }
  /** The subject too: a link removed and another of the provider added in
   * its place is no way back for the removed subject's sessions. */
  | { kind: "provider"; provider: string; issuer: string; sub: string }
  | { kind: "guest" };

/** The person as the app shows them. */
export type User = { id: string; handle: string; name?: string | null; email?: string | null; guest?: boolean };

export type DeviceConfig = {
  secret: string;
  /** The door this request came through. */
  origin: (req: Request) => string;
  /** The account `sub` while `way` still signs it in, or null. */
  still: (way: Way, sub: string) => Promise<User | null>;
  issue: (user: User, proof: Proof) => Promise<string>;
};

/** An account held for the reader, and the id their choice must name. */
export type Offer = { cookies: string[]; offer: string };

export type Device = {
  /** The cookies that make `sub`, signed in by `way` as `proof` says, this device's session. */
  signedIn: (req: Request, sub: string, way: Way, proof: Proof) => Promise<string[]>;
  /** The cookies that hold `sub` for the reader to take or leave, and the offer's id. */
  held: (req: Request, sub: string, way: Way, proof: Proof) => Promise<Offer>;
  /** The cookies that leave this device with no session and nothing held. */
  signedOut: (req: Request) => string[];
  /** This device's own session while its way stands, and when it was signed
   * in (null for a cookie from before that was kept). */
  current: (req: Request) => Promise<{ user: User; way: Way; since: number | null } | null>;
  hasSession: (req: Request) => Promise<boolean>;
  /** The routes under /auth/session and /auth/signout, or null for any other. */
  route: (req: Request) => Promise<Response> | null;
};

const now = () => Math.floor(Date.now() / 1000);

export function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.replace(/^[ \t]+|[ \t]+$/g, "").split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

const reply = (status: number, body: unknown, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
};
const refuse = (status: number, error: string) => reply(status, { error });

export function deviceSession(cfg: DeviceConfig): Device {
  const https = (req: Request) => cfg.origin(req).startsWith("https://");
  const secure = (req: Request) => https(req) ? "; Secure" : "";
  const nameOf = (req: Request, name: string) => https(req) ? name : name.replace(/^__Host-/, "");
  const read = (req: Request, name: string) => cookieOf(req, nameOf(req, name));
  const cookie = (req: Request, name: string, value: string, age: number) =>
    `${nameOf(req, name)}=${value}; Path=${https(req) ? "/" : PATH}; HttpOnly; SameSite=Lax${secure(req)}; Max-Age=${age}`;
  const hint = (req: Request, age: number) => `${HINT_COOKIE}=${age > 0 ? "1" : ""}; Path=/; SameSite=Lax${secure(req)}; Max-Age=${age}`;
  // A cross-site POST carries no Lax cookie but still receives one, so the
  // Origin a browser sends is checked besides.
  const foreign = (req: Request) => {
    const origin = req.headers.get("origin");
    return origin !== null && origin !== cfg.origin(req);
  };

  async function signedIn(req: Request, sub: string, way: Way, proof: Proof): Promise<string[]> {
    if (foreign(req)) return [];
    const exp = now() + SESSION_TTL_S;
    const claims = { purpose: "device-session", sub, way, since: now(), ...proofClaims(proof), exp };
    return [
      cookie(req, SESSION_COOKIE, await signJwt(cfg.secret, claims), SESSION_TTL_S),
      hint(req, SESSION_TTL_S),
      cookie(req, HELD_COOKIE, "", 0),
    ];
  }

  async function held(req: Request, sub: string, way: Way, proof: Proof): Promise<Offer> {
    const offer = randomToken(16);
    if (foreign(req)) return { cookies: [], offer };
    const claims = { purpose: "device-held", sub, way, offer, ...proofClaims(proof), exp: now() + HELD_TTL_S };
    return { cookies: [cookie(req, HELD_COOKIE, await signJwt(cfg.secret, claims), HELD_TTL_S)], offer };
  }

  /** A cookie's account, its way, proof and offer, while the way still stands. */
  async function standing(raw: string | null, purpose: string) {
    const c = raw === null ? null : await verifyJwt(cfg.secret, raw);
    if (c === null || c.purpose !== purpose || typeof c.sub !== "string") return null;
    const way = c.way as Way;
    if (typeof way !== "object" || way === null) return null;
    const user = await cfg.still(way, c.sub);
    if (user === null) return null;
    return {
      user,
      way,
      proof: proofOf(c),
      offer: typeof c.offer === "string" ? c.offer : null,
      since: typeof c.since === "number" ? c.since : null,
    };
  }

  const answer = async (user: User, proof: Proof, cookies: string[] = []) =>
    reply(200, { token: await cfg.issue(user, proof), user }, cookies);
  const offered = (user: User, offer: string | null) =>
    reply(409, { error: "login_required", user: { handle: user.handle, ...(user.name ? { name: user.name } : {}) }, offer });
  const cleared = (req: Request, names: string[]) => [
    ...names.map((name) => cookie(req, name, "", 0)),
    ...(names.includes(SESSION_COOKIE) ? [hint(req, 0)] : []),
  ];
  const clearing = (req: Request, names: string[]) => {
    const headers = new Headers({ "cache-control": "no-store" });
    for (const c of cleared(req, names)) headers.append("set-cookie", c);
    return new Response(null, { status: 204, headers });
  };

  // The cookie as this tab's session. An account held for the reader comes
  // first, since the device's own session is what it would leave.
  async function session(req: Request): Promise<Response> {
    const taken = await standing(read(req, HELD_COOKIE), "device-held");
    if (taken !== null) return offered(taken.user, taken.offer);
    const own = await standing(read(req, SESSION_COOKIE), "device-session");
    if (own !== null) return await answer(own.user, own.proof);
    return refuse(401, "not signed in");
  }

  /** The offer this choice names, or the answer to give instead: nothing
   * held, or a newer offer for the tab to show. */
  async function chosen(req: Request) {
    const taken = await standing(read(req, HELD_COOKIE), "device-held");
    if (taken === null) return refuse(401, "nothing held");
    let named: unknown = null;
    try {
      named = (await req.json() as { offer?: unknown }).offer;
    } catch {
      return refuse(400, "offer required");
    }
    return named === taken.offer ? taken : offered(taken.user, taken.offer);
  }

  // The held account taken: the device's session from now on.
  async function take(req: Request): Promise<Response> {
    const taken = await chosen(req);
    if (taken instanceof Response) return taken;
    return await answer(taken.user, taken.proof, await signedIn(req, taken.user.id, taken.way, taken.proof));
  }

  async function stay(req: Request): Promise<Response> {
    const taken = await chosen(req);
    return taken instanceof Response ? taken : clearing(req, [HELD_COOKIE]);
  }

  return {
    hasSession: async (req) => await standing(read(req, SESSION_COOKIE), "device-session") !== null,
    signedIn,
    held,
    signedOut: (req) => cleared(req, [SESSION_COOKIE, HELD_COOKIE]),
    current: (req) => standing(read(req, SESSION_COOKIE), "device-session"),
    route(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST") return null;
      const routes: Record<string, () => Promise<Response> | Response> = {
        [`${PATH}/session`]: () => session(req),
        [`${PATH}/session/switch`]: () => take(req),
        [`${PATH}/session/stay`]: () => stay(req),
        [`${PATH}/signout`]: () => clearing(req, [SESSION_COOKIE, HELD_COOKIE]),
      };
      if (!Object.hasOwn(routes, path)) return null;
      if (foreign(req)) return Promise.resolve(refuse(403, "another origin"));
      return Promise.resolve(routes[path]());
    },
  };
}
