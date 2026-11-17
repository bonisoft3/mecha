#!/usr/bin/env nu
# Carries the database DATABASE_URL names forward to the pgroll migrations in
# <dir>, and exits non-zero on anything short of that, which is what keeps the
# readers waiting on this from starting:
#
#   migrate.nu <dir> <baseline>

def ask --wrapped [sql: string, ...args: string] {
	$sql | ^psql $env.DATABASE_URL -X -v ON_ERROR_STOP=1 -qtA ...$args | str trim
}

# The schema the app's tables are in, which pgroll reads too; `public` unless the cluster keeps its
# own (cluster.cue, meta.schema).
def schema [] {
	let s = ($env.PGROLL_SCHEMA? | default "")
	if ($s | is-empty) { "public" } else { $s }
}

def applied [name: string] {
	(ask "SELECT count(*) FROM pgroll.migrations WHERE schema = :'schema' AND migration_type = 'pgroll' AND done AND name = :'name';" -v $"name=($name)" -v $"schema=(schema)") == "1"
}

def main [dir: string, baseline: string] {
	if ($env.DATABASE_URL? | default "" | is-empty) {
		print -e "migrate: DATABASE_URL names the database to migrate"
		exit 1
	}
	for table in ($env.REQUIRED_TABLES? | default "" | split row "," | where ($it | is-not-empty)) {
		if (ask "SELECT to_regclass(format('public.%I', :'table')) IS NOT NULL;" -v $"table=($table)") != "t" {
			print -e $"migrate: this cluster needs table ($table), which only initdb creates and this volume predates; recreate the volume"
			exit 1
		}
	}
	# Roles ahead of the ledger, which may grant one (the cluster's `roles`).
	let roles = ($dir | path join roles.sql)
	if ($roles | path exists) {
		let r = (^psql $env.DATABASE_URL -X -v ON_ERROR_STOP=1 -qtA --single-transaction -c "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; SET LOCAL pgroll.no_inferred_migrations = 'TRUE';" $"--file=($roles)" | complete)
		if $r.exit_code != 0 {
			print -e $"migrate: ($roles): ($r.stderr | str trim)"
			exit 1
		}
	}
	with-env {PGROLL_PG_URL: $env.DATABASE_URL, PGROLL_SCHEMA: (schema), LC_ALL: "C"} {
		^pgroll init
		if (ask "SELECT count(*) FROM pgroll.migrations WHERE schema = :'schema' AND migration_type = 'baseline';" -v $"schema=(schema)") == "0" {
			let scratch = ($nu.temp-dir | path join $"pgroll-baseline-($nu.pid)-(random int 100000..999999)")
			mkdir $scratch
			try {
				^pgroll baseline $baseline $scratch --yes
			} catch {|e|
				rm -rf $scratch
				error make {msg: ($e.msg? | default ($e | to text))}
			}
			rm -rf $scratch
		}
		mut latest = (ask "SELECT coalesce(max(name COLLATE \"C\"), '') FROM pgroll.migrations WHERE schema = :'schema' AND migration_type = 'pgroll';" -v $"schema=(schema)")
		let files = (if ($dir | path exists) { glob ($dir | path join "*.json" | str replace -a (char -u 5c) "/") | sort } else { [] })
		for file in $files {
			let name = ($file | path parse | get stem)
			if (applied $name) { continue }
			if $name < $latest {
				print -e $"migrate: ($name) sorts before ($latest), which this database already applied; rename it to sort after"
				exit 1
			}
			^pgroll start $file --complete
			if not (applied $name) {
				print -e $"migrate: pgroll returned without completing ($name)"
				exit 1
			}
			$latest = $name
		}
		let sql_files = (if ($dir | path exists) { glob ($dir | path join "*.sql" | str replace -a (char -u 5c) "/") | sort | where {|f| ($f | path basename) != "roles.sql" } } else { [] })
		for file in $sql_files {
			let r = (^psql $env.DATABASE_URL -X -v ON_ERROR_STOP=1 -qtA --single-transaction -c "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'; SET LOCAL pgroll.no_inferred_migrations = 'TRUE';" $"--file=($file)" | complete)
			if $r.exit_code != 0 {
				print -e $"migrate: ($file): ($r.stderr | str trim)"
				exit 1
			}
		}
		ask "NOTIFY pgrst, 'reload schema';" | ignore
	}
}
