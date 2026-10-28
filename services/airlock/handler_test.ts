// The cage a handler runs in and the one door out of it, with the transport
// faked: what the handler may name, what reaches the transport, and what
// answers are accepted.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { bindingsTransport, Handler, sinkPath, type Transport } from "./handler.ts";
import type { Effect } from "./reentry.ts";

const effect: Effect = {
  table: "payment",
  field: "status",
  state: "charging",
  onDone: "settled",
  onError: "failed",
  row: ["id"],
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

type Call = { endpoint: string; path: string; init: { method: string; body?: unknown }; key: string; headers: Record<string, string> };
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
    init: { method: "POST", body: { amount: 1250, key: "charge:p1" } },
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
  assertEquals(answer, { done: { secrets: [], sink: ["key", "fetch"] } });
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

Deno.test("the bindings transport sends the host's metadata last, so a credential names neither the path nor the key", async () => {
  const sent: unknown[] = [];
  const fetched = globalThis.fetch;
  globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(init!.body as string));
    return Promise.resolve(new Response("{}", { status: 200, headers: { "metadata.statuscode": "200", "metadata.content-type": "application/json" } }));
  };
  try {
    const transport = bindingsTransport("http://mesh");
    await transport("charge", "/v1/charges", { method: "POST", body: { amount: 1 } }, "charge:p1", { path: "/elsewhere", "Idempotency-Key": "other", "X-Api-Key": "vk" });
    assertEquals(sent, [{ operation: "post", data: { amount: 1 }, metadata: { "X-Api-Key": "vk", path: "/v1/charges", "Idempotency-Key": "charge:p1", "Content-Type": "application/json" } }]);
  } finally {
    globalThis.fetch = fetched;
  }
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
