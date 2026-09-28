// The emitter fences what needs a WAL reader, the publication and the replica
// identity, between `-- tier: container` and `-- tier: any`. Every rung where
// PostgreSQL itself runs (CLI, single machine, k8s, cloud) applies the fenced
// statements; the browser cluster skips them, and the bundler refuses a
// migration that names either outside a fence, by this one grammar.
const CONTAINER_TIER = /^-- tier: container\r?\n[\s\S]*?^-- tier: any(?:\r?\n|$)/gm

/** The SQL the browser tier runs: the migration with its fenced statements removed. */
export const browserTier = (sql: string) => sql.replace(CONTAINER_TIER, '')
