// The sweep, against an in-memory PostgREST.
//
// The fake below implements only the subset main.ts uses, but it implements it
// honestly — duplicate keys, Prefer resolution, order/offset/limit — because
// every guarantee in this file is a claim about how PostgREST answers.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import {
  type Crud,
  handler,
  type Poke,
  type Report,
  type ScheduleRow,
  sweep,
  tickId,
  uuid5,
} from "./main.ts";

type Row = Record<string, unknown>;

function fakeCrud(tables: Record<string, Row[]>): Crud & { calls: string[] } {
  const calls: string[] = [];
  const crud = (async (method, path, opts = {}) => {
    calls.push(`${method} ${path}`);
    const url = new URL(path, "http://crud");
    const table = url.pathname.slice(1);
    tables[table] ??= [];
    const rows = tables[table];

    if (method === "POST") {
      const row = opts.body as Row;
      const clash = rows.find((r) => r.id === row.id);
      if (clash) {
        if ((opts.prefer ?? "").includes("resolution=ignore-duplicates")) return [];
        throw new Error(`crud POST ${path}: 409 duplicate key`);
      }
      rows.push({ ...row });
      return [{ ...row }];
    }

    const match = select(rows, url);
    if (method === "GET") return shape(match, url);
    if (method === "PATCH") {
      for (const r of match) Object.assign(r, opts.body as Row);
      return match.map((r) => ({ ...r }));
    }
    if (method === "DELETE") {
      for (const r of match) rows.splice(rows.indexOf(r), 1);
      return [];
    }
    throw new Error(`unsupported ${method}`);
  }) as Crud & { calls: string[] };
  crud.calls = calls;
  return crud;
}

/** The wake, counted. A poke that fires when nothing was emitted is a billed
 * cold start, so the count is an assertion and not a diagnostic. */
function fakePoke(fail?: string): Poke & { count: number } {
  const poke = (() => {
    poke.count++;
    return fail === undefined ? Promise.resolve() : Promise.reject(new Error(fail));
  }) as Poke & { count: number };
  poke.count = 0;
  return poke;
}

const MODIFIERS = new Set(["select", "order", "offset", "limit"]);

/** `or=(a.op.v,b.op.v)` — enough of PostgREST's boolean grammar for the
 * monotonic watermark guard, and no more. */
function orMatches(spec: string, r: Row): boolean {
  return spec.replace(/^\(|\)$/g, "").split(",").some((clause) => {
    const [col, op, ...rest] = clause.split(".");
    return one(r[col], op, rest.join("."));
  });
}

function one(got: unknown, op: string, raw: string): boolean {
  const want = raw === "true" ? true : raw === "false" ? false : raw;
  switch (op) {
    case "eq":
      return got === want || String(got) === String(want);
    case "is":
      return raw === "null" ? got === null || got === undefined : got === want;
    case "neq":
      return String(got) !== String(want);
    case "lte":
      return String(got) <= String(want);
    case "lt":
      return got === null || got === undefined ? false : String(got) < String(want);
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

function select(rows: Row[], url: URL): Row[] {
  let out = rows;
  for (const [col, expr] of url.searchParams) {
    if (MODIFIERS.has(col)) continue;
    if (col === "or") {
      out = out.filter((r) => orMatches(expr, r));
      continue;
    }
    const dot = expr.indexOf(".");
    out = out.filter((r) => one(r[col], expr.slice(0, dot), expr.slice(dot + 1)));
  }
  return out;
}

function shape(rows: Row[], url: URL): Row[] {
  let out = [...rows];
  const order = url.searchParams.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    out.sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (dir === "desc" ? -1 : 1));
  }
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = url.searchParams.get("limit");
  out = out.slice(offset, limit === null ? undefined : offset + Number(limit));
  const sel = url.searchParams.get("select");
  if (sel && sel !== "*") {
    const cols = sel.split(",");
    out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  return out.map((r) => ({ ...r }));
}

/** The fake's tables, typed so a table that a test never seeds is still
 * addressable — an assertion on a table nothing wrote is the point of several
 * of these. */
function store(schedules: ScheduleRow[], extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return { schedule: schedules as unknown as Row[], ...extra };
}

function aSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    name: "sweep",
    cron: "0 * * * *",
    time_zone: "UTC",
    max_lateness_seconds: 300,
    last_tick_at: null,
    suspended: false,
    concurrency_policy: "Allow",
    done_entity: null,
    done_filter: null,
    emits_entity: "sweep_request",
    emits_values: { status: "requested" },
    ...over,
  };
}

/** Every failure in a sweep is reported rather than thrown, so a test that
 * expects success has to say so or it reads a broken sweep as a pass. */
function clean(r: Report): Report {
  const bad = r.schedules.filter((s) => s.error !== undefined);
  assertEquals(bad, [], `sweep reported errors: ${JSON.stringify(bad)}`);
  return r;
}

const NOON = new Date("2026-09-06T12:00:30Z");

Deno.test("the key is an RFC 4122 v5, so it is derivable outside this file", async () => {
  // The RFC's own vector. A key anyone can recompute is what lets a second
  // clock, a redelivery and a pipeline agree on which row a tick is.
  const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  assertEquals(await uuid5(dns, "www.example.com"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
});

Deno.test("a due tick is one row, keyed by the tick", async () => {
  const t = store([aSchedule()]);
  const crud = fakeCrud(t);
  clean(await sweep(NOON, "test", crud, fakePoke()));

  // One write. The app's declared values and mecha's five columns are the
  // same row, so there is no ledger to fall out of step with it.
  assertEquals(t.sweep_request.length, 1);
  const row = t.sweep_request[0];
  assertEquals(row.status, "requested");
  assertEquals(row.id, await tickId("sweep", "2026-09-06T12:00:00.000Z"));
  assertEquals(row.schedule, "sweep");
  assertEquals(row.tick_at, "2026-09-06T12:00:00.000Z");
  assertEquals(row.late, false);
  assertEquals(row.caller, "test");
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T12:00:00.000Z");
});

Deno.test("a declaration cannot overwrite what makes the row a tick", async () => {
  const t = store([aSchedule({
    emits_values: { status: "requested", id: "not-a-tick", late: true, schedule: "theirs" },
  })]);
  clean(await sweep(NOON, null, fakeCrud(t), fakePoke()));
  const row = t.sweep_request[0];
  assertEquals(row.id, await tickId("sweep", "2026-09-06T12:00:00Z"));
  assertEquals(row.late, false);
  assertEquals(row.schedule, "sweep");
});

Deno.test("the same poke twice is one row: a redelivery is absorbed", async () => {
  const t = store([aSchedule()]);
  const crud = fakeCrud(t);
  clean(await sweep(NOON, "a", crud, fakePoke()));
  clean(await sweep(NOON, "b", crud, fakePoke()));

  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.sweep_request[0].caller, "a");
});

Deno.test("two clocks poking at once produce one row", async () => {
  const t = store([aSchedule()]);
  const crud = fakeCrud(t);
  await Promise.all([
    sweep(NOON, "cron", crud, fakePoke()).then(clean),
    sweep(NOON, "scheduler", crud, fakePoke()).then(clean),
  ]);
  assertEquals(t.sweep_request.length, 1);
});

Deno.test("a sweep that dies before the watermark moves is retried whole", async () => {
  const t = store([aSchedule()]);
  const inner = fakeCrud(t);
  const dies: Crud = (method, path, opts) => {
    if (method === "PATCH") throw new Error("the ticker died here");
    return inner(method, path, opts);
  };
  const first = await sweep(NOON, "doomed", dies, fakePoke());
  assertEquals(first.schedules[0].error, "the ticker died here");
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.schedule[0].last_tick_at, null);

  // The next poke owes the same tick, rewrites the same key, and finishes.
  clean(await sweep(NOON, "next", inner, fakePoke()));
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T12:00:00.000Z");
});

Deno.test("the watermark survives Postgres's own rendering of an instant", async () => {
  // Read back as +00:00, written as Z. If the key were hashed from the raw
  // string the two would differ and every tick would be emitted twice.
  const t = store([aSchedule({ last_tick_at: "2026-09-06T11:00:00+00:00" })]);
  const crud = fakeCrud(t);
  clean(await sweep(NOON, null, crud, fakePoke()));

  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.sweep_request[0].id, await tickId("sweep", "2026-09-06T12:00:00Z"));
});

Deno.test("a tick past its budget is recorded and not emitted", async () => {
  const t = store([aSchedule({ cron: "0 0 * * *", last_tick_at: "2026-09-04T00:00:00Z" })]);
  const crud = fakeCrud(t);
  clean(await sweep(NOON, null, crud, fakePoke()));

  // A late tick is a row like any other, wearing `late`. The pipeline reading
  // this table skips it; nothing else has to know it happened.
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.sweep_request[0].late, true);
  assertEquals(t.sweep_request[0].tick_at, "2026-09-05T00:00:00.000Z");
  // Decided, so the watermark moves past it: an unrunnable tick that stayed
  // due would be recomputed on every poke forever.
  assertEquals(t.schedule[0].last_tick_at, "2026-09-05T00:00:00.000Z");
});

Deno.test("Forbid holds while the prior row is unfinished, and holds the watermark with it", async () => {
  const s = aSchedule({
    cron: "* * * * *",
    concurrency_policy: "Forbid",
    done_entity: "sweep_outcome",
    done_filter: "status=eq.done",
    last_tick_at: "2026-09-06T11:57:00Z",
  });
  const prior = await tickId("sweep", "2026-09-06T11:57:00Z");
  // The tick exists and no outcome answers it: the pipeline is still working,
  // or wedged, and either way the clock must not pile another one on.
  const t = store([s], {
    sweep_request: [{ id: prior, schedule: "sweep", late: false }],
    sweep_outcome: [],
  });
  const crud = fakeCrud(t);
  const report = clean(await sweep(NOON, null, crud, fakePoke()));

  assertEquals(report.schedules[0].emitted, 0);
  assertEquals(report.schedules[0].held, 3);
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T11:57:00Z");
});

Deno.test("Forbid emits once the prior row reaches done, and only once", async () => {
  const s = aSchedule({
    cron: "* * * * *",
    concurrency_policy: "Forbid",
    done_entity: "sweep_outcome",
    done_filter: "status=eq.done",
    last_tick_at: "2026-09-06T11:59:00Z",
  });
  const prior = await tickId("sweep", "2026-09-06T11:59:00Z");
  const t = store([s], {
    sweep_request: [{ id: prior, schedule: "sweep", late: false }],
    sweep_outcome: [{ id: prior, status: "done" }],
  });
  const crud = fakeCrud(t);
  const report = clean(await sweep(NOON, null, crud, fakePoke()));

  // 12:00 emits; the tick after it is held by the row 12:00 just wrote.
  assertEquals(report.schedules[0].emitted, 1);
  assertEquals(t.sweep_request.length, 2);
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T12:00:00.000Z");
});

Deno.test("Forbid without somewhere to read done is an error, not a policy that does nothing", async () => {
  const t = store([
      aSchedule({ concurrency_policy: "Forbid", last_tick_at: "2026-09-06T11:00:00Z" }),
  ]);
  const crud = fakeCrud(t);
  const report = await sweep(NOON, null, crud, fakePoke());
  assertEquals(
    report.schedules[0].error,
    "sweep: concurrencyPolicy Forbid needs a done entity and filter",
  );
  assertEquals(t.sweep_request ?? [], []);
});

Deno.test("a slower clock cannot drag the watermark backwards", async () => {
  // Two clocks are a supported state, and they read the schedule list at
  // different instants. The slow one below holds the row as it was before the
  // fast one committed, which is exactly what a tier migration looks like.
  const t = store([aSchedule({ cron: "* * * * *", last_tick_at: "2026-09-06T11:58:00Z" })]);
  const inner = fakeCrud(t);
  const stale = { ...t.schedule[0] };

  clean(await sweep(NOON, "fast", inner, fakePoke()));
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T12:00:00.000Z");

  const slow: Crud = (method, path, opts) =>
    method === "GET" && path.startsWith("/schedule?")
      ? Promise.resolve([stale])
      : inner(method, path, opts);
  clean(await sweep(new Date("2026-09-06T11:59:30Z"), "slow", slow, fakePoke()));

  assertEquals(
    t.schedule[0].last_tick_at,
    "2026-09-06T12:00:00.000Z",
    "the older sweep must not undo the newer one",
  );
});

Deno.test("a suspended schedule is not swept", async () => {
  const t = store([aSchedule({ suspended: true })]);
  const crud = fakeCrud(t);
  const report = clean(await sweep(NOON, null, crud, fakePoke()));
  assertEquals(report.schedules, []);
  assertEquals(t.sweep_request ?? [], []);
});

Deno.test("one schedule's failure does not stop the others, and fails the poke", async () => {
  const t = store([
      aSchedule({ name: "broken", concurrency_policy: "Forbid", last_tick_at: "2026-09-06T11:00:00Z" }),
      aSchedule({ name: "fine" }),
  ]);
  const crud = fakeCrud(t);
  const report = await sweep(NOON, null, crud, fakePoke());
  assert(report.schedules[0].error !== undefined);
  assertEquals(report.schedules[1].error, undefined);
  assertEquals(t.sweep_request.length, 1);
});

Deno.test("emitting knocks on the door once, however many schedules emitted", async () => {
  const t = store([aSchedule({ name: "one" }), aSchedule({ name: "two" })]);
  const poke = fakePoke();
  const report = clean(await sweep(NOON, null, fakeCrud(t), poke));
  assertEquals(report.schedules.map((s) => s.emitted), [1, 1]);
  assertEquals(poke.count, 1);
  assertEquals(report.poke, { ok: true });
});

Deno.test("a sweep with nothing to emit does not wake anything", async () => {
  // A late tick DOES write a row now, and that row is on the CDC path like any
  // other — but nothing acts on it, and on a unit pinned to cpuIdle: false a
  // wake nobody needs is a billed cold start. A held tick is not written at all.
  const t = store([
    aSchedule({ name: "late", cron: "0 0 * * *", last_tick_at: "2026-09-04T00:00:00Z" }),
    aSchedule({ name: "idle", cron: "0 0 1 1 *", last_tick_at: "2026-09-06T11:59:00Z" }),
  ]);
  const poke = fakePoke();
  const report = clean(await sweep(NOON, null, fakeCrud(t), poke));
  assertEquals(report.schedules.map((s) => s.emitted), [0, 0]);
  assertEquals(report.schedules.map((s) => s.late), [1, 0]);
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.sweep_request[0].late, true);
  assertEquals(poke.count, 0);
  assertEquals(report.poke, undefined);
});

Deno.test("Forbid does not hold forever behind a tick that asked for nothing", async () => {
  // A late tick is a row like any other, so its existence does not mean work
  // was asked for. Waiting for an outcome that is never coming would wedge the
  // schedule permanently.
  const s = aSchedule({
    cron: "* * * * *",
    concurrency_policy: "Forbid",
    done_entity: "sweep_outcome",
    done_filter: "status=eq.done",
    last_tick_at: "2026-09-06T11:58:00Z",
  });
  const prior = await tickId("sweep", "2026-09-06T11:58:00Z");
  const t = store([s], {
    sweep_request: [{ id: prior, schedule: "sweep", late: true }],
    sweep_outcome: [],
  });
  const report = clean(await sweep(NOON, null, fakeCrud(t), fakePoke()));

  assert(report.schedules[0].emitted > 0, "a late prior must not hold the schedule");
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T11:59:00.000Z");
});

Deno.test("a wake that does not land fails the poke, and says which half worked", async () => {
  const t = store([aSchedule()]);
  const serve = handler(fakeCrud(t), fakePoke("poke http://mesh:3500: 503"), "s3cret", () => NOON);
  const res = await serve(
    new Request("http://ticker:9998/poke", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    }),
  );
  assertEquals(res.status, 500);
  const report = await res.json() as Report;
  assertEquals(report.schedules[0].emitted, 1);
  assertEquals(report.poke, { ok: false, error: "poke http://mesh:3500: 503" });
  assertEquals(t.sweep_request.length, 1);
});

Deno.test("a wake that does not land holds the watermark, so the retry knocks again", async () => {
  const t = store([aSchedule()]);
  const crud = fakeCrud(t);

  const first = clean(await sweep(NOON, "clock", crud, fakePoke("503")));
  assertEquals(first.schedules[0].emitted, 1);
  assertEquals(first.poke?.ok, false);
  // The whole point. An advanced watermark would leave the next poke owing
  // nothing, so nothing would knock, and the durable row would sit unread
  // until some later tick happened to emit.
  assertEquals(t.schedule[0].last_tick_at, null);

  const landing = fakePoke();
  const second = clean(await sweep(NOON, "clock", crud, landing));
  assertEquals(landing.count, 1);
  assertEquals(second.poke, { ok: true });
  assertEquals(t.sweep_request.length, 1);
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T12:00:00.000Z");
});

Deno.test("a schedule that dies mid-sweep wakes the rows it did write", async () => {
  // Two ticks land, the third throws. Reporting emitted 0 here would skip the
  // wake and strand two rows that are already durable.
  const s = aSchedule({ cron: "* * * * *", last_tick_at: "2026-09-06T11:57:00Z" });
  const t = store([s]);
  const inner = fakeCrud(t);
  let emits = 0;
  const dies: Crud = (method, path, opts) => {
    if (method === "POST" && path === "/sweep_request" && ++emits === 3) {
      throw new Error("crud POST /sweep_request: 503");
    }
    return inner(method, path, opts);
  };
  const poke = fakePoke();

  const report = await sweep(NOON, null, dies, poke);
  assertEquals(report.schedules[0].emitted, 2);
  assertEquals(report.schedules[0].error, "crud POST /sweep_request: 503");
  assertEquals(poke.count, 1);
  assertEquals(t.sweep_request.length, 2);
  // The two that landed are paid for; the third is still owed.
  assertEquals(t.schedule[0].last_tick_at, "2026-09-06T11:59:00.000Z");
});

Deno.test("a schedule further behind than one poke drains across pokes", async () => {
  // A wide budget on a minutely cron owes hundreds of ticks. An unbounded
  // sweep would run past its caller's deadline, be killed before the watermark
  // moved, and repeat the identical work forever.
  const s = aSchedule({
    cron: "* * * * *",
    max_lateness_seconds: 86400,
    last_tick_at: "2026-09-05T00:00:00Z",
  });
  const t = store([s]);
  const crud = fakeCrud(t);

  const first = clean(await sweep(NOON, null, crud, fakePoke()));
  assertEquals(first.schedules[0].behind, true);
  assertEquals(first.schedules[0].emitted + first.schedules[0].late, 64);
  const mark = t.schedule[0].last_tick_at;
  assert(mark !== null, "the watermark must move or the next poke repeats this one");

  // The next poke starts where this one stopped.
  const second = clean(await sweep(NOON, null, crud, fakePoke()));
  assertEquals(second.schedules[0].emitted, 64);
  assert(
    String(t.schedule[0].last_tick_at) > String(mark),
    `watermark went ${mark} -> ${t.schedule[0].last_tick_at}`,
  );
});

Deno.test("a schedule that owes less than a poke is not reported behind", async () => {
  const t = store([aSchedule()]);
  const report = clean(await sweep(NOON, null, fakeCrud(t), fakePoke()));
  assertEquals(report.schedules[0].behind, false);
});

Deno.test("a crud that cannot even list the schedules is a logged 500", async () => {
  const down: Crud = () => Promise.reject(new Error("crud GET /schedule: 503"));
  const serve = handler(down, fakePoke(), "s3cret", () => NOON);
  const res = await serve(
    new Request("http://ticker:9998/poke", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    }),
  );
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "crud GET /schedule: 503");
});

Deno.test("the poke needs the cluster's own credential", async () => {
  const t = store([aSchedule()]);
  const serve = handler(fakeCrud(t), fakePoke(), "s3cret", () => NOON);

  const anon = await serve(new Request("http://ticker:9998/poke", { method: "POST" }));
  assertEquals(anon.status, 401);
  await anon.body?.cancel();
  assertEquals(t.sweep_request ?? [], []);

  const wrong = await serve(
    new Request("http://ticker:9998/poke", {
      method: "POST",
      headers: { authorization: "Bearer s3cres" },
    }),
  );
  assertEquals(wrong.status, 401);
  await wrong.body?.cancel();
  assertEquals(t.sweep_request ?? [], []);
});

Deno.test("the poke carries nothing but a label, and reports what it did", async () => {
  const t = store([aSchedule()]);
  const serve = handler(fakeCrud(t), fakePoke(), "s3cret", () => NOON);
  const res = await serve(
    new Request("http://ticker:9998/poke?caller=cloud-scheduler", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    }),
  );
  assertEquals(res.status, 200);
  const report = await res.json() as Report;
  assertEquals(report.caller, "cloud-scheduler");
  assertEquals(report.schedules[0].emitted, 1);
  assertEquals(t.sweep_request[0].caller, "cloud-scheduler");
});

Deno.test("a sweep with a failing schedule answers the caller with a failure", async () => {
  const t = store([
      aSchedule({ concurrency_policy: "Forbid", last_tick_at: "2026-09-06T11:00:00Z" }),
  ]);
  const serve = handler(fakeCrud(t), fakePoke(), "s3cret", () => NOON);
  const res = await serve(
    new Request("http://ticker:9998/poke", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    }),
  );
  // Retrying is free by construction, so an honest 500 is the right answer.
  assertEquals(res.status, 500);
  await res.body?.cancel();
});

Deno.test("nothing but POST /poke exists", async () => {
  const serve = handler(fakeCrud({ schedule: [] }), fakePoke(), "s3cret", () => NOON);
  for (const req of [
    new Request("http://ticker:9998/poke", { method: "GET" }),
    new Request("http://ticker:9998/", {
      method: "POST",
      headers: { authorization: "Bearer s3cret" },
    }),
  ]) {
    const res = await serve(req);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  }
});

Deno.test("an unreachable crud fails the poke rather than reporting a quiet success", async () => {
  const down: Crud = () => Promise.reject(new Error("crud GET /schedule: 503"));
  await assertRejects(() => sweep(NOON, null, down, fakePoke()), Error, "503");
});
