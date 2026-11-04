import type { Message, Outcome } from "./types.ts";

export type MailInput = { message: Message; requestKey: string; messageIdDomain: string };
export type EmailJsConfig = { publicKey: string; serviceId: string; templateId: string };
export type CloudflareConfig = { workersPaid: boolean; recipients?: string[] };
export type CloudflareMessage = Omit<Message, "ical"> & { headers: Record<string, string> };
export type EmailBinding = { send(message: CloudflareMessage): Promise<{ messageId: string }> };

const address = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

function validate(input: MailInput): void {
  if (!input || typeof input !== "object" || !input.message) throw new Error("mail: message is required");
  if (typeof input.requestKey !== "string" || !input.requestKey.trim()) throw new Error("mail: requestKey is required");
  if (typeof input.messageIdDomain !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(input.messageIdDomain)) throw new Error("mail: invalid messageIdDomain");
  const m = input.message;
  const fields = new Set(["from", "to", "subject", "text", "html", "cc", "bcc", "replyTo", "ical"]);
  if (Object.keys(m).some((key) => !fields.has(key))) throw new Error("mail: unknown message field");
  if (typeof m.from !== "string" || !address.test(m.from)) throw new Error("mail: invalid sender");
  for (const field of ["to", "cc", "bcc"] as const) {
    const values = m[field];
    if (values === undefined && field !== "to") continue;
    if (!Array.isArray(values) || (field === "to" && values.length === 0) || !values.every((v) => typeof v === "string" && address.test(v))) throw new Error(`mail: invalid ${field}`);
  }
  if (typeof m.subject !== "string" || /[\r\n]/.test(m.subject)) throw new Error("mail: invalid subject");
  if (typeof m.text !== "string" || (m.html !== undefined && typeof m.html !== "string")) throw new Error("mail: invalid body");
  if (m.replyTo !== undefined && (typeof m.replyTo !== "string" || !address.test(m.replyTo))) throw new Error("mail: invalid replyTo");
}

async function identity(input: MailInput): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.requestKey)));
  return `<${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}@${input.messageIdDomain}>`;
}

function refused(messageId: string, error: string): Outcome {
  return { status: "permanent-refusal", receipt: { messageId, error } };
}

export async function sendEmailJs(config: EmailJsConfig, input: MailInput, fetcher: typeof fetch = fetch): Promise<Outcome> {
  validate(input);
  if (![config.publicKey, config.serviceId, config.templateId].every((v) => typeof v === "string" && v.trim())) throw new Error("mail: EmailJS publicKey, serviceId and templateId are required");
  const messageId = await identity(input);
  if (input.message.ical !== undefined) return refused(messageId, "EmailJS mail does not support calendar MIME");
  const m = input.message;
  let response: Response;
  try {
    response = await fetcher("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        service_id: config.serviceId,
        template_id: config.templateId,
        user_id: config.publicKey,
        template_params: {
          from: m.from, to: m.to.join(", "), cc: (m.cc ?? []).join(", "), bcc: (m.bcc ?? []).join(", "),
          reply_to: m.replyTo ?? "", subject: m.subject, text: m.text, html: m.html ?? "", message_id: messageId,
        },
      }),
    });
  } catch {
    // A lost response cannot establish whether the provider accepted the send.
    return { status: "uncertain", receipt: { messageId, error: "EmailJS request failed before acknowledgement" } };
  }
  await response.body?.cancel();
  const status = response.ok ? "accepted" : response.status === 429 ? "temporary-refusal" : response.status >= 400 && response.status < 500 && response.status !== 408 ? "permanent-refusal" : "uncertain";
  return { status, receipt: { messageId, code: response.status, ...(status === "accepted" ? {} : { error: `EmailJS rejected request (${response.status})` }) } };
}

export async function sendCloudflare(config: CloudflareConfig, input: MailInput, binding: EmailBinding): Promise<Outcome> {
  validate(input);
  const messageId = await identity(input);
  if (typeof config.workersPaid !== "boolean" || (!config.workersPaid && !config.recipients?.length)) throw new Error("mail: Cloudflare requires workersPaid or permitted recipients");
  if (config.recipients !== undefined && (!Array.isArray(config.recipients) || config.recipients.length === 0 || !config.recipients.every((v) => typeof v === "string" && address.test(v)))) throw new Error("mail: invalid Cloudflare recipients");
  const recipients = [...input.message.to, ...(input.message.cc ?? []), ...(input.message.bcc ?? [])];
  if (config.recipients && recipients.some((v) => !config.recipients!.includes(v))) return refused(messageId, "Cloudflare mail recipient is outside the configured allowlist");
  if (recipients.length > 50) return refused(messageId, "Cloudflare mail supports at most 50 recipients");
  if (input.message.ical !== undefined) return refused(messageId, "Cloudflare mail does not support calendar MIME");
  const { ical: _, ...message } = input.message;
  let result: { messageId: string };
  try {
    result = await binding.send({ ...message, headers: { "X-Pronto-Request-ID": messageId } });
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "E_UNACKNOWLEDGED";
    const permanent = new Set(["E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_ACCOUNT_SUSPENDED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE"]);
    const status = permanent.has(code) ? "permanent-refusal" : ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"].includes(code) ? "temporary-refusal" : "uncertain";
    return { status, receipt: { messageId, error: code } };
  }
  if (typeof result?.messageId !== "string" || !result.messageId) return { status: "uncertain", receipt: { messageId, error: "Cloudflare returned no message ID" } };
  return { status: "accepted", receipt: { messageId: result.messageId } };
}
