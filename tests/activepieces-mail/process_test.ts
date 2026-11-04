import { assertEquals, assertRejects } from "@std/assert";
import { terminateTree } from "./process.ts";

Deno.test("a stalled launcher and its server descendant are both terminated", async () => {
	const server =
		"Deno.serve({hostname:'127.0.0.1',port:0,onListen:({port})=>console.log(port)},()=>new Response('alive'));";
	const launcher = new Deno.Command(Deno.execPath(), {
		args: [
			"eval",
			`new Deno.Command(Deno.execPath(), {args:['eval',${
				JSON.stringify(server)
			}],stdout:'inherit',stderr:'null'}).spawn(); setInterval(()=>{},1000);`,
		],
		stdout: "piped",
		stderr: "inherit",
	}).spawn();
	let finished = false;
	const status = launcher.status.then((result) => {
		finished = true;
		return result;
	});
	const reader = launcher.stdout.pipeThrough(new TextDecoderStream())
		.getReader();
	try {
		const { value } = await reader.read();
		const port = Number(value?.trim());
		assertEquals(Number.isInteger(port) && port > 0, true);
		const response = await fetch(`http://127.0.0.1:${port}`);
		assertEquals(await response.text(), "alive");
		await terminateTree(launcher.pid);
		assertEquals((await status).success, false);
		await assertRejects(
			() =>
				fetch(`http://127.0.0.1:${port}`, {
					signal: AbortSignal.timeout(1000),
				}),
			TypeError,
		);
	} finally {
		if (!finished) await terminateTree(launcher.pid);
		await status;
		await reader.cancel();
	}
});
