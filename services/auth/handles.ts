// A handle is a name and the four hex digits that keep it unique, the last of
// the account's id: `Davi-3fa2`, shown to others `Davi#3fa2` and to the person
// as their name alone. A guest's name is a fruit and an animal drawn from the
// same id. Renaming changes the name and never the suffix, so one account
// keeps one suffix whatever it is called.

const FRUITS = [
  "acerola", "amora", "avocado", "banana", "caju", "carambola", "cherry", "citrus",
  "coconut", "cupuacu", "fig", "guava", "jabuticaba", "jackfruit", "kiwi", "lemon",
  "lime", "lychee", "mango", "maracuja", "melon", "nectarine", "olive", "orange",
  "papaya", "peach", "pear", "persimmon", "pineapple", "pitanga", "plum", "tangerine",
];
const ANIMALS = [
  "albatross", "armadillo", "badger", "capybara", "chameleon", "condor", "dolphin", "falcon",
  "flamingo", "fox", "gecko", "heron", "hummingbird", "ibis", "iguana", "jaguar",
  "kingfisher", "koala", "lemur", "lynx", "macaw", "manatee", "meerkat", "ocelot",
  "otter", "owl", "panda", "pelican", "penguin", "quokka", "tapir", "toucan",
];

const hexOf = (id: string) => id.replaceAll("-", "").toLowerCase();

/** The suffix an account's every handle ends in. */
export const suffixOf = (id: string) => hexOf(id).slice(-4) || "0000";

export function guestHandle(id: string): string {
  const hex = hexOf(id);
  const fruit = FRUITS[(parseInt(hex.slice(0, 2), 16) || 0) % FRUITS.length];
  const animal = ANIMALS[(parseInt(hex.slice(2, 4), 16) || 0) % ANIMALS.length];
  return `${fruit}-${animal}-${suffixOf(id)}`;
}

/** The handle a name gives this account, or null for a name with nothing in
 * it: letters, marks and digits in any script, words joined by `-`, at most
 * 32 characters, the case the person wrote. A handle is public and goes in
 * addresses, so nothing else of the name survives — of an address the
 * browser filled in (`davi@example.com`), only what precedes the `@`. */
export function nameHandle(name: string, id: string): string | null {
  const words = name.normalize("NFC").split("@")[0].replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w !== "");
  const joined = [...words.join("-")].slice(0, 32).join("").replace(/-+$/, "");
  return joined === "" ? null : `${joined}-${suffixOf(id)}`;
}

/** The name a handle carries, its words without the `-` that joins them and
 * the suffix that keeps it apart for others: what the person's own passkey
 * manager calls the account. */
export const nameOf = (handle: string) => handle.replace(/-[0-9a-f]{4}$/, "").replaceAll("-", " ");
