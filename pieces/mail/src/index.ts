import {
  createAction,
  createPiece,
  PieceAuth,
  Property,
} from "@activepieces/pieces-framework";
import { Ajv } from "ajv";
// @deno-types="nodemailer-types"
import nodemailer from "nodemailer";
import inputSchema from "../send.input.schema.json" with { type: "json" };
import authSchema from "../mail.auth.schema.json" with { type: "json" };

import type { Auth, Input, Outcome } from "./types.ts";
export type { Auth, Input, Message, Outcome, Receipt } from "./types.ts";
export const validInput = new Ajv().compile<Input>(inputSchema);
export const validAuth = new Ajv().compile<Auth>(authSchema);

async function messageId(key: string, domain: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
  return `<${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }@${domain}>`;
}
type SmtpError = Error & {
  code: string;
  responseCode?: number;
  response?: string;
  rejected?: string[];
  rejectedErrors?: SmtpError[];
};
function failure(error: unknown, id: string): Outcome {
  if (
    !(error instanceof Error) || !("code" in error) ||
    typeof error.code !== "string"
  ) throw error;
  const smtp = error as SmtpError;
  const replies = smtp.rejectedErrors?.length ? smtp.rejectedErrors : [smtp];
  const first = replies[0];
  const temporary = replies.some((reply) =>
    reply.responseCode !== undefined && reply.responseCode >= 400 &&
    reply.responseCode < 500
  );
  const permanent = !temporary && first.responseCode !== undefined &&
    first.responseCode >= 500 && first.responseCode < 600;
  return {
    status: temporary
      ? "temporary-refusal"
      : permanent
      ? "permanent-refusal"
      : "uncertain",
    receipt: {
      messageId: id,
      error: smtp.code,
      ...(first.responseCode === undefined ? {} : { code: first.responseCode }),
      ...(first.response === undefined ? {} : { response: first.response }),
      ...(smtp.rejected === undefined ? {} : { rejected: smtp.rejected }),
    },
  };
}

const auth = PieceAuth.CustomAuth({
  description: "Optional SMTP credentials",
  required: true,
  props: {
    user: Property.ShortText({ displayName: "User", required: true }),
    password: PieceAuth.SecretText({ displayName: "Password", required: true }),
  },
});
const send = createAction({
  name: "send-mail",
  displayName: "Send MIME mail",
  description:
    "Send one SMTP attempt with a stable message ID and delivery receipt.",
  auth,
  requireAuth: false,
  props: {
    message: Property.Json({ displayName: "Message", required: true }),
    host: Property.ShortText({ displayName: "SMTP host", required: true }),
    port: Property.Number({ displayName: "SMTP port", required: true }),
    starttls: Property.Checkbox({
      displayName: "Require STARTTLS",
      required: true,
    }),
    messageIdDomain: Property.ShortText({
      displayName: "Message ID domain",
      required: true,
    }),
    requestKey: Property.ShortText({
      displayName: "Request key",
      required: true,
    }),
    ca: Property.Array({ displayName: "CA certificates", required: false }),
  },
  errorHandlingOptions: {
    continueOnFailure: { defaultValue: false, hide: true },
    retryOnFailure: { defaultValue: false, hide: true },
  },
  run: async ({ propsValue, auth: credentials }): Promise<Outcome> => {
    if (
      !validInput(propsValue) ||
      (credentials != null && !validAuth(credentials))
    ) throw new TypeError("Invalid mail action input or authentication");
    const { message, host, port, starttls, messageIdDomain, requestKey, ca } =
      propsValue;
    const id = await messageId(requestKey, messageIdDomain);
    const transport = nodemailer.createTransport({
      host,
      port,
      name: messageIdDomain,
      secure: false,
      requireTLS: starttls,
      ignoreTLS: !starttls,
      tls: { rejectUnauthorized: true, ca },
      auth: credentials
        ? { user: credentials.props.user, pass: credentials.props.password }
        : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: id,
        icalEvent: message.ical
          ? {
            method: message.ical.method,
            content: message.ical.content,
            filename: message.ical.filename ?? "invite.ics",
          }
          : undefined,
      });
      const code = Number(result.response.match(/^(\d{3})\b/)?.[1]);
      if (!(code >= 200 && code < 300)) {
        throw new Error("SMTP success did not include a successful DATA reply");
      }
      return {
        status: "accepted",
        receipt: {
          messageId: id,
          code,
          response: result.response,
          accepted: result.accepted.map(String),
          rejected: result.rejected.map(String),
        },
      };
    } catch (error) {
      return failure(error, id);
    } finally {
      transport.close();
    }
  },
});
export const mail = createPiece({
  displayName: "Mail",
  description: "Send mail over SMTP",
  logoUrl: "https://cdn.activepieces.com/pieces/email.png",
  authors: [],
  auth,
  actions: [send],
  triggers: [],
});
