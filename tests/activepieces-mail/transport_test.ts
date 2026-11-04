import { assertEquals } from "@std/assert";
import { mailImage, startBridge } from "./harness.ts";

const mail = {
	from: "sender@oracle.example",
	to: ["to@oracle.example"],
	subject: "transport",
	text: "body",
};

Deno.test("SMTP refusal, timeout boundary and required STARTTLS never imply delivery", async (t) => {
	let mode = "recipient450";
	const commands: string[] = [];
	const messages: string[] = [];
	const listener = Deno.listen({ hostname: "0.0.0.0", port: 0 });
	const port = (listener.addr as Deno.NetAddr).port;
	const sessions: Promise<void>[] = [];
	const sockets = new Set<Deno.Conn>();
	const close = (connection: Deno.Conn) => {
		try {
			connection.close();
		} catch (error) {
			if (!(error instanceof Deno.errors.BadResource)) throw error;
		}
	};
	const accept = (async () => {
		for await (const connection of listener) {
			sockets.add(connection);
			sessions.push((async () => {
				const encoder = new TextEncoder();
				const send = (line: string) =>
					connection.write(encoder.encode(line + "\r\n"));
				try {
					await send("220 smtp.test ready");
					let buffer = "";
					let data = false;
					const message: string[] = [];
					for await (const chunk of connection.readable) {
						buffer += new TextDecoder().decode(chunk);
						let end: number;
						while ((end = buffer.indexOf("\r\n")) >= 0) {
							const line = buffer.slice(0, end);
							buffer = buffer.slice(end + 2);
							if (data) {
								if (line === ".") {
									data = false;
									messages.push(message.join("\r\n"));
									if (mode === "lostDataAck") {
										connection.close();
										return;
									}
									await send("250 2.0.0 Message accepted");
								} else message.push(line);
								continue;
							}
							commands.push(line);
							if (line.startsWith("EHLO")) {
								await send(
									mode === "auth535"
										? "250-smtp.test\r\n250 AUTH PLAIN LOGIN"
										: mode === "authUnavailable"
										? "250-smtp.test\r\n250 AUTH UNSUPPORTED"
										: "250 smtp.test",
								);
							} else if (line.startsWith("AUTH")) {
								if (mode === "authUnavailable") {
									connection.close();
									return;
								}
								await send("535 5.7.8 Authentication rejected");
							} else if (line.startsWith("MAIL")) {
								await send("250 sender accepted");
							} else if (line.startsWith("RCPT")) {
								await send(
									(mode === "accept" || mode === "lostDataAck" ||
											(mode === "partial450" &&
												line.includes("to@oracle.example")))
										? "250 recipient accepted"
										: mode === "mixed" &&
												line.includes("permanent")
										? "550 5.1.1 No such recipient"
										: "450 4.2.0 Temporarily unavailable",
								);
							} else if (line === "DATA") {
								data = true;
								await send("354 send message");
							} else if (line === "STARTTLS") {
								await send("502 STARTTLS unsupported");
							} else if (line === "QUIT") {
								await send("221 bye");
								return;
							} else await send("250 ok");
						}
					}
				} finally {
					sockets.delete(connection);
					close(connection);
				}
			})());
		}
	})();
	const host = mailImage ? "host.docker.internal" : "127.0.0.1";
	const send = async (
		url: string,
		to = mail.to,
		extras: Record<string, unknown> = {},
	) => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "transport:1",
			},
			body: JSON.stringify({ props: { message: { ...mail, to, ...extras } } }),
		});
		const body = await response.json();
		assertEquals(response.status, 200, JSON.stringify(body));
		return { status: body.result.status, body: body.result.receipt };
	};
	try {
		await t.step(
			"a temporary recipient refusal is temporary and is not retried",
			async () => {
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
				});
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "temporary-refusal");
					assertEquals(result.body.code, 450);
					assertEquals(commands.filter((x) => x.startsWith("RCPT")).length, 1);
					assertEquals(commands.includes("DATA"), false);
				} finally {
					await bridge.stop();
				}
			},
		);
		for (
			const recipients of [
				["permanent@oracle.example", "later@oracle.example"],
				["later@oracle.example", "permanent@oracle.example"],
				["permanent@oracle.example", "permanent2@oracle.example"],
			]
		) {
			await t.step(
				`all recipients refused: ${recipients.join(", ")}`,
				async () => {
					mode = "mixed";
					commands.length = 0;
					const bridge = await startBridge({
						MAIL_HOST: host,
						MAIL_PORT: String(port),
					});
					try {
						const result = await send(bridge.url, recipients);
						assertEquals(
							result.status,
							recipients.includes("later@oracle.example")
								? "temporary-refusal"
								: "permanent-refusal",
						);
						assertEquals(
							result.body.code,
							recipients[0].startsWith("permanent") ? 550 : 450,
						);
						assertEquals(
							commands.filter((x) => x.startsWith("RCPT")).length,
							2,
						);
						assertEquals(commands.includes("DATA"), false);
					} finally {
						await bridge.stop();
					}
				},
			);
		}
		await t.step(
			"partial acceptance includes temporarily unsent recipients without redelivery",
			async () => {
				mode = "partial450";
				commands.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
				});
				try {
					const result = await send(bridge.url, [
						"to@oracle.example",
						"later@oracle.example",
					]);
					assertEquals(result.status, "accepted");
					assertEquals(result.body.code, 250);
					assertEquals(result.body.accepted, ["to@oracle.example"]);
					assertEquals(result.body.rejected, ["later@oracle.example"]);
					assertEquals(commands.filter((x) => x.startsWith("RCPT")).length, 2);
					assertEquals(commands.filter((x) => x === "DATA").length, 1);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step(
			"lost DATA acknowledgement is uncertain and is not retried",
			async () => {
				mode = "lostDataAck";
				commands.length = 0;
				messages.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
				});
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "uncertain");
					assertEquals(Object.hasOwn(result.body, "code"), false);
					assertEquals(commands.filter((x) => x === "DATA").length, 1);
					assertEquals(messages.length, 1);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step(
			"Bcc stays in the envelope and is absent from SMTP DATA headers",
			async () => {
				mode = "accept";
				commands.length = 0;
				messages.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
				});
				try {
					const result = await send(bridge.url, mail.to, {
						cc: ["copy@oracle.example"],
						bcc: ["hidden@oracle.example"],
						replyTo: "reply@oracle.example",
					});
					assertEquals(result.status, "accepted");
					assertEquals(
						[...result.body.accepted].sort(),
						[
							"to@oracle.example",
							"copy@oracle.example",
							"hidden@oracle.example",
						].sort(),
					);
					assertEquals(commands.filter((x) => x.startsWith("RCPT")).length, 3);
					assertEquals(messages.length, 1);
					const headers = messages[0].split("\r\n\r\n")[0];
					assertEquals(/^Bcc:/im.test(headers), false);
					assertEquals(headers.includes("hidden@oracle.example"), false);
					assertEquals(/^Cc: copy@oracle.example$/im.test(headers), true);
					assertEquals(
						/^Reply-To: reply@oracle.example$/im.test(headers),
						true,
					);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step(
			"required STARTTLS fails before MAIL when server cannot negotiate it",
			async () => {
				commands.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
					MAIL_STARTTLS: "true",
				});
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "permanent-refusal");
					assertEquals(commands.some((x) => x.startsWith("MAIL")), false);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step(
			"authentication rejection is permanent and sends no message",
			async () => {
				mode = "auth535";
				commands.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
					MAIL_USER: "fixture",
					MAIL_PASSWORD: "fixture",
				});
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "permanent-refusal");
					assertEquals(result.body.code, 535);
					assertEquals(commands.some((x) => x.startsWith("MAIL")), false);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step(
			"authentication without an SMTP reply does not fabricate a server code",
			async () => {
				mode = "authUnavailable";
				commands.length = 0;
				const bridge = await startBridge({
					MAIL_HOST: host,
					MAIL_PORT: String(port),
					MAIL_USER: "fixture",
					MAIL_PASSWORD: "fixture",
				});
				try {
					const result = await send(bridge.url);
					assertEquals(result.status, "uncertain");
					assertEquals(Object.hasOwn(result.body, "code"), false);
					assertEquals(commands.some((x) => x.startsWith("MAIL")), false);
				} finally {
					await bridge.stop();
				}
			},
		);
		await t.step("unreachable SMTP is uncertain, not accepted", async () => {
			const unavailable = Deno.listen({ hostname: "0.0.0.0", port: 0 });
			const closed = (unavailable.addr as Deno.NetAddr).port;
			unavailable.close();
			const bridge = await startBridge({
				MAIL_HOST: host,
				MAIL_PORT: String(closed),
			});
			try {
				assertEquals((await send(bridge.url)).status, "uncertain");
			} finally {
				await bridge.stop();
			}
		});
	} finally {
		listener.close();
		for (const socket of sockets) socket.close();
		await accept;
		await Promise.all(sessions);
	}
});
