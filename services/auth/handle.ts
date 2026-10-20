// The display handle a new app_user gets, which nobody types: the auth
// service's and the edge cluster's (packages/mecha-edge), so a person signed
// in through a provider reads the same kind of handle on either tier.
// Generated handles can collide; a caller regenerates on a unique violation.

const ADJECTIVES = ["amber", "brisk", "calm", "dusk", "ember", "fern", "gold", "hazel", "ivory", "jade", "kind", "lunar", "mellow", "noble", "ochre", "pale", "quiet", "rustic", "sage", "tidal"];
const NOUNS = ["fox", "wren", "otter", "pine", "reed", "moth", "lark", "moss", "dune", "cove", "elk", "finch", "heron", "ibis", "kite", "lynx", "newt", "orca", "quail", "seal"];

export function generateHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${a}-${n}-${10 + Math.floor(Math.random() * 90)}`;
}
