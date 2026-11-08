// The cage a handler runs in and the one door out of it, with the transport
// faked: what the handler may name, what reaches the transport, and what
// answers are accepted.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { BreakerOpen, Handler, meshTransport, sinkPath, type Transport } from "./handler.ts";
import { type Effect, encodedBody } from "./reentry.ts";
import type { BlobStore } from "./blobs.ts";

const effect: Effect = {
  table: "payment",
  field: "status",
  state: "charging",
  onDone: "settled",
  onError: "failed",
  row: ["id"],
  key: ["id"],
  idempotent: false,
  reentry: "reconcile",
  attempts: 5,
  handler: "effects/charge.js",
};
const idempotent: Effect = { ...effect, idempotent: true, reentry: undefined };
const signing: Effect = { ...idempotent, endowments: ["Crypto", "TextEncoder"] };

async function file(source: string): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".js" });
  await Deno.writeTextFile(path, source);
  return path;
}

type Call = { endpoint: string; path: string; init: { method: string; body?: unknown; headers?: Record<string, string> }; key: string; headers: Record<string, string> };
function recording(answer: (c: Call) => { status: number; body: unknown }): { calls: Call[]; transport: Transport } {
  const calls: Call[] = [];
  return {
    calls,
    transport: (endpoint, path, init, key, headers) => {
      const c = { endpoint, path, init, key, headers };
      calls.push(c);
      return Promise.resolve(answer(c));
    },
  };
}

const CHARGE = `
export async function issue(input, sink) {
  const r = await sink.fetch("/v1/charges", { method: "POST", body: { amount: input.amount, key: sink.key } });
  if (r.status === 402) return { failed: r.body };
  return { done: r.body };
}
export async function reconcile(input, sink) {
  const r = await sink.fetch("/v1/charges?key=" + encodeURIComponent(sink.key));
  return r.status === 404 ? { absent: true } : { done: r.body };
}
`;

Deno.test("a handler reaches its sink only through the transport, by path, with the ledger key", async () => {
  const h = await Handler.admit("charge", await file(CHARGE), effect);
  const { calls, transport } = recording(() => ({ status: 200, body: { id: "ch_1" } }));
  assertEquals(await h.call("issue", { amount: 1250 }, "charge:p1", transport), { done: { id: "ch_1" } });
  assertEquals(calls, [{
    endpoint: "charge",
    path: "/v1/charges",
    init: { method: "POST", body: { amount: 1250, key: "charge:p1" }, headers: {} },
    key: "charge:p1",
    headers: {},
  }]);
});

Deno.test("a refusal from the sink is the handler's failed answer; reconcile may find nothing", async () => {
  const h = await Handler.admit("charge", await file(CHARGE), effect);
  const declined = recording(() => ({ status: 402, body: "card_declined" }));
  assertEquals(await h.call("issue", { amount: 1 }, "charge:p2", declined.transport), { failed: "card_declined" });
  const nothing = recording(() => ({ status: 404, body: "" }));
  assertEquals(await h.call("reconcile", { amount: 1 }, "charge:p2", nothing.transport), { absent: true });
  assertEquals(nothing.calls[0].path, "/v1/charges?key=charge%3Ap2");
});

Deno.test("a handler exports issue, reconcile where its sink reconciles, and nothing else", async () => {
  const issueOnly = await file(`export const issue = async () => ({ done: 1 });`);
  await Handler.admit("charge", issueOnly, idempotent);
  await assertRejects(() => Handler.admit("charge", issueOnly, effect), Error, "must export exactly issue, reconcile");
  const both = await file(CHARGE);
  await assertRejects(() => Handler.admit("charge", both, idempotent), Error, "must export exactly issue");
  const extra = await file(`export const issue = () => 1; export const helper = 2;`);
  await assertRejects(
    () => Handler.admit("charge", extra, idempotent),
    Error,
    "it exports helper, issue",
  );
});

Deno.test("a handler is one file in the computation's language: no imports, no clock, no entropy", async () => {
  await assertRejects(
    async () => await Handler.admit("charge", await file(`import x from "npm:stripe"; export const issue = x;`), idempotent),
    Error,
    "a handler is one file",
  );
  const transport = recording(() => ({ status: 200, body: null })).transport;
  for (const body of ["Date.now()", "Math.random()", "new Date().getHours()"]) {
    const h = await Handler.admit("charge", await file(`export const issue = async () => ({ done: ${body} });`), idempotent);
    await assertRejects(() => h.call("issue", {}, "k", transport), Error, "a computation");
  }
  // The host's powers are not in the compartment: the names read as undefined.
  const h = await Handler.admit(
    "charge",
    await file(`export const issue = async () => ({ done: [typeof Deno, typeof fetch, typeof postMessage, typeof self].join() });`),
    idempotent,
  );
  assertEquals(await h.call("issue", {}, "k", transport), { done: "undefined,undefined,undefined,undefined" });
});

Deno.test("the input is frozen: a handler cannot rewrite what the ledger holds", async () => {
  const h = await Handler.admit("charge", await file(`export const issue = async (r) => { r.amount = 0; return { done: r }; };`), idempotent);
  await assertRejects(() => h.call("issue", { amount: 5 }, "k", recording(() => ({ status: 200, body: null })).transport), Error, "amount");
});

Deno.test("an answer that is not {done} or {failed} is refused, {absent} from reconcile alone", async () => {
  const transport = recording(() => ({ status: 200, body: null })).transport;
  for (const answer of ["{ ok: true }", "{ done: 1, failed: 2 }", "{ absent: true }", "null"]) {
    const h = await Handler.admit("charge", await file(`export const issue = async () => (${answer});`), idempotent);
    await assertRejects(() => h.call("issue", {}, "k", transport), Error, "not {done} or {failed}");
  }
});

Deno.test("a handler that never answers is cut off", async () => {
  const h = await Handler.admit("charge", await file(`export const issue = () => new Promise(() => {});`), idempotent, 200);
  await assertRejects(() => h.call("issue", {}, "k", recording(() => ({ status: 200, body: null })).transport), Error, "no answer in 200ms");
});

Deno.test("a sink path is absolute and plain: no URL, no empty or dot segment, no escape in the path", () => {
  for (const ok of ["/", "/v1/charges", "/v1/charges?key=charge%3Ap1&x=1", "/a.b/c-d_e~f"]) assertEquals(sinkPath(ok), ok);
  for (
    const bad of [
      "v1/charges",
      "https://evil.example/x",
      "//evil.example/x",
      "/../../v1.0/invoke/https://evil.example/method/x",
      "/a/./b",
      "/a/..",
      "/%2e%2e/x",
      "/a%2Fb",
      "/a b",
      "/a#b",
      42,
    ]
  ) {
    assertThrows(() => sinkPath(bad), TypeError, "sink path");
  }
});

Deno.test("a sink method outside the HTTP verbs never reaches the transport", async () => {
  const h = await Handler.admit("charge", await file(`export const issue = async (r, sink) => ({ done: await sink.fetch("/", { method: "CONNECT" }) });`), idempotent);
  const { calls, transport } = recording(() => ({ status: 200, body: null }));
  await assertRejects(() => h.call("issue", {}, "k", transport), Error, "sink method");
  assertEquals(calls, []);
});

Deno.test("a handler is handed its effect's secrets, and signs with them through Crypto", async () => {
  const h = await Handler.admit(
    "charge",
    await file(`export const issue = async (input, sink, secrets) => {
      const key = await Crypto.importKey("raw", new TextEncoder().encode(secrets.CAL_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await Crypto.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(input))));
      const signature = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
      return { done: { signature, names: Object.keys(secrets), frozen: Object.isFrozen(secrets) } };
    };`),
    signing,
  );
  const answer = await h.call("issue", { amount: 1250 }, "k", recording(() => ({ status: 200, body: null })).transport, { CAL_KEY: "whsec_oracle" });
  const { createHmac } = await import("node:crypto");
  assertEquals(answer, {
    done: { signature: createHmac("sha256", "whsec_oracle").update(JSON.stringify({ amount: 1250 })).digest("hex"), names: ["CAL_KEY"], frozen: true },
  });
});

Deno.test("a credential's header reaches the transport on every call, and the handler never sees it", async () => {
  const h = await Handler.admit("charge", await file(`export const issue = async (input, sink, secrets) => {
    const r = await sink.fetch("/v1/charges", { method: "POST", body: input });
    return { done: { secrets: Object.keys(secrets), sink: Object.keys(sink) } };
  };`), idempotent);
  const rec = recording(() => ({ status: 200, body: null }));
  const answer = await h.call("issue", { amount: 1 }, "k", rec.transport, {}, { Authorization: "Bearer vk" });
  assertEquals(rec.calls.map((c) => c.headers), [{ Authorization: "Bearer vk" }]);
  assertEquals(answer, { done: { secrets: [], sink: ["key", "origin", "fetch", "blob"] } });
});

Deno.test("an effect that declares no secrets hands its handler none, and the sink signs nothing", async () => {
  const h = await Handler.admit("charge", await file(`export const issue = async (r, sink, secrets) => ({ done: [Object.keys(secrets).length, typeof sink.sign] });`), idempotent);
  assertEquals(await h.call("issue", {}, "k", recording(() => ({ status: 200, body: null })).transport), { done: [0, "undefined"] });
});

Deno.test("a handler reaches Crypto only where its effect declares it", async () => {
  const transport = recording(() => ({ status: 200, body: null })).transport;
  const source = `export const issue = async () => ({ done: typeof Crypto.sign });`;
  assertEquals(await (await Handler.admit("charge", await file(source), signing)).call("issue", {}, "k", transport), { done: "function" });
  await assertRejects(
    async () => await (await Handler.admit("charge", await file(source), idempotent)).call("issue", {}, "k", transport),
    Error,
    "Crypto is not endowed",
  );
  await assertRejects(() => Handler.admit("charge", "unused.js", { ...idempotent, endowments: ["Intl"] }), Error, "are not a list drawn from");
});

async function meshCall(answer: Response, call: (transport: Transport) => Promise<unknown>) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    sent.push({ url: String(url), init: init! });
    return Promise.resolve(answer);
  };
  try {
    return { sent, result: await call(meshTransport("http://mesh")) };
  } finally {
    globalThis.fetch = fetched;
  }
}

Deno.test("the mesh transport invokes the effect's endpoint, the host's key last, so a credential cannot name it", async () => {
  const { sent } = await meshCall(Response.json({}), (t) => t("charge", "/v1/charges?x=1", { method: "POST", body: { amount: 1 } }, "charge:p1", { "Idempotency-Key": "other", "X-Api-Key": "vk" }));
  assertEquals(sent[0].url, "http://mesh/v1.0/invoke/charge/method/v1/charges?x=1");
  assertEquals(sent[0].init.method, "POST");
  assertEquals(sent[0].init.body, '{"amount":1}');
  assertEquals(sent[0].init.headers, { Accept: "application/json", "X-Api-Key": "vk", "Idempotency-Key": "charge:p1", "Content-Type": "application/json" });
});

Deno.test("the mesh transport sends a declared content type's string as it is", async () => {
  const { sent } = await meshCall(new Response("ok"), (t) => t("form", "/v1/sessions", { method: "POST", body: "a=1&b=2", contentType: "application/x-www-form-urlencoded" }, "k", {}));
  assertEquals(sent[0].init.body, "a=1&b=2");
  assertEquals((sent[0].init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
});

Deno.test("a sink's own 500 is its answer; daprd's is not", async () => {
  const sink = await meshCall(Response.json({ error: "down" }, { status: 500 }), (t) => t("charge", "/x", { method: "GET" }, "k", {}));
  assertEquals(sink.result, { status: 500, body: { error: "down" } });
  const refused = { status: 402, body: "declined" };
  assertEquals((await meshCall(new Response("declined", { status: 402 }), (t) => t("charge", "/x", { method: "GET" }, "k", {}))).result, refused);
  const daprd = (message: string) => Response.json({ errorCode: "ERR_DIRECT_INVOKE", message }, { status: 500 });
  await assertRejects(() => meshCall(daprd('failed to invoke, id: charge, err: Post "https://x": EOF'), (t) => t("charge", "/x", { method: "POST", body: {} }, "k", {})), Error, "daprd answered");
  // The daprd's refusal at any status is the mesh's error, never read as the sink's answer.
  const walled = Response.json({ errorCode: "ERR_API_NOT_ALLOWED", message: "the API is not allowed" }, { status: 403 });
  await assertRejects(() => meshCall(walled, (t) => t("charge", "/x", { method: "POST", body: {} }, "k", {})), Error, "daprd answered");
  await assertRejects(() => meshCall(daprd("failed to invoke, id: charge, err: circuit breaker is open"), (t) => t("charge", "/x", { method: "POST", body: {} }, "k", {})), BreakerOpen);
});

Deno.test("an open breaker ends the call past the handler, unless the handler already reached the sink", async () => {
  const path = await file(`export const issue = async (input, sink) => {
    for (const p of ["/a", "/b"]) {
      try { await sink.fetch(p, { method: "POST", body: {} }); } catch (e) { return { done: "caught " + e.message }; }
    }
    return { done: "both" };
  };`);
  const h = await Handler.admit("charge", path, idempotent);
  const open = () => {
    throw new BreakerOpen("open");
  };
  await assertRejects(() => h.call("issue", {}, "k", open), BreakerOpen);
  let n = 0;
  const second: Transport = () => n++ === 0 ? Promise.resolve({ status: 200, body: null }) : Promise.reject(new BreakerOpen("open"));
  assertEquals(await h.call("issue", {}, "k", second), { done: "caught open" });
  // A call still in flight may have reached the sink: one beside it that meets
  // the breaker is the handler's throw, not a run given back.
  const both = await file(`export const issue = async (input, sink) => {
    try { await Promise.all([sink.fetch("/a", { method: "POST", body: {} }), sink.fetch("/b", { method: "POST", body: {} })]); } catch (e) { return { done: "caught " + e.message }; }
    return { done: "both" };
  };`);
  let m = 0;
  const beside: Transport = () => m++ === 0 ? new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: null }), 20)) : Promise.reject(new BreakerOpen("open"));
  assertEquals(await (await Handler.admit("charge", both, idempotent)).call("issue", {}, "k", beside), { done: "caught open" });
});

Deno.test("a declared Cheerio endowment parses without opening another network door", async () => {
	const path = await file(`export function issue(input) {
    const $ = Cheerio.load(input.html);
    return {done: {text: $('p').text(), loader: typeof Cheerio.fromURL}};
  }`);
	try {
		const handler = await Handler.admit("parse", path, {
			...idempotent,
			endowments: ["Cheerio"],
		});
		const { transport, calls } = recording(() => {
			throw new Error("unexpected network");
		});
		assertEquals(
			await handler.call(
				"issue",
				{ html: "<p>Hello</p>" },
				"parse:1",
				transport,
			),
			{ done: { text: "Hello", loader: "undefined" } },
		);
		assertEquals(calls, []);
	} finally {
		await Deno.remove(path);
	}
});

// A whole 1×1 JPEG, as the print checkout stores each card's artwork.
const JPEG = Uint8Array.from(
  atob("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="),
  (c) => c.charCodeAt(0),
);

Deno.test("a handler reads its input's blobs by content key, sends a PDF of them as base64, and knows its door", async () => {
  const key = `${[...new Uint8Array(await crypto.subtle.digest("SHA-256", JPEG))].map((b) => b.toString(16).padStart(2, "0")).join("")}.jpg`;
  const reads: string[] = [];
  const blobs: BlobStore = {
    put: () => Promise.reject(new Error("unexpected put")),
    get: (k) => (reads.push(k), Promise.resolve(JPEG)),
    url: (k) => k,
  };
  const path = await file(`export async function issue(input, sink) {
    const jpeg = await sink.blob(input.artwork[0]);
    const pdf = await Pdf.fromJpegs({ size: { width: 10, height: 10 }, pages: [{ jpeg, x: 0, y: 0, width: 10, height: 10 }] });
    const r = await sink.fetch("/send", { method: "POST", body: { attachments: [{ content: pdf, type: "application/pdf" }] } });
    return { done: { body: r.body, origin: sink.origin } };
  }`);
  try {
    const handler = await Handler.admit("mail", path, { ...idempotent, endowments: ["Pdf"] });
    const { transport, calls } = recording(() => ({ status: 200, body: "sent" }));
    assertEquals(await handler.call("issue", { artwork: [key] }, "mail:1", transport, {}, {}, { blobs, origin: "https://app.example" }), { done: { body: "sent", origin: "https://app.example" } });
    assertEquals(reads, [key]);
    const sent = JSON.parse(encodedBody(undefined, calls[0].init.body));
    const pdf = Uint8Array.from(atob(sent.attachments[0].content), (c) => c.charCodeAt(0));
    assertEquals(new TextDecoder().decode(pdf.subarray(0, 5)), "%PDF-");
    await assertRejects(() => handler.call("issue", { artwork: ["a.jpg"] }, "mail:2", transport, {}, {}, { blobs }), Error, "only a content key");
    // Regression: the airlock refused to start without ORIGIN, so a Cloud Run
    // release that gives it none ran no effect at all; only a link back needs it.
    await assertRejects(() => handler.call("issue", { artwork: [key] }, "mail:3", transport, {}, {}, { blobs }), Error, "names no origin");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("a handler sets its own headers on a sink call, never one the host or HTTP sets", async () => {
  const asking = (headers: unknown) => file(`export const issue = async (input, sink) => {
    await sink.fetch("/v1/images/generations", { method: "POST", body: {}, headers: ${JSON.stringify(headers)} });
    return { done: null };
  };`);
  const rec = recording(() => ({ status: 200, body: null }));
  const h = await Handler.admit("charge", await asking({ "X-Bf-Passthrough-Extra-Params": "true" }), idempotent);
  await h.call("issue", {}, "k", rec.transport, {}, { Authorization: "Bearer vk" });
  assertEquals(rec.calls.map((c) => [c.init.headers, c.headers]), [[{ "X-Bf-Passthrough-Extra-Params": "true" }, { Authorization: "Bearer vk" }]]);
  // A lowercase name, the ledger key, a target of daprd's own and the credential
  // would each let the handler unsay what the host says.
  for (const refused of [{ "x-lower": "1" }, { "Idempotency-Key": "other" }, { "Dapr-App-Id": "elsewhere" }, { path: "/elsewhere" }, { Authorization: "Bearer mine" }, { "X-Bad": "a\nb" }, ["X-A"]]) {
    const none = recording(() => ({ status: 200, body: null }));
    const bad = await Handler.admit("charge", await asking(refused), idempotent);
    await assertRejects(() => bad.call("issue", {}, "k", none.transport, {}, { Authorization: "Bearer vk" }), Error, "sink header");
    assertEquals(none.calls, []);
  }
});

Deno.test("a declared content type reaches the sink's call, and its body is the handler's own string", async () => {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/form.js`;
  await Deno.writeTextFile(file, `export async function issue(input, sink) { return { done: (await sink.fetch("/v1/sessions", { method: "POST", body: input.form })).body }; }`);
  const sent: unknown[] = [];
  const transport: Transport = (_e, _p, init) => {
    sent.push(init);
    return Promise.resolve({ status: 200, body: "ok" });
  };
  const handler = await Handler.admit("form", file, { ...idempotent, contentType: "application/x-www-form-urlencoded" });
  await handler.call("issue", { form: "a=1&b=2" }, "form:1", transport);
  assertEquals(sent, [{ method: "POST", body: "a=1&b=2", headers: {}, contentType: "application/x-www-form-urlencoded" }]);
  await Deno.remove(dir, { recursive: true });
});

