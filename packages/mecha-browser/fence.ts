// The emitter fences what runs from the container tier up, where a WAL reader
// exists, the publication and the replica identity, between `-- tier: container`
// and `-- tier: any`. The browser cluster skips the fenced statements, and the
// bundler refuses a migration that names either outside a fence, by this one
// grammar.
const CONTAINER_TIER = /^-- tier: container\r?\n[\s\S]*?^-- tier: any(?:\r?\n|$)/gm

/** The SQL the browser tier runs: the migration with its fenced statements removed. */
export const browserTier = (sql: string) => sql.replace(CONTAINER_TIER, '')
