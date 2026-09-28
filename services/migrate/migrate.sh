#!/bin/bash
# Carries the database DATABASE_URL names forward to the pgroll migrations in
# <dir>, and exits non-zero on anything short of that, which is what keeps the
# readers waiting on this from starting:
#
#   migrate.sh <dir> <baseline>
#
# The schema initdb built is recorded once as <baseline>, whether the volume is
# fresh or predates this runner. Then every migration the ledger lacks is
# applied in name order and completed before the next starts. A second run
# over the same set applies nothing.
set -euo pipefail

dir=$1
baseline=$2
: "${DATABASE_URL:?names the database to migrate}"
export PGROLL_PG_URL=$DATABASE_URL
# Byte order, which is the order a fresh volume replays them in.
export LC_ALL=C
shopt -s nullglob

# One answer, from psql reading SQL on stdin so a name reaches it as a quoted
# variable and never as text spliced into the statement.
ask() { psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -qtA "$@"; }
applied() {
	ask -v name="$1" <<< "SELECT count(*) FROM pgroll.migrations WHERE schema = 'public' AND migration_type = 'pgroll' AND done AND name = :'name';"
}

pgroll init

if [ "$(ask <<< "SELECT count(*) FROM pgroll.migrations WHERE schema = 'public' AND migration_type = 'baseline';")" = 0 ]; then
	scratch=$(mktemp -d)
	pgroll baseline "$baseline" "$scratch" --yes
	rm -rf "$scratch"
fi

# One `start` per migration rather than pgroll's `migrate`, which refuses a
# directory that an applied migration has since left — and a migration folded
# into the schema initdb builds leaves it. Each is checked against the ledger
# after pgroll returns, because pgroll exits 0 having applied nothing when it
# finds a schema without a baseline.
latest=$(ask <<< "SELECT coalesce(max(name COLLATE \"C\"), '') FROM pgroll.migrations WHERE schema = 'public' AND migration_type = 'pgroll';")
for file in "$dir"/*.json; do
	name=$(basename "$file" .json)
	if [ "$(applied "$name")" = 1 ]; then
		continue
	fi
	# A fresh volume applies it before $latest, and this one would apply it
	# after: two databases built from one set, in two orders.
	if [[ $name < $latest ]]; then
		echo "migrate: $name sorts before $latest, which this database already applied; rename it to sort after" >&2
		exit 1
	fi
	pgroll start "$file" --complete
	if [ "$(applied "$name")" != 1 ]; then
		echo "migrate: pgroll returned without completing $name" >&2
		exit 1
	fi
	latest=$name
done

# PostgREST serves from a schema cache it reads once: a reader already running
# is told, and one starting after this reads the schema fresh anyway.
ask <<< "NOTIFY pgrst, 'reload schema';"
