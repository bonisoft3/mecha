import { assertEquals, assertRejects } from "@std/assert";
import { type CloudflareMessage, type MailInput, sendCloudflare, sendEmailJs } from "./web.ts";

const input: MailInput = {
  requestKey: "mail:42", messageIdDomain: "example.test",
  message: { from: "sender@example.test", to: ["one@example.test"], cc: ["two@example.test"], bcc: ["three@example.test"], replyTo: "reply@example.test", subject: "Olá", text: "Plain", html: "<p>HTML</p>" },
};
const config = { publicKey: "public", serviceId: "service", templateId: "template" };

Deno.test("EmailJS sends one template request with public configuration and reports provider refusal", async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, init) => {
    calls++;
    assertEquals(url, "https://api.emailjs.com/api/v1.0/email/send");
    const body = JSON.parse(String(init?.body));
    assertEquals(Object.keys(body).sort(), ["service_id", "template_id", "template_params", "user_id"]);
    assertEquals(body.user_id, "public");
    assertEquals(body.template_params.bcc, "three@example.test");
    assertEquals(body.template_params.reply_to, "reply@example.test");
    assertEquals(body.template_params.subject, "Olá");
    assertEquals(body.template_params.html, "<p>HTML</p>");
    return new Response("OK");
  };
  const accepted = await sendEmailJs(config, input, transport);
  assertEquals(accepted.status, "accepted");
  assertEquals(calls, 1);
  for (const [code, status] of [[422, "permanent-refusal"], [429, "temporary-refusal"], [500, "uncertain"], [408, "uncertain"]] as const) {
    const result = await sendEmailJs(config, input, () => Promise.resolve(new Response("provider body", { status: code })));
    assertEquals(result.status, status);
    assertEquals(result.receipt.messageId, accepted.receipt.messageId);
    assertEquals(result.receipt.response, undefined);
  }
});

Deno.test("EmailJS never retries a request whose response was lost", async () => {
  let calls = 0;
  const result = await sendEmailJs(config, input, () => { calls++; return Promise.reject(new TypeError("lost response")); });
  assertEquals(result.status, "uncertain");
  assertEquals(calls, 1);
});

Deno.test("Cloudflare enforces the recipient allowlist across to, cc and bcc before sending", async () => {
  let calls = 0;
  const binding = { send: (_: CloudflareMessage) => { calls++; return Promise.resolve({ messageId: "provider-id" }); } };
  for (const field of ["to", "cc", "bcc"] as const) {
    const message = { ...input.message, [field]: ["outsider@example.test"] };
    assertEquals((await sendCloudflare({ workersPaid: true, recipients: ["one@example.test", "two@example.test", "three@example.test"] }, { ...input, message }, binding)).status, "permanent-refusal");
  }
  assertEquals(calls, 0);
  await assertRejects(() => sendCloudflare({ workersPaid: false }, input, binding), Error, "requires workersPaid");
  const result = await sendCloudflare({ workersPaid: false, recipients: ["one@example.test", "two@example.test", "three@example.test"] }, input, binding);
  assertEquals(result, { status: "accepted", receipt: { messageId: "provider-id" } });
  assertEquals(calls, 1);
});

Deno.test("Cloudflare preserves message fields and does not override its platform-owned Message-ID", async () => {
  const result = await sendCloudflare({ workersPaid: true }, input, {
    send: (message) => {
      assertEquals(message.bcc, ["three@example.test"]);
      assertEquals(message.replyTo, "reply@example.test");
      assertEquals(message.subject, "Olá");
      assertEquals(Object.keys(message.headers), ["X-Pronto-Request-ID"]);
      return Promise.resolve({ messageId: "cf-id" });
    },
  });
  assertEquals(result.receipt.messageId, "cf-id");
  for (const [code, status] of [["E_RECIPIENT_NOT_ALLOWED", "permanent-refusal"], ["E_RATE_LIMIT_EXCEEDED", "temporary-refusal"], ["E_INTERNAL_SERVER_ERROR", "uncertain"]] as const) {
    let calls = 0;
    const outcome = await sendCloudflare({ workersPaid: true }, input, { send: () => { calls++; return Promise.reject(Object.assign(new Error("private provider text"), { code })); } });
    assertEquals(outcome.status, status);
    assertEquals(outcome.receipt.error, code);
    assertEquals(calls, 1);
  }
});

Deno.test("web adapters reject unsupported calendar MIME and malformed input before sending", async () => {
  const mail = { ...input, message: { ...input.message, ical: { method: "REQUEST", content: "BEGIN:VCALENDAR" } } };
  const notCalled = () => { throw new Error("transport must not run"); };
  assertEquals((await sendEmailJs(config, mail, notCalled)).status, "permanent-refusal");
  assertEquals((await sendCloudflare({ workersPaid: true }, mail, { send: notCalled })).status, "permanent-refusal");
  await assertRejects(() => sendEmailJs(config, { ...input, message: { ...input.message, bcc: ["bad\r\nBcc: x@example.test"] } }, notCalled), Error, "invalid bcc");
});
