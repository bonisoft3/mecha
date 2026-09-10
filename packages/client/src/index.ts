export { bootPlatform } from "./boot.js"
export type { ClientConfig } from "./boot.js"
export { electricCollectionOptions } from "./electric-collection.js"
export type { ElectricCollectionConfig } from "./electric-collection.js"
export { createMechaClient } from "./mecha-client.js"
export type { MechaClient, MechaClientConfig, MechaTable, SyncPhase } from "./mecha-client.js"
// The incremental-view-maintenance surface, re-exported so a consumer reaches
// it through this package rather than reaching around it into @tanstack/db.
export { createLiveQueryCollection, liveQueryCollectionOptions } from "@tanstack/db"
// The predicate vocabulary a live query is built from — what a PostgREST
// filter translates into.
export { and, eq, gt, gte, inArray, isNull, lt, lte, not, or } from "@tanstack/db"
// Indexes createIndex will not choose for you: BasicIndex answers the equality
// lookup a join does, BTreeIndex the ordered scan an orderBy with a limit
// needs to stop early instead of loading everything.
export { BasicIndex, BTreeIndex } from "@tanstack/db"
