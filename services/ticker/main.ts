// Ticker: a poke arrives carrying nothing, and every schedule that is due
// gets a row.
//
// The clock is deliberately stupid. Due-ness is a pure function of
// (schedule, now, done) — due.ts — so a lost poke costs nothing, a coarse
// poke costs only resolution, and two clocks poking at once cost nothing
// either. What this file adds is the shell: reading the schedules, writing
// through crud, and the ordering that lets a pass die anywhere and converge on
// the next poke.
//
// A tick IS the app's row — one write, not a demand plus a private ledger
// beside it. Answering it belongs to a CDC pipeline reading that row, and the
// answer lands somewhere else again, because a source cannot be its own sink.
// The one thing this file does past writing the row is knock on the door of
// the unit that reads the WAL: at cloud tier that unit is asleep, and a row
// nobody reads is not a tick.

import { due, type Schedule, type Tick, watermark } from "./due.ts";
import { tickId } from "./tick-id.ts";
import { ABSORB, type Crud } from "./crud.ts";
export type { Crud } from "./crud.ts";

/** A schedule as it is stored: due.ts's fields plus the ones only the shell
 * reads. Seeded by a migration from the app's declarations; never written by
 * an app, and written here only to advance the watermark. */
export type ScheduleRow = Schedule & {
  suspended: boolean;
  concurrency_policy: "Allow" | "Forbid";
  /**
   * Where a tick is answered, and the filter that says it was.
   *
   * Never `emits_entity` — the pipeline cannot answer into the table it read;
   * `#Schedule` states why. Required by Forbid, which is this layer's only
   * question about work it cannot see.
   */
  done_entity: string | null;
  done_filter: string | null;
  /** The app entity a tick becomes a row in. Mecha owns five of its columns
   * (see sweepOne); the rest is whatever the schedule declares. */
  emits_entity: string;
  emits_values: Record<string, unknown>;
};

/**
 * The most ticks one poke resolves for one schedule.
 *
 * A tick costs one round trip, three under Forbid, so an unbounded schedule
 * behind a wide lateness budget would walk a night of them in one pass. Bounded,
 * it drains across pokes instead.
 *
 * This bounds ONE schedule, not the pass. A poke's own deadline — Cloud
 * Scheduler's is 180s — is a budget over every schedule together, and nothing
 * here holds it: N backed-up schedules cost N times this, sequentially, and a
 * pass killed at the deadline commits no watermark at all and repeats itself.
 * Closing that needs a budget across the sweep or a watermark committed per
 * schedule, and the second trades away the wake-before-commit ordering.
 */
const TICKS_PER_SWEEP = 64;

export type ScheduleReport = {
  schedule: string;
  emitted: number;
  late: number;
  /** Ticks the concurrency policy declined to emit. They stay due. */
  held: number;
  /** The schedule owes more than one poke resolves. It drains on the next. */
  behind: boolean;
  error?: string;
};

export type Report = {
  at: string;
  caller: string | null;
  schedules: ScheduleReport[];
  /** Absent when the sweep emitted nothing: a wake nobody needs is a billed
   * cold start on a unit that holds its CPU. */
  poke?: { ok: boolean; error?: string };
};

/**
 * The wake: a request to the mesh unit whose only purpose is to exist.
 *
 * Above container tier daprd, the WAL reader and the pipeline worker are three
 * containers of one instance that scales to zero, and only daprd holds the
 * ingress — so a request to daprd is what starts the other two. Nothing is
 * published: the message that travels the path is the row conduit is about to
 * find in the WAL, and there is exactly one delivery route.
 */
export type Poke = () => Promise<void>;

/** What one schedule's pass produced, before any of it is paid for. */
type Swept = {
  row: ScheduleRow;
  report: ScheduleReport;
  /** The watermark this pass earned. Equal to the row's own when it earned
   * nothing, which is how the commit below knows to skip it. */
  mark: string | null;
};

/**
 * One sweep: every unsuspended schedule, in whatever order crud returns them.
 * One app's broken filter is not a reason to stop the clock, so a schedule
 * that fails is reported and the others still run.
 *
 * Three phases, and the order across them is the guarantee: every schedule
 * writes its ticks, then one wake covers all of them, then the watermarks
 * move. Nothing is paid for until the wake lands, and a poke that failed
 * anywhere answers 500 — safe, because a retried sweep rewrites the same keys.
 */
export async function sweep(
  now: Date,
  caller: string | null,
  crud: Crud,
  poke: Poke,
): Promise<Report> {
  const schedules = await crud(
    "GET",
    "/schedule?suspended=is.false&select=*",
  ) as unknown as ScheduleRow[];
  const swept: Swept[] = [];
  for (const s of schedules) {
    swept.push(await sweepOne(s, now, caller, crud));
  }
  const report: Report = {
    at: now.toISOString(),
    caller,
    schedules: swept.map((w) => w.report),
  };

  if (report.schedules.some((r) => r.emitted > 0)) {
    try {
      await poke();
      report.poke = { ok: true };
    } catch (e) {
      // No watermark moves. Advancing one here would leave the next poke owing
      // nothing, so nothing would knock again, and the rows just written would
      // wait for whenever some later tick happened to emit. Holding them costs
      // the retry a set of absorbed duplicates and buys the wake.
      report.poke = { ok: false, error: e instanceof Error ? e.message : String(e) };
      return report;
    }
  }

  for (const w of swept) {
    if (w.mark === w.row.last_tick_at) continue;
    try {
      // Monotonic, because two clocks are a supported state and they read the
      // schedule list at different instants: without the guard the slower one
      // writes its older watermark over the faster one's and the next poke
      // recomputes ticks that were already resolved. Absorbed, so never wrong
      // — but a whole sweep's budget spent on rows that already exist.
      await crud(
        "PATCH",
        `/schedule?name=eq.${encodeURIComponent(w.row.name)}` +
          `&or=(last_tick_at.is.null,last_tick_at.lt.${encodeURIComponent(String(w.mark))})`,
        { body: { last_tick_at: w.mark } },
      );
    } catch (e) {
      w.report.error ??= e instanceof Error ? e.message : String(e);
    }
  }
  return report;
}

/**
 * Write the ticks one schedule owes. Nothing here advances a watermark.
 *
 * Dying part-way is ordinary: the ticks that landed are reported as resolved
 * and their watermark is earned, the rest stay owed, and the next poke
 * recomputes them and rewrites the same keys. Reporting a partial pass as a
 * total failure would be worse than the failure — it would strand rows that
 * are already durable on the far side of a wake that never fires.
 */
async function sweepOne(
  s: ScheduleRow,
  now: Date,
  caller: string | null,
  crud: Crud,
): Promise<Swept> {
  const report: ScheduleReport = {
    schedule: s.name,
    emitted: 0,
    late: 0,
    held: 0,
    behind: false,
  };
  const resolved: Tick[] = [];
  try {
    const owed = due(s, now, TICKS_PER_SWEEP);
    const ticks = owed.slice(0, TICKS_PER_SWEEP);
    report.behind = owed.length > TICKS_PER_SWEEP;
    let prevAt = s.last_tick_at;

    for (const tick of ticks) {
      if (!tick.late && s.concurrency_policy === "Forbid") {
        if (!await priorFinished(s, prevAt, crud)) {
          report.held = ticks.length - resolved.length;
          break;
        }
      }
      const id = await tickId(s.name, tick.tick_at);
      await crud("POST", `/${s.emits_entity}`, {
        // Mecha's columns last: a declaration can overwrite none of the key
        // that makes the write idempotent, nor the four fields that make the
        // row a tick rather than an ordinary row of the app's.
        body: {
          ...s.emits_values,
          id,
          schedule: s.name,
          tick_at: tick.tick_at,
          late: tick.late,
          caller,
        },
        prefer: ABSORB,
      });
      resolved.push(tick);
      prevAt = tick.tick_at;
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }

  report.emitted = resolved.filter((t) => !t.late).length;
  report.late = resolved.filter((t) => t.late).length;
  return { row: s, report, mark: watermark(resolved, s.last_tick_at) };
}

/**
 * Whether the previous tick has been answered.
 *
 * Two reads, and the first is not a formality. A late tick is a row like any
 * other, so existence alone does not say whether work was asked for; a late one
 * asked for none, so no outcome is coming. Reading `late` first is what keeps
 * Forbid from holding behind a missed span forever.
 */
async function priorFinished(
  s: ScheduleRow,
  prevAt: string | null,
  crud: Crud,
): Promise<boolean> {
  if (prevAt === null) return true;
  if (s.done_entity === null || s.done_filter === null) {
    throw new Error(`${s.name}: concurrencyPolicy Forbid needs a done entity and filter`);
  }
  const id = await tickId(s.name, prevAt);
  const prior = await crud("GET", `/${s.emits_entity}?id=eq.${id}&select=late`);
  if (prior.length === 0 || prior[0].late === true) return true;
  const done = await crud(
    "GET",
    `/${s.done_entity}?id=eq.${id}&${s.done_filter}&select=id`,
  );
  return done.length > 0;
}

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
