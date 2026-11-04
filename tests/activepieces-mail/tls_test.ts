import { assertEquals } from "@std/assert";
import { cwd, docker, mailImage, ready, startBridge } from "./harness.ts";
const MAILPIT =
	"axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48";

Deno.test("SMTP authenticates only over verified required STARTTLS", async (t) => {
	const name = `mail-tls-${crypto.randomUUID().slice(0, 8)}`;
	const fixtures = decodeURIComponent(new URL("fixtures", cwd).pathname)
		.replace(/^\/([A-Za-z]:)/, "$1");
	await docker("network", "create", name);
	await docker(
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--network",
		name,
		"--network-alias",
		"smtp.mailpit.test",
		"--network-alias",
		"wrong-name.test",
		"-p",
		"127.0.0.1::1025",
		"-p",
		"127.0.0.1::8025",
		"-v",
		`${fixtures}:/fixtures:ro`,
		"-e",
		"MP_SMTP_TLS_CERT=/fixtures/smtp-cert.pem",
		"-e",
		"MP_SMTP_TLS_KEY=/fixtures/smtp-key.pem",
		"-e",
		"MP_SMTP_REQUIRE_STARTTLS=true",
		"-e",
		"MP_SMTP_AUTH=fixture:fixture",
		MAILPIT,
	);
	try {
		const port = Number((await docker("port", name, "1025")).split(":").pop());
		const apiPort = Number(
			(await docker("port", name, "8025")).split(":").pop(),
		);
		const api = `http://127.0.0.1:${apiPort}/api/v1/messages`;
		await ready(api);
		const config = {
			MAIL_HOST: mailImage ? "smtp.mailpit.test" : "127.0.0.1",
			MAIL_PORT: String(mailImage ? 1025 : port),
			MAIL_STARTTLS: "true",
			MAIL_USER: "fixture",
			MAIL_PASSWORD: "fixture",
		};
		const send = async (url: string) => {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "tls:1",
				},
				body: JSON.stringify({
					props: {
						message: {
							from: "from@oracle.example",
							to: ["to@oracle.example"],
							subject: "TLS",
							text: "Verified",
						},
					},
				}),
			});
			const text = await response.text();
			if (!response.headers.get("content-type")?.includes("application/json")) {
				throw new Error(`HTTP ${response.status}: ${text}`);
			}
			const body = JSON.parse(text);
			assertEquals(response.status, 200, text);
			return { status: body.result.status, body: body.result.receipt };
		};
		await t.step("untrusted certificate prevents delivery", async () => {
			const bridge = await startBridge(config, mailImage ? name : undefined);
			try {
				const result = await send(bridge.url);
				assertEquals(result.status, "uncertain", JSON.stringify(result));
				assertEquals((await (await fetch(api)).json()).total, 0);
			} finally {
				await bridge.stop();
			}
		});
		await t.step(
			"trusted certificate and configured credentials permit one delivery",
			async () => {
				const bridge = await startBridge(
					config,
					mailImage ? name : undefined,
					true,
				);
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "accepted", JSON.stringify(result));
					assertEquals(result.body.code, 250);
					assertEquals((await (await fetch(api)).json()).total, 1);
				} finally {
					await bridge.stop();
				}
			},
		);
		if (mailImage) {
			await t.step(
				"a trusted certificate for another hostname is rejected",
				async () => {
					const bridge = await startBridge(
						{ ...config, MAIL_HOST: "wrong-name.test" },
						name,
						true,
					);
					try {
						const result = await send(bridge.url);
						assertEquals(result.status, "uncertain", JSON.stringify(result));
						assertEquals((await (await fetch(api)).json()).total, 1);
					} finally {
						await bridge.stop();
					}
				},
			);
		}
	} finally {
		await docker("rm", "-f", name);
		await docker("network", "rm", name);
	}
});
