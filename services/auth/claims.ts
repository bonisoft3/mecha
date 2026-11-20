// A session token's claims, in OpenID Connect's own words: who in `iss` and
// `sub`, how strongly in `acr`, how in `amr` (RFC 8176), and when in
// `auth_time`. One builder for the auth service and the edge cluster, so the
// two never disagree on what a session says.

/** How a session was signed in. Renewing a session keeps it. `auth_time` is
 * there only when the sign-in is known to have happened then. */
export type Proof = { acr?: string; amr?: string[]; auth_time?: number };

/** OpenID Connect Core's level 0, "no confidence that the same person is
 * actually there": a guest, a token on one device and nothing behind it. */
export const GUEST_ACR = "0";

export const guestProof = (now: number): Proof => ({ acr: GUEST_ACR, auth_time: now });

/** A passkey is phishing-resistant (OpenID EAP ACR Values `phr`) and a proof
 * of possession of its key (`pop`); where the person unlocked it (its
 * user-verified flag), the passkey and that unlock are two factors, `mfa`.
 * Where its key lives is unattested, so neither `hwk` nor `swk` is claimed. */
export const passkeyProof = (userVerified: boolean, now: number): Proof =>
  ({ acr: "phr", amr: ["pop", ...(userVerified ? ["mfa"] : [])], auth_time: now });

/** A provider's sign-in, as strong as the provider says it was and no
 * stronger: its `acr` and `amr` passed through, its `auth_time` only when it
 * gives one — a provider session reused is no fresh sign-in. */
export function providerProof(id: Record<string, unknown>, now: number): Proof {
  const amr = Array.isArray(id.amr) && id.amr.every((m) => typeof m === "string") ? id.amr as string[] : undefined;
  return {
    ...(typeof id.acr === "string" && id.acr !== GUEST_ACR ? { acr: id.acr } : {}),
    ...(amr ? { amr } : {}),
    ...(typeof id.auth_time === "number" && id.auth_time <= now ? { auth_time: id.auth_time } : {}),
  };
}

/** Whether a session's claims are a guest's. */
export const isGuest = (claims: Record<string, unknown>) => claims.acr === GUEST_ACR;

export type Person = { id: string; handle: string; name?: string | null; email?: string | null };

/** A proof as the claims that carry it. */
export const proofClaims = (proof: Proof): Record<string, unknown> => ({
  ...(proof.acr ? { acr: proof.acr } : {}),
  ...(proof.amr ? { amr: proof.amr } : {}),
  ...(proof.auth_time !== undefined ? { auth_time: proof.auth_time } : {}),
});

/** A session's claims. */
export function sessionClaims(iss: string, user: Person, proof: Proof, exp: number): Record<string, unknown> {
  return {
    role: "app_user",
    iss,
    sub: user.id,
    handle: user.handle,
    ...proofClaims(proof),
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    exp,
  };
}

/** The proof claims carry, to renew a session or a cookie with. */
export function proofOf(claims: Record<string, unknown>): Proof {
  return {
    ...(typeof claims.acr === "string" ? { acr: claims.acr } : {}),
    ...(Array.isArray(claims.amr) ? { amr: claims.amr as string[] } : {}),
    ...(typeof claims.auth_time === "number" ? { auth_time: claims.auth_time } : {}),
  };
}
