import { handler, prepare, probe, validateSecrets } from "./runner.ts";
const manifest = Deno.env.get("ACTIVEPIECES_MANIFEST") ?? "/app/manifest.json";
const registry = Deno.env.get("ACTIVEPIECES_REGISTRY") ?? "/app/registry.ts";
const port = Number(Deno.env.get("PORT") ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error("Invalid port");
}
const config = prepare(JSON.parse(await Deno.readTextFile(manifest)));
validateSecrets(config);
await probe(config, registry);
Deno.serve({ hostname: ["local", "host"].includes(Deno.env.get("SAYT_PLATFORM") ?? "") ? "127.0.0.1" : "0.0.0.0", port }, handler(config, registry));
