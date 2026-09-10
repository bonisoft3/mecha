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
 * A checked call to PostgREST: a non-2xx is an error, never a value.
 *
 * The ticker holds no DATABASE_URL. It writes on the same wire the scheduled
 * pipelines use, and it talks to PostgREST directly rather than through the
 * proxy, whose client-facing Prefer injection would clobber the resolution
 * below.
 */
export type Crud = (
  method: string,
  path: string,
  opts?: { body?: unknown; prefer?: string },
) => Promise<Record<string, unknown>[]>;

/** Absorb a redelivery instead of failing on it. Resolves against the primary
 * key, which is why the tick's key is the row's key. */
const ABSORB = "return=representation,resolution=ignore-duplicates";

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

// mecha's own namespace for tick keys. Fixed forever: changing it would make
// every schedule owe its whole history again.
const TICK_NAMESPACE = "ae72b8e0-46f3-4bba-907c-646629b08839";

/** RFC 4122 name-based UUIDv5, on the platform's own SHA-1. */
export async function uuid5(namespace: string, name: string): Promise<string> {
  const ns = Uint8Array.from(
    namespace.replaceAll("-", "").match(/../g)!.map((h) => parseInt(h, 16)),
  );
  const bytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + bytes.length);
  input.set(ns);
  input.set(bytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The key of a tick, and therefore of the row it emits.
 *
 * Derived rather than random so that a redelivery, a second clock and a
 * retried sweep all write the same row. `tick_at` is normalised first because
 * it arrives from two places — computed here as `…Z`, read back from Postgres
 * as `…+00:00` — and the two must hash alike.
 */
export function tickId(schedule: string, tickAt: string): Promise<string> {
  return uuid5(TICK_NAMESPACE, `${schedule}\n${new Date(tickAt).toISOString()}`);
}

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

/** Nothing this service does is worth waiting on longer than this. A hung
 * upstream must fail the poke, not hold the pass open until the caller's own
 * deadline kills it mid-write. */
const CALL_TIMEOUT_MS = 10_000;

/** The real transport. PostgREST answers a write with rows only when asked,
 * and answers a delete with no body at all. */
export function httpCrud(base: string, serviceJwt: string): Crud {
  return async (method, path, opts = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${serviceJwt}`,
        ...(opts.prefer === undefined ? {} : { prefer: opts.prefer }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`crud ${method} ${path}: ${res.status} ${text}`);
    return text === "" ? [] : JSON.parse(text);
  };
}

/** dapr's own readiness, which it answers 204 without consulting the app
 * channel — unlike `/v1.0/healthz`, which reports the app's health and answers
 * 500 when that channel is down. */
export function httpPoke(mesh: string): Poke {
  return async () => {
    const res = await fetch(`${mesh}/v1.0/healthz/outbound`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`poke ${mesh}: ${res.status}`);
  };
}

if (import.meta.main) {
  const CRUD_URL = Deno.env.get("CRUD_URL");
  if (!CRUD_URL) throw new Error("CRUD_URL is required");
  const SERVICE_JWT = Deno.env.get("SERVICE_JWT");
  if (!SERVICE_JWT) throw new Error("SERVICE_JWT is required");
  const MESH_URL = Deno.env.get("MESH_URL");
  if (!MESH_URL) throw new Error("MESH_URL is required");
  Deno.serve(
    { port: 9998 },
    handler(
      httpCrud(CRUD_URL, SERVICE_JWT),
      httpPoke(MESH_URL),
      SERVICE_JWT,
      () => new Date(),
    ),
  );
}
