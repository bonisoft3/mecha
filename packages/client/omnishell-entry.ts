// The browser surface omnishell's interpreter bundles (its package.json
// `bundle:mecha-client`): the data-plane driver its cluster store rides, and
// the incremental-view-maintenance surface taken from this package's own
// exports, so the bundle never reaches past it into @tanstack/db.
export { createMechaClient } from "./src/mecha-client.ts"
export {
	and,
	types,
	carriers,
	BasicIndex,
	BTreeIndex,
	createCollection,
	createLiveQueryCollection,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	liveQueryCollectionOptions,
	localOnlyCollectionOptions,
	localStorageCollectionOptions,
	lt,
	lte,
	not,
	or,
} from "./src/index.ts"
