import { assertEquals, assertMatch } from "@std/assert";
import { docker, mailImage, ready, startBridge } from "./harness.ts";
const MAILPIT =
	"axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48";
const message = {
	from: "notifications@cal.example",
	to: ["ana@oracle.example", "bob@oracle.example"],
	subject: "Confirmação ✓",
	text: "See you — amanhã",
	html: "<p>See you — amanhã</p>",
	ical: {
		method: "REQUEST",
		content:
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:p1@test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
		filename: "réunion finale.ics",
	},
};

type MimePart = {
	headers: Record<string, string>;
	body: string;
	children: MimePart[];
};

function parseMime(raw: string): MimePart {
	const separator = raw.indexOf("\r\n\r\n");
	if (separator < 0) throw new Error("MIME part lacks headers");
	const headers: Record<string, string> = {};
	for (
		const line of raw.slice(0, separator).replace(/\r\n[ \t]+/g, " ").split(
			"\r\n",
		)
	) {
		const colon = line.indexOf(":");
		if (colon < 0) throw new Error(`Invalid MIME header: ${line}`);
		headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
	}
	const body = raw.slice(separator + 4);
	const contentType = headers["content-type"] ?? "text/plain";
	const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
	const children = boundary
		? body.split(`--${boundary[1] ?? boundary[2]}`).slice(1).filter((part) =>
			!part.startsWith("--")
		)
			.map((part) => parseMime(part.replace(/^\r\n/, "").replace(/\r\n$/, "")))
		: [];
	return { headers, body, children };
}

function decoded(part: MimePart): string {
	const encoding = part.headers["content-transfer-encoding"]?.toLowerCase();
	if (encoding === "base64") {
		return new TextDecoder().decode(
			Uint8Array.from(
				atob(part.body.replace(/\s/g, "")),
				(c) => c.charCodeAt(0),
			),
		);
	}
	if (encoding === "quoted-printable") {
		const value = part.body.replace(/=\r\n/g, "").replace(
			/=([0-9a-f]{2})/gi,
			(_, hex) => String.fromCharCode(parseInt(hex, 16)),
		);
		return new TextDecoder().decode(
			Uint8Array.from(value, (c) => c.charCodeAt(0)),
		);
	}
	return part.body;
}

function descendants(part: MimePart): MimePart[] {
	return [part, ...part.children.flatMap(descendants)];
}

Deno.test("Mail sends through SMTP", async (t) => {
	const name = `activepieces-mail-${crypto.randomUUID().slice(0, 8)}`;
	await docker("network", "create", name);
	await docker(
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		"--network",
		name,
		"-p",
		"127.0.0.1::1025",
		"-p",
		"127.0.0.1::8025",
		"-e",
		"MP_SMTP_ALLOWED_RECIPIENTS=@oracle\\.example$",
		MAILPIT,
	);
	try {
		const smtp = Number((await docker("port", name, "1025")).split(":").pop());
		const apiPort = Number(
			(await docker("port", name, "8025")).split(":").pop(),
		);
		const api = `http://127.0.0.1:${apiPort}/api/v1`;
		await ready(`${api}/messages`);
		const bridge = await startBridge({
			MAIL_HOST: mailImage ? name : "127.0.0.1",
			MAIL_PORT: String(mailImage ? 1025 : smtp),
		}, mailImage ? name : undefined);
		try {
			const url = bridge.url;
			const send = (body: unknown, key: string | null = "confirm:p1") =>
				fetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(key === null ? {} : { "idempotency-key": key }),
						"X-Untrusted": "must-not-cross",
					},
					body: JSON.stringify({ props: { message: body } }),
				});
			const digest = new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode("confirm:p1"),
				),
			);
			const expectedId = `<${
				Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("")
			}@airlock.example>`;
			await t.step(
				"stable identity, recipients, Unicode and plain/HTML reach Mailpit",
				async () => {
					const response = await send(message);
					assertEquals(response.status, 200, await response.clone().text());
					const result = (await response.json()).result;
					assertEquals(result.status, "accepted");
					const receipt = result.receipt;
					assertEquals(receipt.messageId, expectedId);
					assertEquals(receipt.code, 250);
					assertMatch(receipt.response, /^250 /);
					assertEquals(receipt.accepted, message.to);
					assertEquals(receipt.rejected, []);
					const { messages } = await (await fetch(`${api}/messages`)).json();
					assertEquals(messages.length, 1);
					const delivered =
						await (await fetch(`${api}/message/${messages[0].ID}`)).json();
					assertEquals(`<${delivered.MessageID}>`, expectedId);
					assertEquals(
						delivered.To.map((x: { Address: string }) => x.Address),
						message.to,
					);
					assertEquals(delivered.Subject, message.subject);
					assertEquals(delivered.Text.trim(), message.text);
					assertEquals(delivered.HTML.trim(), message.html);
					const raw =
						await (await fetch(`${api}/message/${messages[0].ID}/raw`)).text();
					assertMatch(raw, /multipart\/alternative/);
					assertEquals(raw.includes("must-not-cross"), false);
					const parts = descendants(parseMime(raw));
					const type = (part: MimePart) =>
						part.headers["content-type"]?.split(";")[0].toLowerCase();
					const alternative = parts.find((part) =>
						type(part) === "multipart/alternative"
					);
					if (!alternative) throw new Error("Missing multipart/alternative");
					const alternatives = descendants(alternative);
					for (const expected of ["text/plain", "text/html", "text/calendar"]) {
						assertEquals(
							alternatives.some((part) => type(part) === expected),
							true,
							expected,
						);
					}
					const calendar = alternatives.find((part) =>
						type(part) === "text/calendar"
					);
					if (!calendar) throw new Error("Missing calendar alternative");
					assertEquals(decoded(calendar), message.ical.content);
					const attachment = parts.find((part) =>
						type(part) === "application/ics"
					);
					if (!attachment) throw new Error("Missing calendar attachment");
					assertEquals(decoded(attachment), message.ical.content);

					assertMatch(
						raw,
						/Content-Type: text\/calendar\b/i,
					);
					assertMatch(raw, /method\s*=\s*"?REQUEST/i);
					assertMatch(raw, /Content-Type: application\/ics\b/i);
					assertEquals(
						delivered.Attachments.some((a: { FileName: string }) =>
							a.FileName === message.ical.filename
						),
						true,
						JSON.stringify(delivered.Attachments),
					);
				},
			);
			await t.step(
				"reentry preserves identity but does not pretend to deduplicate SMTP",
				async () => {
					const response = await send(message);
					assertEquals(response.status, 200);
					assertEquals(
						(await response.json()).result.receipt.messageId,
						expectedId,
					);
					assertEquals(
						(await (await fetch(`${api}/messages`)).json()).total,
						2,
					);
				},
			);
			await t.step("plain text needs neither HTML nor calendar", async () => {
				const response = await send({
					from: message.from,
					to: message.to,
					subject: "Plain",
					text: "Only plain",
				}, "confirm:plain");
				assertEquals(response.status, 200, await response.clone().text());
				await response.body?.cancel();
			});
			await t.step(
				"reject missing identity, injected headers and invalid calendar before SMTP",
				async () => {
					for (
						const [body, key] of [
							[message, null],
							[
								{ ...message, subject: "x\r\nBcc: evil@example.com" },
								"invalid",
							],
							[{ ...message, to: [] }, "invalid"],
							[{ ...message, to: ["bad"] }, "invalid"],
							[{ ...message, unexpected: true }, "invalid"],
							[{
								...message,
								ical: { method: "bad", content: "BEGIN:VCALENDAR" },
							}, "invalid"],
						] as const
					) {
						const response = await send(body, key);
						assertEquals(response.status, 400, await response.clone().text());
						await response.body?.cancel();
					}
					const malformed = await fetch(url, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"idempotency-key": "invalid",
						},
						body: "{",
					});
					assertEquals(malformed.status, 400, await malformed.clone().text());
					await malformed.body?.cancel();
					assertEquals(
						(await (await fetch(`${api}/messages`)).json()).total,
						3,
					);
				},
			);
			await t.step(
				"permanent rejection preserves the server code and sends nothing",
				async () => {
					const response = await send({
						...message,
						to: ["no@refused.example"],
					}, "confirm:refused");
					assertEquals(response.status, 200, await response.clone().text());
					const result = (await response.json()).result;
					assertEquals(result.status, "permanent-refusal");
					const receipt = result.receipt;
					assertEquals(receipt.code, 550);
					assertEquals(
						(await (await fetch(`${api}/messages`)).json()).total,
						3,
					);
				},
			);
			await t.step(
				"partial recipient acceptance is reported without repeating delivery",
				async () => {
					const response = await send({
						...message,
						to: ["ana@oracle.example", "no@refused.example"],
					}, "confirm:partial");
					assertEquals(response.status, 200, await response.clone().text());
					const result = (await response.json()).result;
					assertEquals(result.status, "accepted");
					const receipt = result.receipt;
					assertEquals(receipt.accepted, ["ana@oracle.example"]);
					assertEquals(receipt.rejected, ["no@refused.example"]);
					assertEquals(
						(await (await fetch(`${api}/messages`)).json()).total,
						4,
					);
				},
			);
			await t.step(
				"Cc/Bcc envelope and Reply-To reach the mail server",
				async () => {
					const cc = "cc@oracle.example", bcc = "hidden@oracle.example";
					const response = await send({
						...message,
						cc: [cc],
						bcc: [bcc],
						replyTo: "reply@oracle.example",
					}, "confirm:privacy");
					assertEquals(response.status, 200, await response.clone().text());
					const result = (await response.json()).result;
					assertEquals(result.status, "accepted");
					const receipt = result.receipt;
					assertEquals(receipt.accepted, [...message.to, cc, bcc]);
					assertEquals(receipt.messageId === expectedId, false);
					const { messages } = await (await fetch(`${api}/messages`)).json();
					assertEquals(messages.length, 5);
					const raw =
						await (await fetch(`${api}/message/${messages[0].ID}/raw`)).text();
					assertMatch(raw, /Cc: cc@oracle.example/);
					assertMatch(raw, /Reply-To: reply@oracle.example/);
				},
			);
		} finally {
			await bridge.stop();
		}
	} finally {
		await docker("rm", "-f", name);
		await docker("network", "rm", name);
	}
});
