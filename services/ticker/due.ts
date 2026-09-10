// When a schedule is due, as a pure function.
//
// Everything hard about a periodic wake lives here: the calendar, the zone,
// the two nights a year a wall clock lies, and the rule that a tick too late
// to matter is not run. It takes no clock of its own and touches no network,
// so the cases below are unit tests rather than a thing you wait for.

import { Cron } from "croner";

export type Schedule = {
  name: string;
  cron: string;
  time_zone: string;
  max_lateness_seconds: number;
  /** The watermark: the last tick this schedule is known to have resolved. */
  last_tick_at: string | null;
};

export type Tick = {
  schedule: string;
  /** The scheduled instant, never the instant anything noticed. */
  tick_at: string;
  /** Past its lateness budget: recorded so a chronically late clock is
   * visible, and not run, because the moment it was defending has passed. */
  late: boolean;
};

/** The backstop for a pathological expression, when the caller names no
 * smaller cap of its own. */
const WALK_CAP = 512;

/**
 * One five-field cron field against one value: a comma list of `*`, `n` or
 * `a-b`, each optionally carrying a `/step` suffix. A wrapping range is
 * refused rather than silently matching nothing, which would make a schedule
 * that never fires look healthy.
 *
 * A bare `n` means the single value n, but `n/step` means n to the end of the
 * field — `5/10` in minutes is 5, 15, 25 … 55, not 5 alone. Reading it as a
 * single value is silent tick loss of precisely the kind this whole file
 * exists to refuse: croner emits every one of them and the gap check throws
 * all but the first away.
 */
function admits(field: string, value: number, first: number, last: number): boolean {
  return field.split(",").some((term) => {
    const [spec, stepText] = term.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: bad step in "${term}"`);
    let lo = first, hi = last;
    if (spec !== "*") {
      const dash = spec.indexOf("-");
      lo = Number(dash === -1 ? spec : spec.slice(0, dash));
      hi = dash === -1 ? (stepText === undefined ? lo : last) : Number(spec.slice(dash + 1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`cron: bad range "${term}"`);
      }
      if (lo > hi) throw new Error(`cron: wrapping range "${term}"`);
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/**
 * Whether an instant sits on a wall clock its expression actually names.
 *
 * croner yields the next instant its arithmetic produces, and on the night a
 * zone loses an hour that arithmetic lands somewhere the calendar does not
 * have: `30 2 * * *` in America/New_York on 2026-03-08 comes back as 03:30
 * local. Shifting a nightly close by an hour is exactly the silent move this
 * primitive refuses.
 *
 * Asking membership rather than equality is what makes the check hold for
 * every expression and not only for a bare `30 2`: under `30 2,4 * * *` the
 * shifted 03:30 is rejected because 3 is not in {2,4}, while under `30 * * * *`
 * it is admitted, correctly — that expression names 03:30 too, and the hour it
 * lost simply does not happen.
 *
 * A DST shift is never less than the half hour Lord Howe moves, so minute and
 * hour together catch every one of them.
 */
function onTheWallClock(minute: string, hour: string, at: Date, zone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const local = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return admits(minute, local("minute"), 0, 59) && admits(hour, local("hour"), 0, 23);
}

/**
 * The ticks a schedule owes at `now`, oldest first.
 *
 * Two spans, deliberately different. Everything older than the lateness
 * horizon is unrunnable by definition; rather than enumerate a night of it in
 * one answer, the first tick the schedule missed is returned marked `late`, so
 * the tick table shows that a span was lost instead of showing nothing. That
 * is one entry per call, not one per outage: a sparse schedule drains a long
 * gap across pokes, an occurrence at a time. From the horizon forward every
 * tick is runnable and each is returned.
 *
 * A schedule with no watermark starts at the horizon: one declared today does
 * not owe the whole of history.
 */
/**
 * `cap` is the caller's own budget, and walking past it is pure waste: every
 * step costs a `nextRun` and an `Intl.DateTimeFormat`, and the caller slices
 * the surplus away. One extra is walked so `behind` can still be answered
 * without walking the whole backlog to count it.
 */
export function due(s: Schedule, now: Date, cap: number = WALK_CAP): Tick[] {
  const fields = s.cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`${s.name}: five-field cron required, got "${s.cron}"`);
  }
  const [minute, hour] = fields;
  const horizon = new Date(now.getTime() - s.max_lateness_seconds * 1000);
  const mark = s.last_tick_at === null ? null : new Date(s.last_tick_at);
  const cron = new Cron(s.cron, { timezone: s.time_zone });
  const out: Tick[] = [];

  let start = horizon;
  if (mark !== null && mark >= horizon) {
    start = mark;
  } else if (mark !== null) {
    // One call, not a walk: the span is recorded, not replayed. The gap check
    // binds here too — an instant the calendar never had was not missed, it
    // did not happen, and recording it would put a wall time on the app's
    // table that the expression never names.
    const missed = cron.nextRun(mark);
    if (
      missed !== null && missed < horizon &&
      onTheWallClock(minute, hour, missed, s.time_zone)
    ) {
      out.push({ schedule: s.name, tick_at: missed.toISOString(), late: true });
    }
  }

  let cursor = start;
  const walk = Math.min(cap + 1, WALK_CAP);
  for (let i = 0; i < walk; i++) {
    const next = cron.nextRun(cursor);
    if (next === null || next > now) break;
    cursor = next;
    if (!onTheWallClock(minute, hour, next, s.time_zone)) continue;
    out.push({ schedule: s.name, tick_at: next.toISOString(), late: false });
  }
  return out;
}

/**
 * The watermark a sweep leaves behind after resolving `resolved`.
 *
 * A late tick still advances it: it was decided, and leaving it behind would
 * make the same unrunnable tick due again on every poke forever. A tick held
 * back by concurrency does NOT advance it, which is what makes Forbid a delay
 * rather than a drop — so the caller passes only what it actually resolved,
 * in order, and stops at the first one it declined.
 */
export function watermark(resolved: Tick[], previous: string | null): string | null {
  return resolved.length === 0 ? previous : resolved[resolved.length - 1].tick_at;
}
