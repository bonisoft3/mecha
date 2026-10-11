// The mail bridge against a real SMTP server, Mailpit, whose API says what
// arrived. Mailpit listens on loopback, which the bridge refuses as inward, so
// the delivery cases judge the address with a refusal that admits it, and one
// case keeps the real one to see the refusal. Taskfile's integrate:airlock; it
// needs Docker.

import { assertEquals, assertMatch } from "@std/assert";
import { bridge, messageId } from "./mail.ts";

const MAILPIT = "axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48";

async function run(args: string[]): Promise<string> {
  const out = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`docker ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
}

const MAIL = { from: "notifications@cal.example", to: ["ana@oracle.example"], subject: "Confirmed", text: "See you", html: "<p>See you</p>" };
const INVITE = { method: "REQUEST", content: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:p1@cal.example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", filename: "event.ics" };
const admit = () => false;

Deno.test({ name: "the mail bridge sends through a real SMTP server and says what it answered", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const name = `airlock-mail-${crypto.randomUUID().slice(0, 8)}`;
  // Recipients at refused.example are refused for good (550).
  await run(["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::1025", "-p", "127.0.0.1::8025", "-e", "MP_SMTP_ALLOWED_RECIPIENTS=@oracle\\.example$", MAILPIT]);
  try {
    const ports: Record<number, number> = {};
    for (const p of [1025, 8025]) ports[p] = Number((await run(["port", name, String(p)])).split(":").pop());
    const port = (p: number) => ports[p];
    const api = `http://127.0.0.1:${port(8025)}/api/v1`;
    for (let i = 0; !(await fetch(`${api}/messages`).then((r) => r.ok, () => false)); i++) {
      if (i > 60) throw new Error("mailpit did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
    const config = { host: "127.0.0.1", port: port(1025), tls: "none" as const, domain: "airlock.example" };
    const send = (serve: (r: Request) => Promise<Response>, body: unknown, key = "confirm:p1") =>
      serve(new Request("http://bridge/send", { method: "POST", headers: { "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(body) }));

    await t.step("an accepted message arrives with the ledger key's Message-ID and the invite", async () => {
      const res = await send(bridge(config, admit), { ...MAIL, ical: INVITE });
      assertEquals(res.status, 200);
      const sent = await res.json();
      assertEquals(sent.messageId, await messageId("confirm:p1", "airlock.example"));
      assertMatch(sent.response, /^250 /);
      const { messages } = await (await fetch(`${api}/messages`)).json();
      assertEquals(messages.length, 1);
      const m = await (await fetch(`${api}/message/${messages[0].ID}`)).json();
      assertEquals(`<${m.MessageID}>`, sent.messageId);
      assertEquals(m.To.map((a: { Address: string }) => a.Address), ["ana@oracle.example"]);
      assertEquals(m.Subject, "Confirmed");
      const parts = [...m.Attachments, ...m.Inline].map((a: { ContentType: string }) => a.ContentType.split(";")[0]);
      assertEquals(parts.includes("text/calendar") || parts.includes("application/ics"), true, `parts: ${parts}`);
    });

    await t.step("a second send of one key carries the same Message-ID, so a duplicate collapses", async () => {
      const again = await (await send(bridge(config, admit), MAIL)).json();
      assertEquals(again.messageId, await messageId("confirm:p1", "airlock.example"));
    });

    await t.step("a refusal for good is 422, a handler's failed answer", async () => {
      const res = await send(bridge(config, admit), { ...MAIL, to: ["ana@refused.example"] }, "confirm:p2");
      assertEquals(res.status, 422);
      assertEquals((await res.json()).code >= 500, true);
    });

    await t.step("no server is 503: no answer, retried and in the end unknown", async () => {
      const res = await send(bridge({ ...config, port: 1 }, admit), MAIL, "confirm:p3");
      assertEquals(res.status, 503);
    });

    await t.step("where the bridge requires STARTTLS, a server that cannot do it receives nothing in the clear", async () => {
      const before = (await (await fetch(`${api}/messages`)).json()).total;
      const res = await send(bridge({ ...config, tls: "starttls" }, admit), MAIL, "confirm:p4");
      // Mailpit without a certificate answers STARTTLS 502: refused before MAIL FROM, for good.
      assertEquals(res.status, 422);
      assertEquals((await res.json()).code, 502);
      assertEquals((await (await fetch(`${api}/messages`)).json()).total, before);
    });

    await t.step("a server that resolves inward is refused before any mail crosses", async () => {
      const before = (await (await fetch(`${api}/messages`)).json()).total;
      const res = await send(bridge(config), MAIL, "confirm:p5");
      assertEquals(res.status, 403);
      assertMatch((await res.json()).error, /resolves inward, to 127\.0\.0\.1/);
      assertEquals((await (await fetch(`${api}/messages`)).json()).total, before);
    });

    await t.step("a request without a ledger key, or not a message, is refused", async () => {
      const serve = bridge(config, admit);
      assertEquals((await serve(new Request("http://bridge/send", { method: "POST", body: JSON.stringify(MAIL) }))).status, 400);
      assertEquals((await send(serve, { ...MAIL, to: [] })).status, 400);
    });
  } finally {
    await new Deno.Command("docker", { args: ["rm", "-f", name], stdout: "null", stderr: "null" }).output();
  }
} });
