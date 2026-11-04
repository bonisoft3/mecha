const input = JSON.parse(await new Response(Deno.stdin.readable).text());
if (input.probe) {
	const registry = await import(input.registry);
	for (const entry of input.probe) {
		if (!registry.pieces?.[entry.piece]?.getAction(entry.action)) {
			throw new Error("Action unavailable");
		}
	}
	Deno.exit(0);
}
const conn = await Deno.connect({ hostname: "127.0.0.1", port: input.port });
const writer = conn.writable.getWriter();
await writer.write(new TextEncoder().encode(input.token + "\n"));
try {
	const registry = await import(input.registry);
	const action = registry.pieces[input.piece]?.getAction(input.action);
	if (!action) throw new Error("Action unavailable");
	const context = new Proxy({ propsValue: input.props, auth: input.auth }, {
		get(target, property) {
			if (property === "propsValue" || property === "auth") {
				return target[property];
			}
			throw new Error("Unsupported context capability");
		},
	});
	const result = await action.run(context);
	await writer.write(new TextEncoder().encode(JSON.stringify({ result })));
} finally {
	await writer.close();
}
