import { handler, prepare } from "./runner.ts";
const registry = new URL("./fixture.ts", import.meta.url).pathname;
const manifest = () => ({
	version: 1,
	limits: {
		timeoutMs: 1000,
		maxConcurrent: 1,
		maxRequestBytes: 1024,
		maxResultBytes: 1024,
	},
	actions: {
		test: {
			piece: "fixture",
			action: "run",
			inputSchema: { type: "object" },
			outputSchema: { type: "object" },
			auth: {
				jsonSecret: "SECRET",
				schema: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
				},
			},
			fixedProps: { fixed: true },
			idempotencyKeyProp: "key",
		},
	},
});
const assert = (value: unknown, message = "assertion failed") => {
	if (!value) throw new Error(message);
};
const request = (body: string, path = "/actions/test/", key = "identity") =>
	new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Idempotency-Key": key },
		body,
	});
const env = (name: string) =>
	name === "SECRET"
		? '{"value":"selected"}'
		: name === "OTHER_SECRET"
		? "hidden"
		: undefined;
Deno.test("validates admission, isolates auth and keeps logs out of results", async () => {
	const run = handler(prepare(manifest()), registry, env);
	assert((await run(request("{}"))).status === 400);
	assert((await run(request('{"props":{"fixed":true}}'))).status === 400);
	assert((await run(request('{"props":{"key":"other"}}'))).status === 400);
	assert(
		(await run(request('{"props":{}}', "/actions/test/extra"))).status === 404,
	);
	assert(
		(await run(request('{"props":{}}', "/actions/test/", ""))).status === 400,
	);
	assert((await run(request("x".repeat(1025)))).status === 413);
	const response = await run(request('{"props":{}}'));
	assert(response.status === 200, await response.clone().text());
	const result = (await response.json()).result;
	assert(
		result.props.fixed && result.props.key === "identity" &&
			result.auth.value === "selected" && result.inherited === null,
	);
});
Deno.test("bounds failures, deadline and concurrency", async () => {
	const config = manifest();
	config.limits.timeoutMs = 500;
	const run = handler(prepare(config), registry, env);
	const hanging = run(request('{"props":{"mode":"hang"}}'));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert((await run(request('{"props":{}}'))).status === 503);
	const timed = await hanging;
	assert(
		timed.status === 503 && (await timed.json()).error.kind === "deadline",
	);
	const invalid = await run(request('{"props":{"mode":"invalid"}}'));
	assert(
		invalid.status === 503 &&
			(await invalid.json()).error.kind === "invalid_output",
	);
	const large = await run(request('{"props":{"mode":"large"}}'));
	assert(large.status === 503);
	assert((await run(request('{"props":{}}'))).status === 200);
});
Deno.test("rejects remote references and invalid auth", async () => {
	const bad = manifest();
	bad.actions.test.inputSchema = {
		$ref: "https://example.com/schema",
	} as unknown as typeof bad.actions.test.inputSchema;
	let rejected = false;
	try {
		prepare(bad);
	} catch {
		rejected = true;
	}
	assert(rejected);
	const run = handler(prepare(manifest()), registry, () => "{}");
	assert((await run(request('{"props":{}}'))).status === 503);
});

Deno.test("registry admission rejects missing actions", async () => {
	const { probe } = await import("./runner.ts");
	const config = manifest();
	await probe(prepare(config), registry);
	config.actions.test.action = "missing";
	let rejected = false;
	try {
		await probe(prepare(config), registry);
	} catch {
		rejected = true;
	}
	assert(rejected);
});

Deno.test("disconnect cancels the child and releases capacity", async () => {
	const config = manifest();
	const run = handler(prepare(config), registry, env);
	const controller = new AbortController();
	const req = new Request("http://localhost/actions/test/", {
		method: "POST",
		headers: { "Idempotency-Key": "key" },
		body: '{"props":{"mode":"hang"}}',
		signal: controller.signal,
	});
	const pending = run(req);
	await new Promise((resolve) => setTimeout(resolve, 75));
	controller.abort();
	const response = await pending;
	assert(
		response.status === 503 &&
			(await response.json()).error.kind === "disconnected",
	);
	assert((await run(request('{"props":{}}'))).status === 200);
});

Deno.test("validates every declared secret before readiness", async () => {
	const { validateSecrets } = await import("./runner.ts");
	const config = prepare(manifest());
	validateSecrets(config, env);
	for (const secret of [undefined, "not-json", "{}"]) {
		let rejected = false;
		try {
			validateSecrets(config, () => secret);
		} catch {
			rejected = true;
		}
		assert(rejected);
	}
});

Deno.test("slow bodies occupy capacity and are cancelled at the invocation deadline", async () => {
	const config = manifest();
	config.limits.timeoutMs = 250;
	const run = handler(prepare(config), registry, env);
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const req = new Request("http://localhost/actions/test/", {
		method: "POST",
		headers: { "Idempotency-Key": "key" },
		body,
	});
	const pending = run(req);
	const full = await run(request('{"props":{}}'));
	assert(full.status === 503 && (await full.json()).error.kind === "capacity");
	const expired = await pending;
	assert(
		expired.status === 503 && (await expired.json()).error.kind === "deadline",
	);
	assert(cancelled);
	assert((await run(request('{"props":{}}'))).status === 200);
});

Deno.test("invalid and disconnected bodies release admission capacity", async () => {
	const run = handler(prepare(manifest()), registry, env);
	assert((await run(request("{"))).status === 400);
	let cancelled = false;
	const controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const req = new Request("http://localhost/actions/test/", {
		method: "POST",
		headers: { "Idempotency-Key": "key" },
		body,
		signal: controller.signal,
	});
	const pending = run(req);
	controller.abort();
	const response = await pending;
	assert(
		response.status === 503 &&
			(await response.json()).error.kind === "disconnected",
	);
	assert(cancelled);
	assert((await run(request('{"props":{}}'))).status === 200);
});
