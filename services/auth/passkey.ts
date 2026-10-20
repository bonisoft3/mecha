// Passkey ceremonies: WebAuthn registration and authentication with a
// discoverable credential, usernameless by doctrine — no identifier is ever
// collected. The challenge travels in a short-lived state JWT rather than a
// server-side session. With no session, registering makes a new account; a
// guest's session registers the guest's own first passkey, keeping its handle
// and every row it wrote. Signing in names the account by the credential.
//
// Pure but for what Config hands it — the relying party, the origin, where
// credentials are kept — so the auth service runs it over Postgres (main.ts)
// and the edge cluster over PGlite (packages/mecha-edge), one ceremony on
// either tier.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { signJwt, verifyJwt } from "./jwt.ts";

const STATE_TTL_S = 300;

export type Credential = { id: string; publicKey: Uint8Array; counter: number };
export type User = { id: string; handle: string };

/** What the ceremonies need of the database. */
export interface Credentials {
  /** The account and its first passkey, together; false when the handle (or
   * the credential) is taken, so the ceremony tries another handle. */
  create(user: User, credential: Credential): Promise<boolean>;
  /** The guest's first passkey; false when the account already has one. */
  promote(userId: string, credential: Credential): Promise<boolean>;
  /** A passkey and the account it signs into. */
  find(id: string): Promise<(Credential & { userId: string; handle: string }) | null>;
  /** The signature counter the authenticator last reported. */
  count(id: string, counter: number): Promise<void>;
}

export type Config = {
  secret: string;
  /** The relying party: the domain a passkey belongs to. */
  rpId: string;
  /** The origin this request's ceremony must have been made on. */
  origin: (req: Request) => string;
  credentials: Credentials;
  /** A new account's display handle. */
  handle: () => string;
  issue: (user: User) => Promise<string>;
};

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string) => json(status, { error });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

/** The routes under /auth/register and /auth/login, or null for a path that
 * is not one of them. */
export function passkey(cfg: Config): (req: Request) => Promise<Response> | null {
  const { secret, rpId } = cfg;

  /** No session, a session, or a bearer that is not one. */
  async function subjectOf(req: Request): Promise<{ claims: Record<string, unknown> | null } | "refused"> {
    const auth = req.headers.get("authorization");
    if (!auth) return { claims: null };
    const claims = auth.startsWith("Bearer ") ? await verifyJwt(secret, auth.slice("Bearer ".length)) : null;
    if (!claims || claims.role !== "app_user") return "refused";
    return { claims };
  }

  async function readState(body: Record<string, unknown>, purpose: string): Promise<Record<string, unknown> | null> {
    if (typeof body.state !== "string") return null;
    const st = await verifyJwt(secret, body.state);
    if (!st || st.purpose !== purpose) return null;
    return st;
  }

  async function registerStart(req: Request): Promise<Response> {
    const subject = await subjectOf(req);
    if (subject === "refused") return refuse(401, "invalid token");
    const claims = subject.claims;
    // Only a guest is promoted, keeping its handle and every row it wrote: a
    // passkey added to an account on the strength of a bearer token would
    // outlive the token and its sign-out. With no session, a new identity.
    if (claims !== null && claims.guest !== true) return refuse(409, "already an account");
    const promote = claims !== null;
    const handle = claims ? claims.handle as string : cfg.handle();
    const userId = claims ? claims.sub as string : crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpName: rpId,
      rpID: rpId,
      userName: handle,
      userID: enc.encode(userId),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
    });
    const state = await signJwt(secret, {
      purpose: "register",
      handle,
      userId,
      promote,
      challenge: options.challenge,
      exp: now() + STATE_TTL_S,
    });
    return json(200, { ...options, state });
  }

  async function registerVerify(req: Request): Promise<Response> {
    const body = await readBody(req);
    if (!body) return refuse(400, "invalid json body");
    const st = await readState(body, "register");
    if (!st) return refuse(401, "invalid state");
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: cfg.origin(req),
        expectedRPID: rpId,
        requireUserVerification: false,
      });
    } catch {
      return refuse(401, "registration verification failed");
    }
    if (!verification.verified || !verification.registrationInfo) {
      return refuse(401, "registration verification failed");
    }
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const credential = { id: credentialID, publicKey: credentialPublicKey, counter };
    const userId = st.userId as string;
    if (st.promote === true) {
      // The guest becomes an account once: a guest token that outlives its
      // promotion is still a guest's, and adds no second way in.
      if (!(await cfg.credentials.promote(userId, credential))) return refuse(409, "already an account");
      const user = { id: userId, handle: st.handle as string };
      return json(200, { token: await cfg.issue(user), user });
    }
    // Generated handles can collide; regenerate and retry — never a user error.
    let handle = st.handle as string;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await cfg.credentials.create({ id: userId, handle }, credential)) {
        const user = { id: userId, handle };
        return json(200, { token: await cfg.issue(user), user });
      }
      handle = cfg.handle();
    }
    return refuse(500, "could not allocate identity");
  }

  async function loginStart(): Promise<Response> {
    // Discoverable credentials: the authenticator offers the resident passkey.
    const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: [] });
    const state = await signJwt(secret, { purpose: "login", challenge: options.challenge, exp: now() + STATE_TTL_S });
    return json(200, { ...options, state });
  }

  async function loginVerify(req: Request): Promise<Response> {
    const body = await readBody(req);
    if (!body) return refuse(400, "invalid json body");
    const st = await readState(body, "login");
    if (!st) return refuse(401, "invalid state");
    const response = body.response as { id?: string } | undefined;
    if (!response || typeof response.id !== "string") return refuse(401, "authentication verification failed");
    // The credential identifies the user (resident key).
    const cred = await cfg.credentials.find(response.id);
    if (cred === null) return refuse(401, "authentication verification failed");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: cfg.origin(req),
        expectedRPID: rpId,
        requireUserVerification: false,
        authenticator: { credentialID: cred.id, credentialPublicKey: cred.publicKey, counter: cred.counter },
      });
    } catch {
      return refuse(401, "authentication verification failed");
    }
    if (!verification.verified) return refuse(401, "authentication verification failed");
    await cfg.credentials.count(cred.id, verification.authenticationInfo.newCounter);
    const user = { id: cred.userId, handle: cred.handle };
    return json(200, { token: await cfg.issue(user), user });
  }

  return (req) => {
    if (req.method !== "POST") return null;
    switch (new URL(req.url).pathname) {
      case "/auth/register/start": return registerStart(req);
      case "/auth/register/verify": return registerVerify(req);
      case "/auth/login/start": return loginStart();
      case "/auth/login/verify": return loginVerify(req);
      default: return null;
    }
  };
}
