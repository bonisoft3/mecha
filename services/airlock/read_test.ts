// A read against a sink served from this process, standing where the
// airlock's daprd stands: the path a read names, what got's cache and retry
// make of the sink's answers, and what a read delivers and journals, or, in
// replay, answers from the journal.

import { assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import { type Airlock, deliverRead, performRead, ReadDiverged, type ReadJob } from "./airlock.ts";
import { bodyOf, expand, get, parseReads, type Read, ReadCache, readOutcome, Unsendable } from "./read.ts";

type Asked = { path: string; headers: Headers };
type Sink = { base: string; asked: Asked[]; close: () => Promise<void> };

/** The path a sink was asked, past daprd's `/v1.0/invoke/<read>/method`. */
const sinkPathOf = (req: Request) => {
  const u = new URL(req.url);
  return u.pathname.replace(/^\/v1\.0\/invoke\/[^/]+\/method/, "") + u.search;
};

/** A daprd and its sink in one, answered by `answer`, every request kept. */
function sink(answer: (req: Request, n: number) => Response | Promise<Response>): Sink {
  const asked: Asked[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    asked.push({ path: sinkPathOf(req), headers: req.headers });
    return answer(req, asked.length);
  });
  return { base: `http://127.0.0.1:${server.addr.port}`, asked, close: () => server.shutdown() };
}

const rate: Read = { request: { method: "GET", path: "/rates/{currency}{?date}" }, invoke: { table: "expense", field: "status", state: "pricing", onDone: "priced", onError: "unpriced", row: ["id"], count: "pricings", incarnation: "lineage" } };
const fast = { retry: { backoffLimit: 10 }, timeout: { request: 2_000 } };

Deno.test("a read's path is its RFC 6570 template expanded over the input, and checked as a sink path", () => {
  assertEquals(expand("/rates/{currency}{?date,limit}", { currency: "USD", date: "2026-11-16" }), "/rates/USD?date=2026-11-16");
  assertEquals(expand("/q{?a,b}", { a: "x y&z", b: 2 }), "/q?a=x%20y%26z&b=2");
  assertEquals(expand("/q?fixed=1{&a}", { a: true }), "/q?fixed=1&a=true");
  assertEquals(expand("/q{?a}", {}), "/q");
  // A path segment is one value of unreserved characters: what it would have
  // to escape is refused, so no value climbs out of its segment.
  // A segment's value is percent-encoded, so it may name what a path spells
  // only so; never what would decode into another segment or decode again.
  assertEquals(expand("/users/{id}", { id: "alice@example.com" }), "/users/alice%40example.com");
  assertEquals(expand("/cities/{name}", { name: "São Paulo" }), "/cities/S%C3%A3o%20Paulo");
  assertThrows(() => expand("/users/{id}", { id: "../admin" }), Unsendable);
  assertThrows(() => expand("/users/{id}", { id: "a/b" }), Unsendable);
  assertThrows(() => expand("/users/{id}", { id: "a\\b" }), Unsendable);
  assertThrows(() => expand("/users/{id}", { id: ".." }), Unsendable);
  assertThrows(() => expand("/users/{id}", { id: "%2e%2e" }), Unsendable);
  assertThrows(() => expand("/users/{id}", {}), Unsendable, "missing");
  assertThrows(() => expand("/users/{id}", { id: "" }), Unsendable, "missing");
  assertThrows(() => expand("/q{?a}", { a: { nested: 1 } }), Unsendable, "strings, numbers and booleans");
});

Deno.test("a manifest's read the airlock would misread is refused", () => {
  const manifest = (r: Record<string, unknown>) => JSON.stringify({ effects: {}, reads: { rate: r } });
  assertEquals(Object.keys(parseReads(manifest(rate as unknown as Record<string, unknown>))), ["rate"]);
  assertEquals(parseReads(JSON.stringify({ effects: {} })), {});
  for (
    const [r, why] of [
      [{ ...rate, request: { method: "POST", path: "/rates" } }, "request"],
      [{ ...rate, request: { method: "GET", path: "/rates", body: {} } }, "request"],
      [{ ...rate, request: { method: "GET", path: "https://elsewhere.example/x" } }, "request"],
      [{ ...rate, request: { method: "GET", path: "/a/{+raw}" } }, "request"],
      [{ ...rate, idempotent: true }, "idempotent is no word of a read"],
      [{ ...rate, input: {} }, "input is no word of a read"],
      [{ ...rate, invoke: undefined }, "invoke"],
      [{ ...rate, invoke: { ...rate.invoke, count: "a b" } }, "invoke.count"],
      [{ ...rate, cacheControl: "private, max-age=60" }, "private"],
      [{ ...rate, cacheControl: "max-age=60; evil" }, "cacheControl"],
      [{ ...rate, got: { retry: { calculateDelay: 1 } } }, "got"],
      [{ ...rate, got: { hooks: {} } }, "got"],
      [{ ...rate, credential: { header: "Authorization", secret: "lower" } }, "credential"],
    ] as const
  ) {
    assertThrows(() => parseReads(manifest(r as Record<string, unknown>)), Error, why);
  }
});

Deno.test("a fresh answer is served from the cache, a stale one revalidated with its ETag, and no-store never kept", async () => {
  const s = sink((req) => {
    const p = sinkPathOf(req);
    if (p.startsWith("/no-store")) return Response.json({ n: 1 }, { headers: { "cache-control": "no-store" } });
    if (req.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"', "cache-control": "max-age=1" } });
    return Response.json({ usd: 5.3 }, { headers: { "cache-control": "max-age=1", etag: '"v1"' } });
  });
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const read: Read = { ...rate, got: fast };
    const first = await get("rate", read, { currency: "USD" }, reach);
    const second = await get("rate", read, { currency: "USD" }, reach);
    assertEquals([first.fromCache, second.fromCache, s.asked.length], [false, true, 1]);
    await new Promise((r) => setTimeout(r, 1_100));
    const third = await get("rate", read, { currency: "USD" }, reach);
    assertEquals(s.asked[1].headers.get("if-none-match"), '"v1"');
    assertEquals([third.status, third.fromCache, JSON.parse(new TextDecoder().decode(third.body))], [200, true, { usd: 5.3 }]);
    const ns: Read = { ...read, request: { method: "GET", path: "/no-store" } };
    await get("rate", ns, {}, reach);
    assertEquals((await get("rate", ns, {}, reach)).fromCache, false);
    assertEquals(s.asked.length, 4);
  } finally {
    await s.close();
  }
});

Deno.test("the cache is shared, so it keeps no private answer", async () => {
  const s = sink((req) => Response.json({ who: sinkPathOf(req) }, { headers: { "cache-control": "private, max-age=60" } }));
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const read: Read = { ...rate, request: { method: "GET", path: "/wallet" }, got: fast };
    await get("wallet", read, {}, reach);
    assertEquals((await get("wallet", read, {}, reach)).fromCache, false);
    assertEquals(s.asked.length, 2);
  } finally {
    await s.close();
  }
});

Deno.test("requests HTTP tells apart never share an answer, whatever got's key makes of them", async () => {
  const s = sink((req) => Response.json({ q: new URL(req.url).search }, { headers: { "cache-control": "max-age=60" } }));
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const q: Read = { ...rate, request: { method: "GET", path: "/q{?a,utm_id}" }, got: fast };
    for (const input of [{ a: "x y" }, { a: "x+y" }, { utm_id: "alice" }, { utm_id: "bob" }]) {
      assertEquals(bodyOf(await get("q", q, input, reach)), { q: expand("/q{?a,utm_id}", input).slice(2) });
    }
    assertEquals(s.asked.length, 4);
    assertEquals((await get("q", q, { utm_id: "bob" }, reach)).fromCache, true);
  } finally {
    await s.close();
  }
});

Deno.test("Vary is honoured: an answer that varies on everything is never reused", async () => {
  const s = sink(() => Response.json({}, { headers: { "cache-control": "max-age=60", vary: "*" } }));
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const read: Read = { ...rate, got: fast };
    await get("rate", read, { currency: "USD" }, reach);
    assertEquals((await get("rate", read, { currency: "USD" }, reach)).fromCache, false);
  } finally {
    await s.close();
  }
});

Deno.test("the declared freshness stands in for a sink that sends none, only where a cache may give one, and a body of unstated length is not kept", async () => {
  const s = sink((req) => {
    const p = sinkPathOf(req);
    if (p === "/plain") return Response.json({ n: 1 });
    if (p === "/expires") return Response.json({ n: 1 }, { headers: { expires: "Thu, 01 Jan 1970 00:00:00 GMT" } });
    if (p === "/own") return Response.json({ n: 1 }, { headers: { "cache-control": "no-cache" } });
    if (p === "/chunked") {
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"n":1}')); c.close(); } });
      return new Response(body, { headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
    }
    return Response.json({ n: 1 }, { status: 500 });
  });
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const at = (path: string): Read => ({ ...rate, request: { method: "GET", path }, cacheControl: "max-age=60", got: { retry: { limit: 0 } } });
    const plain = await get("rate", at("/plain"), {}, reach);
    assertEquals(plain.headers["cache-control"], "max-age=60");
    assertEquals((await get("rate", at("/plain"), {}, reach)).fromCache, true);
    for (const p of ["/expires", "/own", "/broken"]) {
      const a = await get("rate", at(p), {}, reach);
      assertEquals((await get("rate", at(p), {}, reach)).fromCache, false, p);
      assertEquals(a.headers["cache-control"] === "max-age=60", false, p);
    }
    // A body of unstated length is never kept: it could be any size.
    await get("rate", at("/chunked"), {}, reach);
    assertEquals((await get("rate", at("/chunked"), {}, reach)).fromCache, false);
  } finally {
    await s.close();
  }
});

Deno.test("got retries a 503 and never a 404; a sink too slow is no answer, asked once", async () => {
  const s = sink(async (req, n) => {
    const p = sinkPathOf(req);
    if (p === "/flaky") return n === 1 ? new Response("busy", { status: 503, headers: { "retry-after": "0" } }) : Response.json({ ok: true });
    if (p === "/slow") {
      await new Promise((r) => setTimeout(r, 500));
      return Response.json({});
    }
    return Response.json({ missing: true }, { status: 404 });
  });
  try {
    const reach = { mesh: s.base, headers: {}, cache: new ReadCache() };
    const at = (path: string, got?: Read["got"]): Read => ({ ...rate, request: { method: "GET", path }, got: got ?? fast });
    assertEquals((await get("rate", at("/flaky"), {}, reach)).status, 200);
    assertEquals(s.asked.length, 2);
    assertEquals((await get("rate", at("/gone"), {}, reach)).status, 404);
    assertEquals(s.asked.length, 3);
    await assertRejects(() => get("rate", at("/slow", { retry: { limit: 0 }, timeout: { request: 100 } }), {}, reach), Error, "Timeout");
    assertEquals(s.asked.length, 4, "a timed-out GET is sent once");
  } finally {
    await s.close();
  }
});

Deno.test("the credential is a header the sink receives and never a cache key; daprd's own failure is no answer", async () => {
  const s = sink((req) => {
    const p = sinkPathOf(req);
    if (p === "/mesh") return Response.json({ errorCode: "ERR_DIRECT_INVOKE", message: "fail to invoke" }, { status: 500 });
    if (p === "/own-code") return Response.json({ errorCode: "ERR_NOT_FOUND" }, { status: 404 });
    // A shared cache keeps an answer to an authorized request only where the
    // answer says it may (RFC 9111 §3.5).
    const cc = p.startsWith("/rates/USD") ? "public, max-age=60" : "max-age=60";
    return Response.json({ auth: req.headers.get("authorization") }, { headers: { "cache-control": cc, vary: "Authorization" } });
  });
  try {
    const reach = { mesh: s.base, headers: { Authorization: "Bearer s3cret" }, cache: new ReadCache() };
    const a = await get("rate", { ...rate, got: fast }, { currency: "USD" }, reach);
    assertEquals(JSON.parse(new TextDecoder().decode(a.body)), { auth: "Bearer s3cret" });
    assertEquals((await get("rate", { ...rate, got: fast }, { currency: "USD" }, reach)).fromCache, true);
    await get("rate", { ...rate, got: fast }, { currency: "EUR" }, reach);
    assertEquals((await get("rate", { ...rate, got: fast }, { currency: "EUR" }, reach)).fromCache, false);
    assertEquals(reach.cache.keys().some((k) => k.includes("s3cret")), false);
    assertEquals(reach.cache.keys().length, 1);
    await assertRejects(() => get("rate", { ...rate, request: { method: "GET", path: "/mesh" }, got: { retry: { limit: 0 } } }, {}, reach), Error, "daprd answered");
    // A sink's own error code is its answer.
    assertEquals((await get("rate", { ...rate, request: { method: "GET", path: "/own-code" }, got: { retry: { limit: 0 } } }, {}, reach)).status, 404);
  } finally {
    await s.close();
  }
});

Deno.test("a 2xx is done; anything else the sink answered is failed with its status", () => {
  const answer = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify(body)), fromCache: false });
  assertEquals(readOutcome(rate.invoke!, answer(200, { usd: 5 })), { target: "priced", kind: "done", data: { usd: 5 } });
  assertEquals(readOutcome(rate.invoke!, answer(404, { no: 1 })), { target: "unpriced", kind: "failed", data: { status: 404, body: { no: 1 } } });
});

/** A pool whose one client keeps every query, as a read's delivery sends
 * them; `moved` is how many rows its UPDATE moves, `journal` what the journal
 * holds by key. */
function recordingDb(moved = 1, journal: Record<string, { digest: string; outcome: unknown }> = {}) {
  const queries: { text: string; values?: unknown[] }[] = [];
  const query = (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    if (text.startsWith("SELECT digest, outcome FROM airlock.read_journal")) {
      const hit = journal[values![0] as string];
      return Promise.resolve({ rowCount: hit ? 1 : 0, rows: hit ? [hit] : [] });
    }
    return Promise.resolve({ rowCount: text.startsWith("UPDATE") ? moved : 0, rows: [] });
  };
  const client = { query, release: () => {} };
  return { queries, db: { connect: () => Promise.resolve(client), query } };
}

const job: ReadJob = { effect: "rate", row: { id: "e1" }, incarnation: "i1", n: 3, key: "rate:e1:i1:3", input: { currency: "USD" }, digest: "d1" };
const verbs = (queries: { text: string }[]) => queries.map((q) => q.text.trim().split(/\s/)[0]);

Deno.test("a read delivers its answer as the row's move on the entry it was asked at, and journals it in the same commit", async () => {
  const s = sink(() => Response.json({ usd: 5.3 }));
  try {
    const { queries, db } = recordingDb();
    const a = { db, reads: { rate: { ...rate, got: fast } }, headers: {}, mesh: s.base } as unknown as Airlock;
    await performRead(a, job, false);
    assertEquals(s.asked[0].path, "/rates/USD");
    assertEquals(verbs(queries), ["BEGIN", "SELECT", "UPDATE", "INSERT", "COMMIT"]);
    assertEquals(queries[1].text, "SELECT set_config('airlock.read', $1, true)");
    assertEquals(JSON.parse(queries[1].values![0] as string), { effect: "rate", row: { id: "e1" }, incarnation: "i1", n: 3, target: "priced", kind: "done", data: { usd: 5.3 } });
    assertEquals(queries[2].text, `UPDATE "expense" SET "status" = $1 WHERE "status" = $2 AND "pricings" = $3 AND "lineage"::text = $4 AND "id"::text = $5`);
    assertEquals(queries[2].values, ["priced", "pricing", 3, "i1", "e1"]);
    assertEquals(queries[3].values, ["rate:e1:i1:3", "rate", JSON.stringify({ id: "e1" }), "i1", 3, "d1", JSON.stringify({ target: "priced", kind: "done", data: { usd: 5.3 } })]);
  } finally {
    await s.close();
  }
});

Deno.test("a read with no answer is retried, and on its last run is failed into onError", async () => {
  const s = sink(() => new Response("down", { status: 503 }));
  try {
    const { queries, db } = recordingDb();
    const a = { db, reads: { rate: { ...rate, got: { retry: { limit: 0 } } } }, headers: {}, mesh: s.base } as unknown as Airlock;
    // A 503 is the sink's answer, so it is the outcome, failed with its status.
    await performRead(a, job, false);
    assertEquals(JSON.parse(queries[1].values![0] as string).data, { status: 503, body: "down" });
    const dead = { ...a, mesh: "http://127.0.0.1:1" } as Airlock;
    const before = queries.length;
    await assertRejects(() => performRead(dead, job, false));
    assertEquals(queries.length, before, "a run with no answer delivers nothing, and Graphile retries it");
    await performRead(dead, job, true);
    const last = JSON.parse(queries.at(-4)!.values![0] as string);
    assertEquals([last.target, last.kind], ["unpriced", "failed"]);
    assertExists(last.data.error);
  } finally {
    await s.close();
  }
});

Deno.test("an answer to an entry the row no longer waits on moves nothing and journals nothing", async () => {
  const { queries, db } = recordingDb(0);
  const a = { db, reads: { rate }, headers: {} } as unknown as Airlock;
  assertEquals(await deliverRead(a, job, { target: "priced", kind: "done", data: {} }), false);
  assertEquals(verbs(queries), ["BEGIN", "SELECT", "UPDATE", "COMMIT"]);
});

Deno.test("in replay the journal answers, never the sink; a request it holds under other input, or not at all, stops the replay", async () => {
  const s = sink(() => Response.json({ usd: 9 }));
  try {
    const recorded = { target: "priced", kind: "done", data: { usd: 5.3 } };
    const { queries, db } = recordingDb(1, { "rate:e1:i1:3": { digest: "d1", outcome: recorded } });
    const a = { db, reads: { rate: { ...rate, got: fast } }, headers: {}, mesh: s.base, replay: true } as unknown as Airlock;
    await performRead(a, job, false);
    assertEquals(s.asked.length, 0);
    assertEquals(JSON.parse(queries.find((q) => q.text.startsWith("SELECT set_config"))!.values![0] as string), { effect: "rate", row: { id: "e1" }, incarnation: "i1", n: 3, ...recorded });
    assertEquals(queries.some((q) => q.text.trim().startsWith("INSERT")), false, "a replay writes no journal");
    const before = queries.length;
    await assertRejects(() => performRead(a, { ...job, digest: "other" }, true), ReadDiverged, "other input");
    await assertRejects(() => performRead(a, { ...job, n: 4, key: "rate:e1:i1:4" }, true), ReadDiverged, "no answer");
    assertEquals(queries.slice(before).filter((q) => !q.text.startsWith("SELECT digest")).length, 0, "a diverged history moves nothing");
    assertEquals(s.asked.length, 0);
  } finally {
    await s.close();
  }
});

// Regression: appending `airlock.read_journal` to `job_key.sql` changed the
// SHA-256 of `*_airlock_job_key.sql` on retained Cloudflare Edge databases,
// which `_pronto_migrations` refused with HTTP 409 (`ChangedScript`).
Deno.test("job_key.sql stays byte-for-byte unchanged so retained edge databases accept releases", async () => {
  const bytes = await Deno.readFile(new URL("./job_key.sql", import.meta.url));
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(sha, "b5ca762c49e95899420d00b6b643dcad0bb14a96422b792355a079c94d533708");
});
