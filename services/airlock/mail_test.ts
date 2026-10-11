import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { messageId, parseMail } from "./mail.ts";

const MAIL = { from: "notifications@cal.example", to: ["ana@oracle.example"], subject: "Confirmed", text: "See you" };

Deno.test("a message names its sender, recipients, subject and text, and may carry an invite", () => {
  assertEquals(parseMail(MAIL), MAIL);
  const ical = { method: "REQUEST", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", filename: "event.ics" };
  assertEquals(parseMail({ ...MAIL, cc: ["pro@cal.example"], html: "<p>See you</p>", ical }).ical, ical);
});

Deno.test("anything else is not a message the bridge sends", () => {
  for (
    const [body, why] of [
      [{ ...MAIL, to: [] }, "to"],
      [{ ...MAIL, to: ["not-an-address"] }, "to"],
      [{ ...MAIL, from: "Ana <ana@oracle.example>" }, "from"],
      [{ ...MAIL, subject: "Confirmed\r\nBcc: everyone@example.com" }, "spans lines"],
      [{ ...MAIL, headers: { "X-Evil": "1" } }, "unknown field headers"],
      [{ ...MAIL, ical: { method: "request", content: "x" } }, "ical.method"],
      [{ ...MAIL, text: 1 }, "text"],
      [[], "not an object"],
    ] as [unknown, string][]
  ) {
    assertThrows(() => parseMail(body), TypeError, why);
  }
});

Deno.test("every send of a ledger key carries one Message-ID, and no other key's", async () => {
  const a = await messageId("confirm:p1", "airlock.example");
  assertEquals(a, await messageId("confirm:p1", "airlock.example"));
  assertNotEquals(a, await messageId("confirm:p2", "airlock.example"));
  assertEquals(/^<[0-9a-f]{64}@airlock\.example>$/.test(a), true);
});
