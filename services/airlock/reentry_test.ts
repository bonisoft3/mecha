import { assertEquals, assertThrows } from "@std/assert";
import { type Effect, encodedBody, ledgerKeySql, outcome, parseManifest, step, undeployed } from "./reentry.ts";

const effect = (over: Partial<Effect> = {}): Effect => ({
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
  ...over,
});

Deno.test("the first run issues, whatever the sink", () => {
  for (const e of [effect(), effect({ reentry: "unknown" }), effect({ idempotent: true, reentry: undefined })]) {
    assertEquals(step(e, 1), "issue");
  }
});

Deno.test("a later run follows the sink's declaration", () => {
  assertEquals(step(effect({ idempotent: true, reentry: undefined }), 2), "issue");
  assertEquals(step(effect({ reentry: "reconcile" }), 2), "reconcile");
  assertEquals(step(effect({ reentry: "unknown" }), 3), "unknown");
  assertEquals(step(effect({ reentry: "repeat" }), 2), "issue");
});

Deno.test("a run the ledger did not count is a broken protocol, not a first run", () => {
  assertThrows(() => step(effect(), 0), Error, "commits before a run");
});

Deno.test("done goes to onDone; failed and unknown both go to onError, told apart by kind", () => {
  assertEquals(outcome(effect(), { done: { charge: "ch_1" } }, false), {
    target: "settled", kind: "done", data: { charge: "ch_1" }, reconciled: false,
  });
  assertEquals(outcome(effect(), { failed: "card_declined" }, true), {
    target: "failed", kind: "failed", data: "card_declined", reconciled: true,
  });
  assertEquals(outcome(effect(), "unknown", false), { target: "failed", kind: "unknown", data: null, reconciled: false });
  assertThrows(() => outcome(effect(), { absent: true }, true), Error, "no outcome");
});

Deno.test("a manifest the airlock would misread is refused", () => {
  const manifest = (e: Record<string, unknown>, name = "charge") => JSON.stringify({ effects: { [name]: { ...effect(), ...e } } });
  assertEquals(Object.keys(parseManifest(manifest({}))), ["charge"]);
  for (
    const [e, why, name] of [
      [{ table: 'payment"; drop table x; --' }, "not an identifier"],
      [{ row: [] }, "row"],
      [{ key: [] }, "key"],
      [{ idempotent: true }, "declares no reentry"],
      // The reason for a repeat is the program's note, never a field on the wire.
      [{ reentry: { repeat: "the partner keeps the first and drops the rest" } }, "reentry"],
      [{ reentry: "again" }, "reentry"],
      [{ attempts: 0 }, "attempts"],
      [{}, "DNS label", "charge_card"],
    ] as [Record<string, unknown>, string, string?][]
  ) {
    assertThrows(() => parseManifest(manifest(e, name)), Error, why);
  }
  assertThrows(() => parseManifest("{}"), Error, "no `effects` map");
});

Deno.test("a content type is a media type other than the default, and its body the handler's encoded string", () => {
  const manifest = (contentType: unknown) => JSON.stringify({ effects: { charge: { ...effect(), contentType } } });
  assertEquals(parseManifest(manifest("application/x-www-form-urlencoded")).charge.contentType, "application/x-www-form-urlencoded");
  for (const bad of ["application/json", "form", "text/plain; charset=utf-8", 1]) assertThrows(() => parseManifest(manifest(bad)), Error, "contentType");
  assertEquals(encodedBody(undefined, { a: 1 }), '{"a":1}');
  assertEquals(encodedBody("application/x-www-form-urlencoded", "a=1"), "a=1");
  assertThrows(() => encodedBody("application/x-www-form-urlencoded", { a: 1 }), TypeError, "encoded string");
});

Deno.test("secrets are named by environment variables", () => {
  const manifest = (secrets: unknown) => JSON.stringify({ effects: { charge: { ...effect(), secrets } } });
  assertEquals(parseManifest(manifest(["CAL_WEBHOOK_SECRET"])).charge.secrets, ["CAL_WEBHOOK_SECRET"]);
  for (const bad of [["cal-secret"], [""], "CAL", [1]]) {
    assertThrows(() => parseManifest(manifest(bad)), Error, "secrets");
  }
});

Deno.test("a credential is a header name daprd forwards and neither the host nor HTTP sets, a scheme word and an environment variable's name", () => {
  const manifest = (credential: unknown) => JSON.stringify({ effects: { charge: { ...effect(), credential } } });
  assertEquals(parseManifest(manifest({ header: "Authorization", scheme: "Bearer", secret: "ACQUIRER_KEY" })).charge.credential, { header: "Authorization", scheme: "Bearer", secret: "ACQUIRER_KEY" });
  assertEquals(parseManifest(manifest({ header: "X-Api-Key", secret: "ACQUIRER_KEY" })).charge.credential?.scheme, undefined);
  // Daprd forwards a metadata key as a header only with its first letter
  // uppercase, so a lowercase name would reach the sink as nothing.
  const taken = ["x-api-key", "Idempotency-Key", "content-type", "Content-Length", "Host", "Accept", "Transfer-Encoding", "traceparent", "Tracestate", "baggage"].map((header) => ({ header, secret: "K" }));
  for (const bad of [{ header: "Authorization", secret: "acquirer-key" }, { header: "Auth orization", secret: "K" }, { header: "X", scheme: "Bearer token", secret: "K" }, "ACQUIRER_KEY", { secret: "K" }, ...taken]) {
    assertThrows(() => parseManifest(manifest(bad)), Error, "credential");
  }
});

Deno.test("an effect's endowments are drawn from what the cage can endow", () => {
  const manifest = (endowments: unknown) => JSON.stringify({ effects: { charge: { ...effect(), endowments } } });
  assertEquals(parseManifest(manifest(["Crypto", "TextEncoder"])).charge.endowments, ["Crypto", "TextEncoder"]);
  for (const bad of [["Intl"], ["Deno"], "Crypto"]) assertThrows(() => parseManifest(manifest(bad)), Error, "endowments");
});

Deno.test("a bridge not deployed on this target fails at once, to onError, saying which and where", () => {
  const released = effect({ bridge: { name: "sofascore", targets: ["cloudflare"], simulated: false } });
  assertEquals(undeployed(released, "cloudflare"), null);
  assertEquals(undeployed(released, "gcp"), {
    target: "failed",
    kind: "failed",
    data: { bridge: "sofascore", target: "gcp", reason: "not deployed" },
    reconciled: false,
  });
  // The local stack never runs the real container: only a simulator.
  assertEquals(undeployed(released, "local")?.data, { bridge: "sofascore", target: "local", reason: "not deployed" });
  assertEquals(undeployed(effect({ bridge: { name: "sofascore", targets: [], simulated: true } }), "local"), null);
  assertEquals(undeployed(effect(), undefined), null);
  // A bridge that names its targets cannot be judged by an airlock told none.
  assertThrows(() => undeployed(released, undefined), Error, "told none");
});

Deno.test("a bridge names release targets as DNS labels, and whether it is simulated", () => {
  const manifest = (bridge: unknown) => JSON.stringify({ effects: { charge: { ...effect(), bridge } } });
  assertEquals(parseManifest(manifest({ name: "mail", targets: [], simulated: true })).charge.bridge, { name: "mail", targets: [], simulated: true });
  for (const bad of [{ name: "mail", targets: ["local"], simulated: false }, { name: "Mail", targets: [], simulated: false }, { name: "mail", targets: [] }, { name: "mail", targets: [1], simulated: false }, "mail"]) {
    assertThrows(() => parseManifest(manifest(bad)), Error, "bridge");
  }
});

// The guard spells a ledger key as pronto's emit.cue #ledgerKeySql does; a
// settle compares a row's current fields with it, so the two must agree.
Deno.test("a row's current key is spelled as the guard spells the ledger's", () => {
  assertEquals(ledgerKeySql("draw", effect({ key: ["id"] })), `('draw:' || "id"::text)`);
  assertEquals(ledgerKeySql("draw", effect({ key: ["id", "run"] })), `('draw:' || jsonb_build_array("id"::text, "run"::text)::text)`);
  assertThrows(() => ledgerKeySql("draw'; --", effect()), Error, "DNS label");
});
