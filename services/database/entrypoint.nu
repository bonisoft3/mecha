#!/usr/bin/env nu
# Initializes an ephemeral PostgreSQL cluster in BAYT_LOCAL_WORK_DIR, runs the
# initdb directory's SQL and role_passwords.sh against it, and execs postgres:
#
#   entrypoint.nu <initdb> [postgres-args...]

use std/util null-device

def main --wrapped [initdb: string, ...args: string] {
	let os = (match $nu.os-info.name { "macos" => "macos", "windows" => "windows", _ => "linux" })
	let pg_bin = (which postgres | first | get path | path dirname)
	let pg_ctl = ($pg_bin | path join "pg_ctl")
	let psql = ($pg_bin | path join "psql")
	let work = ($env.BAYT_LOCAL_WORK_DIR? | default $nu.temp-dir)
	let pgdata = ($work | path join $"pg-($nu.pid)-(random int 1000..9999)")
	let user = ($env.POSTGRES_USER? | default "postgres")
	let db = ($env.POSTGRES_DB? | default "postgres")
	let init_args = ($env.POSTGRES_INITDB_ARGS? | default "--no-sync --encoding=UTF8 --auth=trust --locale-provider=icu --icu-locale=und --locale=C")
	^$pg_ctl initdb -D $pgdata -s -o $"-U ($user) ($init_args)" out> (null-device)
	"\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n" | save --append ($pgdata | path join "postgresql.conf")
	let pgsock = ($nu.temp-dir | path join $"pgs-($nu.pid)-(random int 1000..9999)")
	let init_port = (if $os == "windows" {
		(^deno eval --no-config 'const l = Deno.listen({hostname:"127.0.0.1",port:0}); console.log(l.addr.port); l.close()' | str trim)
	} else {
		mkdir $pgsock
		"5432"
	})
	let ctl_opts = (if $os == "windows" {
		$"-p ($init_port) -c listen_addresses=127.0.0.1 -c wal_level=logical -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
	} else {
		$"-p 5432 -c listen_addresses='' -c unix_socket_directories=($pgsock) -c wal_level=logical -c fsync=off -c synchronous_commit=off -c full_page_writes=off"
	} )
	let host_arg = (if $os == "windows" { "127.0.0.1" } else { $pgsock })
	let init_log = ($pgdata | path join "init.log")
	try {
		^$pg_ctl -D $pgdata -l $init_log -o $ctl_opts -w start
		if $db != "postgres" {
			^$psql -h $host_arg -p $init_port -U $user -d postgres -v ON_ERROR_STOP=1 -q -c $"CREATE DATABASE \"($db)\";"
		}
		^$psql -h $host_arg -p $init_port -U $user -d $db -v ON_ERROR_STOP=1 -q -c $"ALTER DATABASE \"($db)\" SET pgroll.no_inferred_migrations = 'TRUE';"
		if ($initdb | path exists) {
			for f in (glob ($initdb | path join "*" | str replace -a (char -u 5c) "/") | sort) {
				if (($f | path type) != "file") { continue }
				if ($f | str ends-with ".sql") {
					^$psql -h $host_arg -p $init_port -U $user -d $db -v ON_ERROR_STOP=1 -q -f $f out> (null-device)
				} else if ($f | str ends-with "role_passwords.sh") {
					let elec = ($env.ELECTRIC_PASSWORD? | default "")
					let auth = ($env.AUTHENTICATOR_PASSWORD? | default "")
					if ($elec | is-empty) or ($auth | is-empty) { error make { msg: "ELECTRIC_PASSWORD and AUTHENTICATOR_PASSWORD are required" } }
					"ALTER ROLE electric PASSWORD :'electric';\nALTER ROLE authenticator PASSWORD :'authenticator';\n" | ^$psql -h $host_arg -p $init_port -U $user -d $db -v ON_ERROR_STOP=1 -q $"--set=electric=($elec)" $"--set=authenticator=($auth)" out> (null-device)
				}
			}
		}
		^$pg_ctl -D $pgdata -m fast -w stop
	} catch {|err|
		try { ^$pg_ctl -D $pgdata -m immediate -w stop } catch { }
		rm -rf $pgsock
		print -e ($err.msg? | default ($err | to text))
		exit 1
	}
	rm -rf $pgsock
	let rest = (if (($args | length) > 0) and (($args | first) == "postgres") { $args | skip 1 } else { $args })
	let port = ($env.PGPORT? | default "5432")
	if $os == "windows" {
		let srv_opts = (["-c" "listen_addresses=localhost" "-p" $port "-c" "timezone=UTC" "-c" "log_timezone=UTC"] | append $rest | str join " ")
		^$pg_ctl -D $pgdata -l ($pgdata | path join "server.log") -o $srv_opts -w start
		while ((do { ^$pg_ctl -D $pgdata status } | complete).exit_code == 0) { sleep 500ms }
	} else {
		exec ($pg_bin | path join "postgres") -D $pgdata -c listen_addresses=localhost -p $port -c "unix_socket_directories=" -c timezone=UTC -c log_timezone=UTC ...$rest
	}
}
