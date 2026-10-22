// Ticker: a poke arrives carrying nothing, and every schedule that is due
// gets a row (sweep.ts).
//
// The clock is deliberately stupid. Due-ness is a pure function of
// (schedule, now, done) — due.ts — so a lost poke costs nothing, a coarse
// poke costs only resolution, and two clocks poking at once cost nothing
// either. What this file adds is the container tier's shell: the poke's
// credential, crud over HTTP, and the wake as a GET to each unit a tick needs.

import type { Crud } from "./crud.ts";
import { type Poke, type Report, sweep } from "./sweep.ts";

/** Equal-length compare that does not leak where two secrets diverge. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * POST /poke — no cadence, no schedule name, no payload. The clock's only job
 * is to make this service exist and ask it to look; what is due is never the
 * caller's business. `?caller=` is a diagnostic label recorded on every tick,
 * so that when two clocks are running you can see which is winning rather
 * than infer it.
 *
 * The poke carries the same SERVICE_JWT as every other write in the cluster,
 * and the ticker holds it anyway: one credential, identical at every tier.
 */
export function handler(
  crud: Crud,
  poke: Poke,
  serviceJwt: string,
  now: () => Date,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/poke") {
      return json(404, { error: "not found" });
    }
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if (!sameSecret(bearer, serviceJwt)) return json(401, { error: "unauthorized" });

    try {
      const report = await sweep(now(), url.searchParams.get("caller"), crud, poke);
      const failed = report.schedules.some((s) => s.error !== undefined) ||
        report.poke?.ok === false;
      return json(failed ? 500 : 200, report);
    } catch (e) {
      // Nothing past the schedule list ran, so there is no report to answer
      // with. The caller retries, and a retried sweep rewrites the same keys.
      console.error(e);
      return json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** How often a call a serialization conflict aborted is sent, and the first
 * pause between sends, doubling. crud reports the conflict as a 500 naming
 * 40001 and leaves running the transaction again to the caller; every call
 * here is idempotent by its key, so sending it again is safe. */
const CONFLICT_SENDS = 5;
const CONFLICT_FIRST_MS = 25;

/** The real transport. PostgREST answers a write with rows only when asked,
 * and answers a delete with no body at all. Each call is bounded past the
 * service role's statement: a call given up on first commits anyway, and the
 * next tick makes it again. */
export function httpCrud(base: string, serviceJwt: string, timeoutMs: number): Crud {
  return async (method, path, opts = {}) => {
    for (let sent = 1; ; sent++) {
      const res = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${serviceJwt}`,
          ...(opts.prefer === undefined ? {} : { prefer: opts.prefer }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      const conflicted = res.status === 500 && text.includes('"code":"40001"');
      if (conflicted && sent < CONFLICT_SENDS) {
        await new Promise((resolve) => setTimeout(resolve, CONFLICT_FIRST_MS * 2 ** (sent - 1)));
        continue;
      }
      if (!res.ok) throw new Error(`crud ${method} ${path}: ${res.status} ${text}`);
      return text === "" ? [] : JSON.parse(text);
    }
  };
}

/** A wake is a health read, answered at once by a unit that is up; it needs
 * none of the time a call to crud can take. */
const WAKE_TIMEOUT_MS = 10_000;

/** One GET to each unit that must exist for a tick to be read: daprd's own
 * readiness (`/v1.0/healthz/outbound`, which it answers 204 without consulting
 * the app channel — unlike `/v1.0/healthz`, which answers 500 until daprd's
 * initialization, blocked on the app channel accepting a connection, is done)
 * and the airlock's `/healthz`. Every one must answer, or the wake failed. */
export function httpPoke(urls: string[], timeoutMs = WAKE_TIMEOUT_MS): Poke {
  return async () => {
    for (const url of urls) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`poke ${url}: ${res.status}`);
    }
  };
}

/** The units a tick wakes, comma-separated. Empty where a tick needs nothing
 * up — a machine timer fires in the database the tick is written to; an empty
 * entry in a list is a typo, refused. */
export function wakeUrls(raw: string): string[] {
  if (raw === "") return [];
  const urls = raw.split(",");
  if (urls.some((url) => url === "")) throw new Error(`WAKE_URLS has an empty entry: "${raw}"`);
  return urls;
}

if (import.meta.main) {
  const CRUD_URL = Deno.env.get("CRUD_URL");
  if (!CRUD_URL) throw new Error("CRUD_URL is required");
  const SERVICE_JWT = Deno.env.get("SERVICE_JWT");
  if (!SERVICE_JWT) throw new Error("SERVICE_JWT is required");
  const WAKE_URLS = Deno.env.get("WAKE_URLS");
  if (WAKE_URLS === undefined) throw new Error("WAKE_URLS is required");
  const CALL_TIMEOUT_MS = Number(Deno.env.get("CALL_TIMEOUT_MS"));
  if (!(CALL_TIMEOUT_MS > 0)) throw new Error(`CALL_TIMEOUT_MS is ${Deno.env.get("CALL_TIMEOUT_MS")}, not milliseconds`);
  Deno.serve(
    { port: 9998 },
    handler(
      httpCrud(CRUD_URL, SERVICE_JWT, CALL_TIMEOUT_MS),
      httpPoke(wakeUrls(WAKE_URLS)),
      SERVICE_JWT,
      () => new Date(),
    ),
  );
}
