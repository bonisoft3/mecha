export type Message = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  ical?: { method: string; content: string; filename?: string };
};
export type Input = {
  message: Message;
  host: string;
  port: number;
  starttls: boolean;
  messageIdDomain: string;
  requestKey: string;
  ca?: string[];
};
export type Auth = {
  type: "CUSTOM_AUTH";
  props: { user: string; password: string };
};
export type Receipt = {
  messageId: string;
  code?: number;
  response?: string;
  accepted?: string[];
  rejected?: string[];
  error?: string;
};
export type Outcome = {
  status: "accepted" | "permanent-refusal" | "temporary-refusal" | "uncertain";
  receipt: Receipt;
};
