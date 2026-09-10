// The cases that decide whether a periodic wake is correct. Every one of them
// is a case some scheduler somewhere gets wrong, so each is pinned here rather
// than left to the library's defaults.

import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { due, type Schedule, watermark } from "./due.ts";

const base: Schedule = {
  name: "keepalive",
  cron: "*/10 * * * *",
  time_zone: "UTC",
  max_lateness_seconds: 300,
  last_tick_at: null,
};

const at = (iso: string) => new Date(iso);

Deno.test("a fresh schedule owes nothing older than its budget", () => {
  // No watermark must not mean "every tick since the epoch". At 12:07 with a
  // five-minute budget the 12:00 tick is already unrunnable, and there is no
  // watermark to say it was ever missed — so a first sweep owes nothing.
  assertEquals(due(base, at("2026-03-01T12:07:00Z")), []);
});

Deno.test("a fresh schedule runs a tick that is inside the budget", () => {
  const ticks = due(base, at("2026-03-01T12:02:00Z"));
  assertEquals(ticks.map((t) => t.tick_at), ["2026-03-01T12:00:00.000Z"]);
  assertEquals(ticks[0].late, false);
});

Deno.test("ticks carry the instant they were scheduled for, not the arrival", () => {
  // A poke 40s late still produces an exact :10, which is what stops a coarse
  // clock from drifting the schedule.
  const ticks = due({ ...base, last_tick_at: "2026-03-01T12:00:00.000Z" }, at("2026-03-01T12:10:40Z"));
  assertEquals(ticks.map((t) => t.tick_at), ["2026-03-01T12:10:00.000Z"]);
  assertEquals(ticks[0].late, false);
});

Deno.test("a tick past its budget is returned marked late, not hidden", () => {
  // The caller records it and moves on. Dropping it silently is how a
  // chronically late clock stays invisible.
  const ticks = due(
    { ...base, max_lateness_seconds: 60, last_tick_at: "2026-03-01T12:00:00.000Z" },
    at("2026-03-01T12:12:00Z"),
  );
  assertEquals(ticks.length, 1);
  assertEquals(ticks[0].tick_at, "2026-03-01T12:10:00.000Z");
  assertEquals(ticks[0].late, true);
});

Deno.test("a long sleep marks the span and resumes at the horizon", () => {
  // Twelve hours of missed ticks are not replayed in one answer: one entry
  // marks the span so the tick table shows it was lost, then the runnable
  // present is offered. A schedule whose walk finds nothing drains such a gap
  // one occurrence per poke.
  const ticks = due(
    { ...base, last_tick_at: "2026-03-01T00:00:00.000Z" },
    at("2026-03-01T12:03:00Z"),
  );
  assertEquals(ticks.map((t) => [t.tick_at, t.late]), [
    ["2026-03-01T00:10:00.000Z", true],
    ["2026-03-01T12:00:00.000Z", false],
  ]);
});

Deno.test("catch-up inside the budget yields every missed tick, oldest first", () => {
  const ticks = due(
    { ...base, max_lateness_seconds: 3600, last_tick_at: "2026-03-01T12:00:00.000Z" },
    at("2026-03-01T12:35:00Z"),
  );
  assertEquals(ticks.map((t) => t.tick_at), [
    "2026-03-01T12:10:00.000Z",
    "2026-03-01T12:20:00.000Z",
    "2026-03-01T12:30:00.000Z",
  ]);
});

Deno.test("an hour the calendar skips is never due {spring forward}", () => {
  // 2026-03-08, America/New_York: 02:00 jumps to 03:00. An expression pinning
  // 02:30 has no instant that night, so it is not due and there is nothing to
  // record — the hazard is an implementation that projects the time instead of
  // asking the calendar, and then runs it an hour late.
  const s: Schedule = {
    name: "nightly",
    cron: "30 2 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 6 * 3600,
    last_tick_at: "2026-03-08T00:00:00.000Z",
  };
  const ticks = due(s, at("2026-03-08T12:00:00Z"));
  assertEquals(ticks.length, 0, `expected no tick on the skipped hour, got ${JSON.stringify(ticks)}`);
});

Deno.test("the skipped hour is refused on the late path too {spring forward}", () => {
  // The test above puts the missed tick inside the budget, so only the walk
  // ever sees it. With a budget narrow enough to push it past the horizon the
  // late branch answers instead, and it must reach the same verdict: croner
  // projects the absent 02:30 onto 03:30, an instant `30 2 * * *` never names.
  const s: Schedule = {
    name: "nightly",
    cron: "30 2 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 3600,
    last_tick_at: "2026-03-07T07:30:00.000Z",
  };
  assertEquals(
    due(s, at("2026-03-08T12:00:00Z")),
    [],
    "a wall time the expression never names must not be recorded as a missed tick",
  );
});

Deno.test("an hour the calendar repeats fires once {fall back}", () => {
  // 2026-11-01, America/New_York: 01:30 happens at 05:30Z and again at 06:30Z.
  // Both are legitimate distinct instants, so firing twice is what a naive
  // implementation does. One tick, the earlier.
  const s: Schedule = {
    name: "nightly",
    cron: "30 1 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 12 * 3600,
    last_tick_at: "2026-11-01T00:00:00.000Z",
  };
  const ticks = due(s, at("2026-11-01T12:00:00Z"));
  assertEquals(ticks.length, 1, `expected one tick across the repeated hour, got ${JSON.stringify(ticks)}`);
  assertEquals(ticks[0].tick_at, "2026-11-01T05:30:00.000Z");
});

Deno.test("a zone is a zone: the same expression fires at a different instant", () => {
  const utc = due(
    { name: "n", cron: "0 3 * * *", time_zone: "UTC", max_lateness_seconds: 86400, last_tick_at: "2026-06-01T00:00:00.000Z" },
    at("2026-06-01T23:00:00Z"),
  );
  const sp = due(
    { name: "n", cron: "0 3 * * *", time_zone: "America/Sao_Paulo", max_lateness_seconds: 86400, last_tick_at: "2026-06-01T00:00:00.000Z" },
    at("2026-06-01T23:00:00Z"),
  );
  assertEquals(utc[0].tick_at, "2026-06-01T03:00:00.000Z");
  assertEquals(sp[0].tick_at, "2026-06-01T06:00:00.000Z");
});

Deno.test("day-of-month skips the months that lack the day", () => {
  // `0 0 30 * *` fires eleven times a year, not twelve. Worth a test because
  // it is the thing people mean when they say "month end" and do not get.
  const s: Schedule = {
    name: "monthly",
    cron: "0 0 30 * *",
    time_zone: "UTC",
    max_lateness_seconds: 90 * 86400,
    last_tick_at: "2026-01-31T00:00:00.000Z",
  };
  const ticks = due(s, at("2026-04-01T00:00:00Z"));
  assertEquals(ticks.map((t) => t.tick_at), [
    "2026-03-30T00:00:00.000Z",
  ]);
});

Deno.test("the watermark advances to the last tick resolved, and no further", () => {
  const ticks = due(
    { ...base, max_lateness_seconds: 3600, last_tick_at: "2026-03-01T12:00:00.000Z" },
    at("2026-03-01T12:35:00Z"),
  );
  // Two of three resolved: a Forbid that declined the third must leave the
  // watermark where the second was, so the third is offered again.
  assertEquals(watermark(ticks.slice(0, 2), "2026-03-01T12:00:00.000Z"), "2026-03-01T12:20:00.000Z");
  assertEquals(watermark([], "2026-03-01T12:00:00.000Z"), "2026-03-01T12:00:00.000Z");
});

Deno.test("an hour list does not smuggle a skipped hour past the gap check", () => {
  // The bare-integer case above is the easy half. `2,4` names two hours, and
  // croner projects the missing 02:30 onto 03:30 — an hour that expression
  // never asked for.
  const ticks = due({
    ...base,
    cron: "30 2,4 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 86400,
    last_tick_at: "2026-03-08T00:00:00Z",
  }, new Date("2026-03-08T12:00:00Z"));
  assertEquals(ticks.map((t) => t.tick_at), ["2026-03-08T08:30:00.000Z"]);
});

Deno.test("a minute list keeps the same guarantee", () => {
  const ticks = due({
    ...base,
    cron: "0,30 2 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 86400,
    last_tick_at: "2026-03-08T00:00:00Z",
  }, new Date("2026-03-08T12:00:00Z"));
  assertEquals(ticks, []);
});

Deno.test("a step is a step, and a bad one is refused", () => {
  // `admits` parses `/step` itself rather than asking croner, so the arithmetic
  // and its refusal are this file's to pin.
  const ticks = due({
    ...base,
    cron: "*/15 2 * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 86400,
    last_tick_at: "2026-03-08T00:00:00Z",
  }, new Date("2026-03-08T12:00:00Z"));
  // 02:00 through 02:45 never happen on this night; the walk keeps nothing.
  assertEquals(ticks, []);

  // `n/step` is n to the end of the field, not n alone. croner emits every one
  // of them, so reading it as a single value drops all but the first —
  // silently, which is the one thing the gap check must never do.
  assertEquals(
    due({
      ...base,
      cron: "5/10 2 * * *",
      time_zone: "UTC",
      max_lateness_seconds: 86400,
      last_tick_at: "2026-03-01T00:00:00.000Z",
    }, new Date("2026-03-01T03:00:00Z")).map((t) => t.tick_at.slice(11, 16)),
    ["02:05", "02:15", "02:25", "02:35", "02:45", "02:55"],
  );

  for (const cron of ["*/0 * * * *", "*/x * * * *"]) {
    assertThrows(
      () => due({ ...base, cron, last_tick_at: "2026-03-01T00:00:00Z" }, new Date("2026-03-01T12:00:00Z")),
      Error,
    );
  }
});

Deno.test("an expression that names every hour keeps the ones that exist", () => {
  // Not a shift to reject: `30 * * * *` names 03:30 in its own right, and the
  // hour the calendar dropped simply does not happen.
  const ticks = due({
    ...base,
    cron: "30 * * * *",
    time_zone: "America/New_York",
    max_lateness_seconds: 21600,
    last_tick_at: "2026-03-08T06:30:00Z",
  }, new Date("2026-03-08T09:00:00Z"));
  assertEquals(ticks.map((t) => t.tick_at), [
    "2026-03-08T07:30:00.000Z", // 03:30 local — 02:30 never existed
    "2026-03-08T08:30:00.000Z", // 04:30 local
  ]);
});

Deno.test("the caller's cap does not cost it the answer to `behind`", () => {
  // due() walks one past the cap so a caller can tell "exactly cap" from
  // "more than cap" without walking a night of ticks to count them.
  const s: Schedule = {
    name: "minutely",
    cron: "* * * * *",
    time_zone: "UTC",
    max_lateness_seconds: 86400,
    last_tick_at: "2026-03-01T00:00:00.000Z",
  };
  // 10 minutes owed, capped at 10: exactly the cap, nothing beyond it.
  assertEquals(due(s, at("2026-03-01T00:10:00Z"), 10).length, 10);
  // 11 owed, capped at 10: one over, which is what `behind` reads.
  assertEquals(due(s, at("2026-03-01T00:11:00Z"), 10).length, 11);
  // and the cap never exceeds the pathological backstop
  assertEquals(due(s, at("2026-03-02T00:00:00Z"), 10).length, 11);
});

Deno.test("an expression that is not five fields is refused, not guessed at", () => {
  for (const cron of ["0 0 * * * *", "0 0 * *", ""]) {
    assertThrows(
      () => due({ ...base, cron }, new Date("2026-09-06T12:00:00Z")),
      Error,
      "five-field cron required",
    );
  }
});

Deno.test("a range that wraps is an error, not a schedule that never fires", () => {
  // croner refuses it first, which is the answer that matters; the parser in
  // due.ts refuses it too rather than quietly matching nothing.
  assertThrows(
    () =>
      due({
        ...base,
        cron: "0 22-2 * * *",
        max_lateness_seconds: 86400,
        last_tick_at: "2026-09-05T00:00:00Z",
      }, new Date("2026-09-06T12:00:00Z")),
    Error,
    "22-2",
  );
});
