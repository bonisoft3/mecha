import { assertEquals, assertRejects } from "@std/assert";
import { mail, validAuth, validInput } from "./index.ts";

const input = {
  message: {
    from: "sender@example.com",
    to: ["recipient@example.com"],
    subject: "Subject",
    text: "Body",
  },
  host: "127.0.0.1",
  port: 1,
  starttls: false,
  messageIdDomain: "mail.example",
  requestKey: "test",
};
const action = mail.getAction("send-mail")!;
const run = (propsValue: unknown, auth?: unknown) =>
  action.run({ propsValue, auth } as Parameters<typeof action.run>[0]);

Deno.test("piece registers the standard action and validates its inputs", async () => {
  assertEquals(action.name, "send-mail");
  assertEquals(validInput(input), true);
  assertEquals(
    validAuth({ type: "CUSTOM_AUTH", props: { user: "u", password: "p" } }),
    true,
  );
  await assertRejects(() => run({ ...input, requestKey: " " }), TypeError);
  await assertRejects(
    () =>
      run({
        ...input,
        message: { ...input.message, subject: "x\nBcc: victim@example.com" },
      }),
    TypeError,
  );
  await assertRejects(
    () => run(input, { type: "CUSTOM_AUTH", props: { user: "u" } }),
    TypeError,
  );
});

Deno.test("connection failure produces an uncertain receipt with stable identity", async () => {
  const result = await run(input) as {
    status: string;
    receipt: { messageId: string };
  };
  assertEquals(result.status, "uncertain");
  assertEquals(
    result.receipt.messageId,
    "<9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08@mail.example>",
  );
});
