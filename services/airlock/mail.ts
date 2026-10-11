// The mail bridge: HTTP from the airlock's daprd in, SMTP to one declared
// server out. The airlock speaks HTTP and nothing else, so a sink that speaks
// SMTP is reached through a bridge (pronto's external effects record, "Bridges").
// Its wall is its own permission set: the cluster runs it with `--allow-net`
// naming its port and the declared server, and it checks the address it
// actually connected before a byte of mail crosses, refusing one that resolves
// inward (inward.ts).
//
// POST /send, with the ledger key as Idempotency-Key and a JSON message. The
// answer says what the server said, in the shape a handler maps onto the
// airlock's outcomes:
//
//   200  accepted (250): done
//   422  refused for good (5xx), a refused STARTTLS included, since that comes
//        before MAIL FROM: failed
//   503  no answer: the server's 4xx, or no server; a handler throws, so the
//        airlock retries and, after its attempts, settles unknown
//   400  not a message the bridge sends
//   403  the declared server resolves inward
//
// SMTP carries no idempotency key, so the bridge cannot refuse a second send of
// one message; the effect's `reentry` decides whether it is attempted. What the
// bridge does is name every send of a key with one Message-ID, so a duplicate
// that does go out collapses in the recipient's mail client.

import nodemailer from "nodemailer";
import net from "node:net";
import { inward } from "./inward.ts";

const PORT = 8080;

export type Mail = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** A calendar invite, sent as the text/calendar alternative and an .ics attachment. */
  ical?: { method: string; content: string; filename?: string };
};

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const METHOD = /^[A-Z]+$/;

/** `body` as a message the bridge sends, or the reason it is not one. */
export function parseMail(body: unknown): Mail {
  const m = body as Record<string, unknown>;
  const bad = (why: string): never => {
    throw new TypeError(`not a message: ${why}`);
  };
  if (typeof m !== "object" || m === null || Array.isArray(m)) bad("not an object");
  const known = new Set(["from", "to", "cc", "bcc", "replyTo", "subject", "text", "html", "ical"]);
  for (const k of Object.keys(m)) if (!known.has(k)) bad(`unknown field ${k}`);
  const address = (v: unknown, what: string) => (typeof v === "string" && ADDRESS.test(v) ? v : bad(`${what} is not an address`));
  const addresses = (v: unknown, what: string, required: boolean) => {
    if (v === undefined && !required) return undefined;
    if (!Array.isArray(v) || (required && v.length === 0)) return bad(`${what} is not a list of addresses`);
    return v.map((a) => address(a, what));
  };
  const text = (v: unknown, what: string, required: boolean) => {
    if (v === undefined && !required) return undefined;
    return typeof v === "string" ? v : bad(`${what} is not text`);
  };
  const subject = text(m.subject, "subject", true)!;
  if (/[\r\n]/.test(subject)) bad("subject spans lines");
  let ical: Mail["ical"];
  if (m.ical !== undefined) {
    const i = m.ical as Record<string, unknown>;
    if (typeof i !== "object" || i === null) bad("ical is not an object");
    if (typeof i.method !== "string" || !METHOD.test(i.method)) bad("ical.method is not an iCalendar method");
    ical = {
      method: i.method as string,
      content: text(i.content, "ical.content", true)!,
      ...(i.filename === undefined ? {} : { filename: text(i.filename, "ical.filename", true)! }),
    };
  }
  return {
    from: address(m.from, "from"),
    to: addresses(m.to, "to", true)!,
    ...(m.cc === undefined ? {} : { cc: addresses(m.cc, "cc", false) }),
    ...(m.bcc === undefined ? {} : { bcc: addresses(m.bcc, "bcc", false) }),
    ...(m.replyTo === undefined ? {} : { replyTo: address(m.replyTo, "replyTo") }),
    subject,
    text: text(m.text, "text", true)!,
    ...(m.html === undefined ? {} : { html: text(m.html, "html", false) }),
    ...(ical === undefined ? {} : { ical }),
  };
}

/** The Message-ID every send of `key` carries: the key's SHA-256, because a
 * ledger key's `:` is not allowed in one. */
export async function messageId(key: string, domain: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `<${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}@${domain}>`;
}

export type Config = {
  host: string;
  port: number;
  /** STARTTLS required, or plain SMTP for a server the program owns. */
  tls: "starttls" | "none";
  auth?: { user: string; pass: string };
  /** The right-hand side of every Message-ID. */
  domain: string;
};

class Inward extends Error {}

/** The bridge's request handler. `refuse` judges the address the server
 * resolved to; only the bridge's own test replaces `inward`. */
export function bridge(config: Config, refuse: (address: string) => boolean = inward): (req: Request) => Promise<Response> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,
    requireTLS: config.tls === "starttls",
    ignoreTLS: config.tls === "none",
    ...(config.auth ? { auth: config.auth } : {}),
    // The socket the bridge opens itself, so the address it reached is judged
    // before nodemailer writes to it.
    getSocket(_options: unknown, done: (e: Error | null, s?: { connection: net.Socket }) => void) {
      const socket = net.connect({ host: config.host, port: config.port });
      socket.once("error", (e) => done(e));
      socket.once("connect", () => {
        const at = socket.remoteAddress ?? "";
        if (refuse(at)) {
          socket.destroy();
          return done(new Inward(`${config.host} resolves inward, to ${at}`));
        }
        done(null, { connection: socket });
      });
    },
  });
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/send") return json(404, { error: "not found" });
    const key = req.headers.get("idempotency-key");
    if (!key) return json(400, { error: "no Idempotency-Key: the ledger key names the message" });
    let mail: Mail;
    try {
      mail = parseMail(await req.json());
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : String(e) });
    }
    const { ical, ...fields } = mail;
    const message = {
      ...fields,
      messageId: await messageId(key, config.domain),
      ...(ical ? { icalEvent: { method: ical.method, content: ical.content, filename: ical.filename ?? "invite.ics" } } : {}),
    };
    try {
      const sent = await transport.sendMail(message);
      return json(200, { messageId: sent.messageId, response: sent.response, accepted: sent.accepted, rejected: sent.rejected });
    } catch (e) {
      if (e instanceof Inward) {
        console.error(`mail: refused: ${e.message}`);
        return json(403, { error: e.message });
      }
      const code = (e as { responseCode?: number }).responseCode;
      const message = e instanceof Error ? e.message : String(e);
      if (code !== undefined && code >= 500 && code < 600) return json(422, { code, response: (e as { response?: string }).response ?? message });
      return json(503, { error: message, ...(code === undefined ? {} : { code }) });
    }
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function required(name: string): string {
  return Deno.env.get(name) ?? (() => {
    throw new Error(`${name} is required`);
  })();
}

if (import.meta.main) {
  const [host, port] = required("MAIL_SMTP").split(":");
  const tls = required("MAIL_TLS");
  if (tls !== "starttls" && tls !== "none") throw new Error(`MAIL_TLS is ${tls}, not starttls or none`);
  const user = Deno.env.get("MAIL_USER"), pass = Deno.env.get("MAIL_PASSWORD");
  if ((user === undefined) !== (pass === undefined)) throw new Error("MAIL_USER and MAIL_PASSWORD come together or not at all");
  if (!host || !/^[0-9]{1,5}$/.test(port ?? "")) throw new Error(`MAIL_SMTP is not host:port`);
  Deno.serve(
    { hostname: "0.0.0.0", port: PORT },
    bridge({ host, port: Number(port), tls, domain: required("MAIL_MESSAGE_ID_DOMAIN"), ...(user ? { auth: { user, pass: pass! } } : {}) }),
  );
}
