// The sweep: every schedule that is due gets a row, a pure function of
// (schedule, now, done) — due.ts — written through a Crud and paid for by a
// wake. What this file adds is the ordering that lets a pass die anywhere and
// converge on the next poke. The container tier's shell around it is main.ts;
// the edge's is mecha-edge's clock.ts, where the clock is the object's alarm.
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
