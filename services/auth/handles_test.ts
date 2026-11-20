// What a name leaves of itself in a handle: a handle is public and goes in
// addresses, so only letters, marks and digits survive, in any script.
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { guestHandle, nameHandle, suffixOf } from "./handles.ts";

const id = "0b6a2c1e-9d4f-4e21-8a77-5c3e2d1f3fa2";

Deno.test("a name keeps its letters and the case it was written in, and the account's suffix", () => {
  assertEquals(nameHandle("Davi", id), "Davi-3fa2");
  assertEquals(nameHandle("  Ana   Maria ", id), "Ana-Maria-3fa2");
  assertEquals(nameHandle("José da Silva", id), "José-da-Silva-3fa2");
  assertEquals(nameHandle("太郎", id), "太郎-3fa2");
  assertEquals(nameHandle("O'Brien 🎉", id), "O-Brien-3fa2");
});

Deno.test("a name with nothing in it is none, and a long one is cut", () => {
  assertEquals(nameHandle("  🎉 !! ", id), null);
  assertEquals(nameHandle("a".repeat(40), id), `${"a".repeat(32)}-3fa2`);
  // Cut at a word's end, never on its joint.
  assertEquals(nameHandle(`${"a".repeat(31)} b`, id), `${"a".repeat(31)}-3fa2`);
});

Deno.test("a guest's name and a person's share the suffix the id gives", () => {
  assertEquals(suffixOf(id), "3fa2");
  assertEquals(guestHandle(id).slice(-5), "-3fa2");
});

Deno.test("an address the browser filled in for a name gives no more than what precedes its @", () => {
  // Regression: a username autofilled as the name made the whole address
  // public in the handle.
  assertEquals(nameHandle("davi@davi.eng.br", id), "davi-3fa2");
  assertEquals(nameHandle("ana.maria@example.com", id), "ana-maria-3fa2");
  assertEquals(nameHandle("@example.com", id), null);
});
