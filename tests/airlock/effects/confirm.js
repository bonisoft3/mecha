// The smoke's bridged effect: a confirmation through the mail bridge, its body
// signed with the key its effect declares, handed in by the airlock and never
// in the ledger.
export async function issue(request, sink, secrets) {
  const text = `Booking ${request.id} confirmed.`;
  const key = await Crypto.importKey("raw", new TextEncoder().encode(secrets.CONFIRM_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await Crypto.sign("HMAC", key, new TextEncoder().encode(text)));
  const signature = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const r = await sink.fetch("/send", {
    method: "POST",
    body: {
      from: "notifications@airlock.test",
      to: ["ana@oracle.test"],
      subject: `Confirmed ${request.id}`,
      text: `${text}\nsignature: ${signature}`,
      ical: { method: "REQUEST", content: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${request.id}@airlock.test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, filename: "event.ics" },
    },
  });
  if (r.status === 422) return { failed: r.body };
  if (r.status !== 200) throw new Error("bridge answered " + r.status);
  return { done: r.body };
}
