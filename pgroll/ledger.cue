package pgroll

// The ledger name the schema initdb built is recorded under, before the first
// migration a database is given. A migration cannot take it: the ledger
// already holds it.
#Baseline: "00_initdb"

// A migration's name: its version in pgroll's ledger, and <name>.json, the file
// the migrate image holds it in. The alphabet keeps name order the same under
// every collation that reads it — the runner's, a shell glob's, the ledger's.
#Name: =~"^[a-z0-9][a-z0-9_]*$" & !=#Baseline

// A migration as a cluster is given one: the grammar, less the `name` it
// admits. The key is the name, and the pinned pgroll's reader refuses the
// field its schema allows.
#Migration: #PgRollMigration & {name?: _|_}
