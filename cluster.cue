// The virtual cluster, published as CUE: mecha's canonical local topology as
// bayt targets, instantiated per app. Every service is an addressable field —
// consumers override by unification and drop by setting null; that is the
// escape hatch, and pinning or forking this package is the versioning story.
// Escape-hatch-free apps never see this file: the generator that writes an
// app instantiates it; apps with hatches import it from their bayt.cue.
//
// Each target is bayt's vocabulary: the image is the Dockerfile bayt emits
// from `dockerfile`, the runtime is its `compose` block. A service that
// carries mecha's own content (the database's extensions and tenancy floor,
// the migration runner, the mesh's components, the conduit connector, the
// deno services) starts FROM the image mecha builds for it (bayt.cue, the
// `*-image` targets) and adds only what is the app's: migrations, the
// Caddyfile, pipelines. Names are bare and so are `depends_on` keys; #Runtime
// lowers the targets into a bayt project, which is what keeps `crud:3000` and
// `@database:5432` resolving.
package cluster

import (
	"encoding/json"
	"list"
	"path"
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	grammar "github.com/bonisoft3/mecha/pgroll"
)

// Where postgres applies what an image carries, in name order, on a fresh data
// directory.
#InitdbDir: "/docker-entrypoint-initdb.d"

// Where the migrate image holds the pgroll migrations it applies, as
// <name>.json.
#PgRollDir: "/pgroll"

// The tenancy floor's migration, which ships with the image whatever emitted
// the tables above it. It need not follow a caller's grants: it grants only to
// PUBLIC and makes no table in `public`, which is all theirs reach. It must
// precede the tables whose defaults call auth_uid() and the policies that call
// rls_protect, so it takes the slot after the extensions, roles and grants a
// caller opens with.
#TenancyMigration: "003_rls.sql"

// Where the database image keeps a step that a cluster places in #InitdbDir
// only when it turns on what the step serves.
#StagedDir: "/usr/share/mecha/initdb"

// The ticker's table, placed where a schedule is declared. Its name places it
// after a caller's grants, whose reach it revokes, and before the seed the
// caller names after it.
#ScheduleMigration: "020_schedule.sql"

// A health wait states no `restart`: bayt adds `restart: true` to every one
// (plugins/bayt/core/gen_compose.cue), so a dependency recreated inside an
// `up` recreates what waits on it.
_healthy: {condition: "service_healthy"}
_started: {condition: "service_started"}
// bayt adds no `restart` to a completion wait, and none is stated: a reader
// already running when the migrations are applied again is told to reload its
// schema (services/migrate/migrate.sh), not recreated.
_completed: {condition: "service_completed_successfully"}

// A file delivered into the cluster (caddy static).
#Static: {
	file:   string // path relative to the app dir
	target: string // absolute path inside the serving container
	watch:  *false | bool
}

// Where an image comes from, in bayt's own `from` arms: a target ref
// (`":database-image"` inside mecha's own project, `"libraries_mecha:database-image"`
// from another project of the monorepo) or a pinned image name.
#From: {ref: string} | {name: string}

// A #From handed to bayt as a plain struct: the definition is closed, and
// bayt's ref arm adds the qualified `name` to it.
_from: F={
	in: #From
	out: {for k, v in F.in {(k): v}}
}

// Pre-signed against the dev PGRST_JWT_SECRET: HS256, claims
// {role: "service", sub: all-zeros uuid, exp: 2033-01-01}. Compose default
// only — prod overrides both SERVICE_JWT and PGRST_JWT_SECRET together.
_devServiceJwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZSIsInN1YiI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6MTk4ODE1MDQwMH0.dGYz_sMSnOvZy0eANh7spJbgyr2fEzeynOERIqW7gd4"

_devJwtSecret: "mecha-dev-secret-please-override-32ch"
// The query parameter caddy adds after the gate and electric checks; one
// literal, so the two cannot be given different ones by a slip.
_devElectricSecret: "dev-electric-secret"

#Cluster: X={
	state: {
		migrations: [...string]
		// Changes to a schema that already exists, in pgroll's own grammar and
		// keyed by the version each creates. `migrations` build the schema on a
		// fresh volume; these carry a volume that outlived a change forward, and
		// a fresh one too, once initdb has run.
		pgroll: [grammar.#Name]: grammar.#Migration
		pipelines: [...{name: string, file: string}]
		// Numeric programs over the lake (services/compute/main.ts states the
		// contract): a module each, the tables it alone writes (`to`),
		// and the wasm modules its jobs call, shipped by their file names.
		computations: [...{name: string, file: string, every: int & >0, to: [...string] & [_, ...], wasm: [...string]}]
		// Names only: the cluster needs to know whether any schedule exists,
		// never what it says. One brings the ticker, its clock and the table
		// they sweep (#ScheduleMigration); the caller's migrations seed it.
		schedules: [...string]
	}

	capabilities: {
		// The data plane. Off, nothing server-side is instantiated: no
		// database, no crud gateway, no sync, no bus, no pipeline worker —
		// caddy alone, serving the terminal. An app whose every entity is a
		// browser durability (`tab`, `device`) stores nothing here to keep, and the
		// services would then be a cluster running for nobody. The terminal
		// is unchanged: its local collections never address a server, so the
		// same screens, forms and handlers run against either topology.
		server: *true | bool
		// The auth plane: a WebAuthn auth service issuing app_user JWTs, JWT
		// validation on crud, and the service token on transform. Off, the
		// stack is the pre-auth one, byte for byte. Identity is a row the
		// cluster keeps, so it presupposes `server`.
		auth: *false | bool
		if auth {
			server: true
		}

		// The change feed: conduit reading the WAL onto the bus (redis, behind
		// the mesh-events sidecar) and transform running the pipelines off it.
		// A pipeline or a schedule turns it on, and refuses it off: the
		// pipeline would never run, and the ticker's wake is addressed to that
		// sidecar. Off otherwise, since nothing in the cluster reads the feed.
		// The WAL is the data plane's, so it presupposes `server`.
		capture: *false | bool
		if len(X.state.pipelines) > 0 || len(X.state.schedules) > 0 {
			capture: true
		}
		if capture {
			server: true
		}

		// The blob plane: rclone-s3 object store (S3 wire protocol, bucket
		// mecha-objects, no auth keys — dev posture) and imgproxy, behind the
		// caddy /blobs and /img routes.
		blobs: *false | bool
	}
	// A migration given to a cluster with no database is one nothing applies.
	if !X.capabilities.server {
		state: pgroll: [string]: _|_
	}

	// Every step postgres runs at initdb, keyed by the three digits its name
	// opens with: the image's floor, the step the cluster places for a
	// schedule, and the caller's migrations. Postgres globs the directory in
	// its locale's order and a replay sorts it by byte; digits no other step
	// holds, then `_`, put both in one order. The database copies the caller's
	// steps out of this, so a name it refuses fails the cluster where it is
	// built.
	_initdb: [K=string]: =~"(^|/)[0-9]{3}_[^/]*$" & =~"(^|/)\(K)_[^/]*$"
	_initdb: {
		(strings.SliceRunes(#TenancyMigration, 0, 3)): #TenancyMigration
		if len(X.state.schedules) > 0 {
			(strings.SliceRunes(#ScheduleMigration, 0, 3)): #ScheduleMigration
		}
		for m in X.state.migrations {(strings.SliceRunes(path.Base(m, path.Unix), 0, 3)): m}
	}

	// No target runs a lifecycle command: the image is the recipe, the
	// process is the base image's own entrypoint, and no toolchain
	// activator wraps it — these images carry none.
	_image: {
		cmd: "builtin": null
		activate: ""
	}


	// What a service that reads the schema waits on: the database, and the
	// migrations that carry it forward when there are any. A migration that
	// fails therefore stops every reader from starting, rather than leaving
	// them to serve the schema it did not reach.
	_schemaReady: {
		database: _healthy
		if len(X.state.pgroll) > 0 {migrate: _completed}
	}

	let databaseUrl = "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
	let jwtSecret = "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
	// The scheme and host a reader reaches the door at, stated by the
	// deployment and never read off a request: the door answers any Host. Its
	// default is the door's own name for a person's browser (the Caddyfile's).
	let origin = "${ORIGIN:-https://localhost:8443}"

	surface: {
		// What the app's absolute addresses are spelled against
		// (docs/proxy.md, "The origin").
		"origin": origin

		// How a client on the cluster's network reaches its database, and the
		// secret crud and auth verify a session token under.
		if X.capabilities.server {
			"databaseUrl": databaseUrl
			"jwtSecret":   jwtSecret
		}

		// How this cluster's schema reaches its database.
		//
		// A cluster bakes its schema into the database image and lets postgres
		// apply it at initdb, in name order, on a fresh data directory; the
		// steps that ran there are the files the image carries. The pgroll
		// migrations are baked into the migrate image, whose one-shot run
		// records that schema as pgroll's baseline and applies every migration
		// the ledger lacks — on a fresh volume and on one that outlived a
		// change alike. Anything that applies this schema elsewhere, inspects
		// what it built, or reproduces it needs the facts below, and reading
		// them here is how it avoids keeping a second copy of this layout that
		// nothing would correct when it moved.
		if X.capabilities.server {
			schema: {
				// The target that runs the database; a compose project names
				// its service after it.
				target: "database"
				// The directory the image applies from.
				initdb: #InitdbDir
				if len(X.state.pgroll) > 0 {
					pgroll: {
						// The target that applies them, named the same way.
						target: "migrate"
						// Where its image holds them.
						dir: #PgRollDir
						// The ledger name initdb's schema is recorded under.
						baseline: grammar.#Baseline
					}
				}
			}
		}
		targets: [string]: _
		targets: {
			if X.capabilities.server {
				database: bayt.healthcheck.postgres & X._image & {
					healthcheck: {
						db:             "${POSTGRES_DB:-\(X.meta.app)}"
						user:           "${POSTGRES_USER:-postgres}"
						start_interval: "100ms"
						start_period:   "5m"
					}
					srcs: globs: X.state.migrations
					dockerfile: {
						from: (_from & {in: X.meta.images.database}).out
						// The image carries the extensions and the tenancy floor,
						// and stages the ticker's table, placed only where a
						// schedule is declared; the app's migrations join them in
						// the initdb directory, which postgres runs in name order
						// on a fresh data directory. That directory lives on the
						// container's writable layer, which `--force-recreate`
						// discards with it.
						copy: list.Concat([
							[{srcs: [for _, m in X._initdb if m != #TenancyMigration && m != #ScheduleMigration {m}], dst: "\(#InitdbDir)/"}],
							[if len(X.state.schedules) > 0 {
								from: (_from & {in: X.meta.images.database}).out
								srcs: ["\(#StagedDir)/\(#ScheduleMigration)"]
								dst:  "\(#InitdbDir)/\(#ScheduleMigration)"
							}],
						])
					}
					compose: {
						ports: ["5432"]
						environment: {
							POSTGRES_USER:        "${POSTGRES_USER:-postgres}"
							POSTGRES_PASSWORD:    "${POSTGRES_PASSWORD:-postgres}"
							POSTGRES_DB:          "${POSTGRES_DB:-\(X.meta.app)}"
							// ORDER BY on text reaches a reader, so it sorts the way a
							// dictionary does, not by byte: bytes put every accent past all
							// of ASCII and split the alphabet by case, so "ana" follows "Zoe".
							//
							// `und` and not a language, because the collation is one per
							// database and an app serves every locale it declares out of
							// the same rows.
							//
							// ICU and not a libc locale: glibc reorders between versions and
							// silently invalidates text indexes, where postgres records the
							// ICU version and warns. --locale=C keeps ctype off libc too.
							POSTGRES_INITDB_ARGS: "--no-sync --encoding=UTF8 --auth=trust --locale-provider=icu --icu-locale=und --locale=C"
						}
						// One rebuild entry per migration: the list is the consumer's, and
						// mecha's own stack keeps a fixture outside the migrations directory.
						develop: watch: [for m in X.state.migrations {action: "rebuild", path: "../\(m)", target: "/docker-entrypoint-initdb.d"}]
					}
				}
				// Only a cluster given pgroll migrations gets a runner: one with
				// none has nothing to carry forward, and its first migration
				// baselines whatever volume it meets.
				if len(X.state.pgroll) > 0 {
					migrate: X._image & {
						dockerfile: {
							// The database's own image, run as the runner.
							from: (_from & {in: X.meta.images.database}).out
							entrypoint: ["/migrate.sh"]
							cmd: [#PgRollDir, grammar.#Baseline]
							// Each migration is written into the image from the
							// value state.pgroll holds, so what runs is what was
							// vetted, and no file beside it can say otherwise. A
							// marshalled migration is one line opening with `{`,
							// never the delimiter, and the quoted delimiter keeps
							// the builder from expanding anything in it.
							epilogue: [for n, m in X.state.pgroll {
								"COPY <<'PGROLL' \(#PgRollDir)/\(n).json\n\(json.Marshal(m))\nPGROLL"
							}]
						}
						compose: {
							depends_on: database: _healthy
							environment: DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}?sslmode=disable"
						}
					}
				}
				crud: bayt.healthcheck.http & X._image & {
					healthcheck: {
						url:            "http://127.0.0.1:3001/ready"
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					dockerfile: {
						from: name: "postgrest/postgrest:v12.2.3@sha256:0a46780309a604cdc8b56c776c6e5e15788ce58174d709e40459ab5a2d44d228"
						cmd: ["postgrest"]
					}
					compose: {
						depends_on: X._schemaReady
						environment: {
							PGRST_DB_URI:       databaseUrl
							PGRST_DB_SCHEMA:    "public"
							PGRST_DB_ANON_ROLE: "anon"
							// Called once per request, in the request's transaction, after the
							// role switch: it sets app.scopes, which the tenancy floor reads.
							// Without it current_scopes() is empty and every floored table is
							// invisible -- the floor fails closed, so this is not optional.
							PGRST_DB_PRE_REQUEST:    "public.app_pre_request"
							PGRST_SERVER_HOST:       "*"
							PGRST_SERVER_PORT:       "3000"
							PGRST_ADMIN_SERVER_PORT: "3001"
							if X.capabilities.auth {
								PGRST_JWT_SECRET: jwtSecret
							}
						}
					}
				}
			}
			if X.capabilities.auth {
				"auth": X._image & {
					dockerfile: {
						from: (_from & {in: X.meta.images.auth}).out
						// deno runs `main.ts` from the working directory, and bayt
						// sets one per stage.
						workdir: "/app"
					}
					compose: {
						depends_on: X._schemaReady
						environment: {
							DATABASE_URL:     databaseUrl
							PGRST_JWT_SECRET: jwtSecret
							WEBAUTHN_RP_ID:   "${WEBAUTHN_RP_ID:-localhost}"
							// The door's port is the host's pick; auth reads this
							// default as whichever port the request came through.
							WEBAUTHN_ORIGIN: "${WEBAUTHN_ORIGIN:-https://localhost:*}"
						}
					}
				}
			}
			caddy: bayt.healthcheck.http & X._image & {
				healthcheck: {
					url:            "http://127.0.0.1:8080/health"
					interval:       "5s"
					start_interval: "500ms"
					start_period:   "10s"
				}
				// The statics are baked in, not mounted. A bind mount of a
				// file follows its inode, and an editor writing a file
				// atomically replaces that inode, leaving the mount pointing
				// at something deleted — every edit then 404s until the
				// container is recreated. `develop: watch` below updates them.
				//
				// The runtime's statics (the terminal's interpreter) arrive
				// through the `root` additional context, a path from .bayt/ to
				// the workspace root, which is why their COPY lines are
				// rewritten relative to it. The fingerprint covers only the
				// app's own files: a srcs glob cannot leave the project
				// directory.
				srcs: globs: list.Concat([
					[X.meta.caddyfile],
					[for s in X.meta.statics if !strings.HasPrefix(s.file, X.meta.runtime) {s.file}],
				])
				dockerfile: {
					from: name: "caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0"
					copy: list.Concat([
						[{srcs: [X.meta.caddyfile], dst: "/etc/caddy/Caddyfile"}],
						// mkcert's pair, where `sayt setup` issued one on this host;
						// trusted there once with `mkcert -install`. The wildcard is
						// what makes it optional: a context without .certs copies
						// nothing, and the door then serves Caddy's own CA.
						[{srcs: [".cert[s]"], dst: "/certs/"}],
						[for s in X.meta.statics {
							if strings.HasPrefix(s.file, X.meta.runtime) {
								from: {name: "root"}
								srcs: [strings.TrimPrefix(s.file, X.meta.root)]
							}
							if !strings.HasPrefix(s.file, X.meta.runtime) {
								srcs: [s.file]
							}
							dst: s.target
						}],
					])
				}
				compose: {
					build: additional_contexts: root: strings.TrimSuffix("../\(X.meta.root)", "/")
					// One published door. For an app it is h2 over TLS; the plain
					// listener still exists inside the container — the healthcheck
					// above uses it — but is deliberately NOT published: the
					// browser's six-connections-per-origin cap only exists on
					// HTTP/1.1, and a second front door is a path that only ever
					// runs on a laptop (docs/proxy.md).
					ports: [X.meta.door]
					// The Caddyfile substitutes this into the electric route, which is
					// the only place the secret is added. Same default as the electric
					// service reads, and both are overridden together or neither.
					environment: {
						ELECTRIC_SECRET: "${ELECTRIC_SECRET:-\(_devElectricSecret)}"
						ORIGIN:          origin
					}

					// Each served file's validator, `<file>.etag`, written as the door
					// starts (docs/proxy.md) under every root the Caddyfile names, read
					// off the config caddy adapts it to: whoever put a file in the
					// image, the door that serves it reads its sidecar. Every name
					// reaches sh as an argument, never as script, and the digest is
					// read off stdin, which sha256sum spells the same whatever the
					// name; `$$` is how compose is told a `$` is the shell's.
					let validators = #"set -e -o pipefail; roots=$$(caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile | tr , '\n' | sed -n 's/^.*"root":"\([^"]*\)".*$$/\1/p' | sort -u); if [ -n "$$roots" ]; then find $$roots -type f ! -name '*.etag' -exec sh -c 'set -e; for f do h=$$(sha256sum < "$$f"); printf \"%s\" "$${h%% *}" > "$$f.etag"; done' sh {} +; fi; "#
					// An ORIGIN that is no origin stops the door as it starts: a
					// template writes it into markup as it stands.
					let admitted = #"case "$${ORIGIN#http://}" in "$$ORIGIN") h=$${ORIGIN#https://};; *) h=$${ORIGIN#http://};; esac; case "$$h" in "$$ORIGIN"|""|*[!A-Za-z0-9.:-]*) echo "ORIGIN '$$ORIGIN' is no origin: set it to the scheme and host readers reach the door at, as https://app.example" >&2; exit 1;; esac; "#
					// The Caddyfile's door serves CADDY_TLS: the baked pair when the
					// host issued one, Caddy's own CA otherwise, so the stack comes up
					// before any mkcert step. The rest is the image's own command.
					command: ["sh", "-c", "\(admitted)\(validators)if [ -f /certs/localhost.pem ]; then export CADDY_TLS='/certs/localhost.pem /certs/localhost-key.pem'; fi; exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
					// Watch paths are from .bayt/ too, hence the ../ on each.
					develop: watch: list.Concat([
						[{action: "sync+restart", path: "../\(X.meta.caddyfile)", target: "/etc/caddy/Caddyfile"}],
						// A re-issued pair reaches a running door; the restart re-reads
						// it through the command above.
						[{action: "sync+restart", path: "../.certs", target: "/certs"}],
						// Honoured, not assumed: a static that says it is not watched is
						// one whose edit is a rebuild — a generated file, or a vendored
						// unit whose megabytes would restart the proxy on every launch.
						[for s in X.meta.statics if s.watch {action: "sync+restart", path: "../\(s.file)", target: s.target}],
					])
				}
			}
			if X.capabilities.server {
				electric: X._image & {
					dockerfile: from: name: "docker.io/bonitao/electric:1.8.0@sha256:7b6aed2d5fd356a5e5edd5290eeec0b19859ab798d3cbdb7d9d223fbb872a5ab"
					compose: {
						depends_on: X._schemaReady
						environment: {
							// Its own role, holding BYPASSRLS as a stated attribute: without it
							// current_scopes() is empty and every shape syncs empty, silently.
							// The role's password is the roles migration's literal, and the
							// database trusts every password here (initdb --auth=trust); a
							// deployment sets the role's password and this URL together,
							// outside this file.
							DATABASE_URL: "postgresql://electric:electric@database:5432/${POSTGRES_DB:-\(X.meta.app)}?sslmode=disable"
							// The proxy is the only way in: caddy runs forward_auth against the
							// gatekeeper and then adds this, so a request that reaches electric
							// without passing the gate has no secret to present.
							ELECTRIC_SECRET: "${ELECTRIC_SECRET:-\(_devElectricSecret)}"
							// Validate the publication the migrations declare rather than
							// build one, which would need CREATE on the database and
							// ownership of every table it names.
							ELECTRIC_MANUAL_TABLE_PUBLISHING: "true"
						}
						healthcheck: {
							test: ["CMD", "curl", "-f", "http://localhost:3000/v1/health"]
							interval:     "5s", timeout:         "5s", retries: 12
							start_period: "60s", start_interval: "500ms"
						}
						restart: "on-failure"
					}
				}
			}
			if X.capabilities.capture {
				redis: bayt.healthcheck.redis & X._image & {
					healthcheck: {
						interval:       "5s"
						retries:        6
						start_period:   "10s"
						start_interval: "500ms"
					}
					dockerfile: {
						from: name: "redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933"
						workdir: "/data"
					}
					compose: {}
				}
				"mesh-events": bayt.healthcheck.tcp & X._image & {
					healthcheck: {
						port:           3500
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					dockerfile: from: (_from & {in: X.meta.images.mesh}).out
					compose: {
						depends_on: {caddy: _started, redis: _started}
						restart: "on-failure"
					}
				}
				conduit: bayt.healthcheck.http & X._image & {
					healthcheck: {
						url:            "http://127.0.0.1:8080/healthz"
						interval:       "5s"
						retries:        20
						start_period:   "120s"
						start_interval: "500ms"
					}
					srcs: globs: [X.meta.conduitTemplate]
					dockerfile: {
						from: (_from & {in: X.meta.images.conduit}).out
						// conduit's standalone plugin registry searches <cwd>/connectors,
						// and bayt sets a working directory per stage.
						workdir: "/app"
						// The template sits beside the pipelines directory, not in it,
						// so the rendered file is the only pipeline conduit finds and
						// every start of the container can render it again.
						copy: [{srcs: [X.meta.conduitTemplate], dst: "/conduit/cdc-to-bus.yaml.tmpl"}]
						cmd: ["sh", "-c", "mkdir -p /conduit/pipelines && envsubst < /conduit/cdc-to-bus.yaml.tmpl > /conduit/pipelines/cdc-to-bus.yaml && exec /app/conduit run"]
					}
					compose: {
						// The database is named ahead of the embedding because key
						// order is the order the waits are emitted in.
						depends_on: {database: _healthy, X._schemaReady, "mesh-events": _started}
						develop: watch: [{action: "sync+restart", path: "../\(X.meta.conduitTemplate)", target: "/conduit/cdc-to-bus.yaml.tmpl"}]
						environment: {
							DATABASE_URL:           databaseUrl
							CONDUIT_PIPELINES_PATH: "/conduit/pipelines"
							CONDUIT_DB_TYPE:        "inmemory"
						}
						restart: "on-failure"
					}
				}
			}
			if X.capabilities.blobs {
				// rclone's own image: its entrypoint makes the bucket and serves it.
				"rclone-s3": X._image & {
					dockerfile: {
						from: name: "rclone/rclone:1.71.0@sha256:fd635aecd9667ee3c3bf920d14118090d4f2a83a080c1fa77e0bafbd4587ca87"
						entrypoint: ["sh", "-c", "mkdir -p \"/data/$RCLONE_LOCAL_BUCKET\" && exec rclone serve s3 --addr=0.0.0.0:3900 --vfs-cache-mode=off /data"]
					}
					compose: {
						environment: RCLONE_LOCAL_BUCKET: "mecha-objects"
						healthcheck: {
							test: ["CMD-SHELL", "wget -S -O /dev/null http://127.0.0.1:3900/ 2>&1 | grep -q 'HTTP/'"]
							interval:     "5s", timeout:         "5s", retries: 6
							start_period: "10s", start_interval: "500ms"
						}
					}
				}
				imgproxy: X._image & {
					dockerfile: from: name: "ghcr.io/imgproxy/imgproxy:v3.31.1@sha256:2b7a56dbf9c8a8e12e7109a5bdd27d31a8c1aa49f2116c927c6aedc37e18db98"
					compose: {
						depends_on: "rclone-s3": _started
						environment: {
							IMGPROXY_USE_S3:      "true"
							IMGPROXY_S3_ENDPOINT: "http://rclone-s3:3900"
							// rclone serve s3 without auth keys accepts any credentials;
							// imgproxy's S3 client still insists on having a pair.
							AWS_ACCESS_KEY_ID:                  "${RCLONE_ACCESS_KEY:-GK000000000000000000000000}"
							AWS_SECRET_ACCESS_KEY:              "${RCLONE_SECRET_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
							AWS_REGION:                         "rclone"
							IMGPROXY_BIND:                      ":8081"
							IMGPROXY_MAX_SRC_RESOLUTION:        "50"
							IMGPROXY_SET_CANONICAL_HEADER:      "false"
							IMGPROXY_CACHE_CONTROL_PASSTHROUGH: "true"
						}
						healthcheck: {
							test: ["CMD-SHELL", #"bash -c 'echo -e "GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n" > /dev/tcp/127.0.0.1/8081'"#]
							interval:     "5s", timeout:         "5s", retries: 6
							start_period: "10s", start_interval: "500ms"
						}
						restart: "on-failure"
					}
				}
			}
			if len(X.state.pipelines) > 0 {
				transform: X._image & {
					srcs: globs: [for p in X.state.pipelines {p.file}]
					dockerfile: {
						from: name: "redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c"
						copy: [for p in X.state.pipelines {srcs: [p.file], dst: "/pipelines/\(p.name).yaml"}]
						cmd: list.Concat([["streams", "--no-api"], [for p in X.state.pipelines {"/pipelines/\(p.name).yaml"}]])
					}
					compose: {
						depends_on: {redis: _healthy, crud: _healthy}
						environment: {
							// Straight to PostgREST: the proxy's client-facing Prefer
							// injection would clobber the pipelines' merge-duplicates upserts.
							CRUD_URL:  "http://crud:3000"
							REDIS_URL: "redis://redis:6379"
							if X.capabilities.auth {
								SERVICE_JWT: "${SERVICE_JWT:-\(_devServiceJwt)}"
							}
						}
						restart: "on-failure"
						if len(X.state.pipelines) > 0 {
							develop: watch: [for p in X.state.pipelines {
								action: "sync+restart"
								path:   "../\(p.file)"
								target: "/pipelines/\(p.name).yaml"
							}]
						}
					}
				}
			}
			// The numeric stage: an app's computations, each reading the lake
			// the service publishes from Postgres, writing back through crud
			// as the service role, the path every pipeline writes by.
			if len(X.state.computations) > 0 {
				// Two computations may share a wasm module; it ships once.
				let _wasm = [for w, _ in {for c in X.state.computations for w in c.wasm {(w): true}} {file: w, target: "/app/computations/\(path.Base(w, path.Unix))"}]
				let _target = {for w in _wasm {(w.file): w.target}}
				compute: X._image & {
					srcs: globs: list.Concat([[for c in X.state.computations {c.file}], [for w in _wasm {w.file}]])
					dockerfile: {
						from: (_from & {in: X.meta.images.compute}).out
						copy: list.Concat([
							[for c in X.state.computations {srcs: [c.file], dst: "/app/computations/\(c.name).js"}],
							[for w in _wasm {srcs: [w.file], dst: w.target}],
						])
					}
					compose: {
						depends_on: {X._schemaReady, crud: _healthy}
						environment: {
							CRUD_URL:     "http://crud:3000"
							DATABASE_URL: "postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
							LAKE_DIR:     "/lake"
							COMPUTATIONS: json.Marshal([for c in X.state.computations {
								name:  c.name
								file:  "/app/computations/\(c.name).js"
								every: c.every
								to:    c.to
								wasm: [for w in c.wasm {_target[w]}]
							}])
							if X.capabilities.auth {
								SERVICE_JWT: "${SERVICE_JWT:-\(_devServiceJwt)}"
							}
						}
						restart: "on-failure"
						develop: watch: list.Concat([
							[for c in X.state.computations {
								action: "sync+restart"
								path:   "../\(c.file)"
								target: "/app/computations/\(c.name).js"
							}],
							[for w in _wasm {
								action: "sync+restart"
								path:   "../\(w.file)"
								target: w.target
							}],
						])
					}
				}
			}
			// Only an app that declares a schedule gets a clock. A ticker with
			// nothing to sweep is a container answering pokes nobody sends.
			if len(X.state.schedules) > 0 {
				ticker: X._image & {
					dockerfile: {
						from: (_from & {in: X.meta.images.ticker}).out
						workdir: "/app"
					}
					compose: {
						depends_on: crud: _healthy
						environment: {
							// Straight to PostgREST, like the pipelines above.
							CRUD_URL: "http://crud:3000"
							// mesh-events, never mesh: the wake has to reach the
							// daprd bundled with the WAL reader and the pipeline
							// worker, which is the unit asleep at cloud tier.
							MESH_URL:    "http://mesh-events:3500"
							SERVICE_JWT: "${SERVICE_JWT:-\(_devServiceJwt)}"
						}
						restart: "on-failure"
					}
				}
				// What pokes the ticker. services/clock/clock.yaml states the
				// pipeline and why the cadence is what it is.
				clock: X._image & {
					dockerfile: from: (_from & {in: X.meta.images.clock}).out
					compose: {
						depends_on: ticker: _started
						environment: {
							POKE_INTERVAL: "${POKE_INTERVAL:-60s}"
							POKE_CALLER:   "compose"
							SERVICE_JWT:   "${SERVICE_JWT:-\(_devServiceJwt)}"
						}
						restart: "on-failure"
					}
				}
			}
			// The aggregate a consumer brings up: a container that does nothing
			// but wait on everything else, so `up --wait launch` returns when
			// the whole plane is healthy.
			launch: X._image & {
				dockerfile: {
					from: name: bayt.lock.images.busybox
					cmd: ["tail", "-f", "/dev/null"]
				}
				compose: {
					depends_on: {
						caddy: _healthy
						if X.capabilities.server {
							database: _healthy
							crud:     _healthy
							electric: _healthy
						}
						if X.capabilities.capture {
							redis:         _healthy
							"mesh-events": _healthy
							conduit:       _healthy
						}
						if len(X.state.pipelines) > 0 {
							transform: _started
						}
						if len(X.state.computations) > 0 {
							compute: _started
						}
						if X.capabilities.auth {
							auth: _started
						}
						if X.capabilities.blobs {
							"rclone-s3": _healthy
							imgproxy:    _healthy
						}
						// A clock absent from here is a clock nothing starts. It
						// pulls the ticker in behind it.
						if len(X.state.schedules) > 0 {
							clock: _started
						}

						// Consumer-added services (escape hatches) gate here by
						// unification, which the closed definition would otherwise refuse.
						...
					}
					healthcheck: {
						test: ["CMD", "echo", "\(X.meta.app) is healthy"]
						interval: "5s"
						timeout:  "2s"
						retries:  3
					}
				}
			}
		}
		// What the cluster declares about its own surface: work under `verbs`,
		// assertions under `checks`. `verb` is the layer each needs, not a
		// label — caddy adapt reads a file and so belongs at lint. The loop
		// routes each into the matching rulemap and owns this vocabulary; it is
		// restated here because mecha is consumed on its own and cannot import
		// a sibling plugin.
		verbs: [Name=string]: {verb: "setup" | "generate" | "build" | "launch" | "release", cmds: [...string], note: string}
		checks: [Name=string]: {verb: "lint" | "test" | "integrate", cmds: [...string], note: string}
		checks: caddy: {
			verb: "lint"
			// `adapt`, not `validate`: validate also PROVISIONS, which loads the
			// TLS certificate — and the path in the config is the container's,
			// so a host-side lint would fail on every machine for a file that is
			// only ever mounted at runtime. adapt still fails on anything
			// malformed, which is what a lint is for. The adapted config is
			// 6 KB on one line, so it goes to the null device, which nu spells
			// per host and offers no constant for: `| ignore` would drop the
			// exit status along with it, and the status is the verdict. The
			// secret and origin placeholders have to hold something for their
			// lines to parse; compose sets them at runtime, and this is not
			// runtime.
			cmds: ["with-env {ELECTRIC_SECRET: lint, ORIGIN: lint} { mise exec -- caddy adapt --config \(X.meta.caddyfile) --adapter caddyfile out> (if $nu.os-info.name == \"windows\" { \"NUL\" } else { \"/dev/null\" }) }"]
			note: "checks the cluster's own proxy config parses"
		}
		// The door is h2, h2 needs TLS, and TLS needs a certificate the
		// developer's browser trusts — so the cluster asks for one at setup
		// rather than issuing an untrusted one at boot. Issuing is idempotent
		// and touches nothing outside the app dir; TRUSTING it is the one step
		// left to a human, because it writes to the system keychain — so setup
		// ends by printing that command instead of running it.
		//
		// Untrusted, the cert is still served and visual lint still drives it
		// (it ignores certificate errors); only a human browser complains, and
		// its interstitial blocks WebAuthn outright.
		verbs: certs: {
			verb: "setup"
			// Two cmds, not one joined with `&&`: sayt runs these through
			// nushell, which rejects the shell operator outright. nu's mkdir
			// makes parents and is idempotent, so re-running setup is free.
			cmds: [
				"mkdir .certs",
				"mise exec -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost 127.0.0.1 ::1",
				"print 'the browser trusts this certificate only once you run: mise exec -- mkcert -install'",
			]
			note: "issues the locally-trusted certificate the https door serves"
		}
		// The same issuance, so the stack comes up for someone who has not run
		// setup. Guarded because mkcert would otherwise mint a fresh pair every
		// launch, and the browser would meet a new certificate each time.
		verbs: certsLaunch: {
			verb: "launch"
			cmds: [
				"if not ('.certs/localhost.pem' | path exists) { mkdir .certs; mise exec -- mkcert -cert-file .certs/localhost.pem -key-file .certs/localhost-key.pem localhost 127.0.0.1 ::1 }",
			]
			note: "issues the certificate the https door serves, if setup has not"
		}
	}

	meta: {
		app: string
		// The images mecha builds, one per service that carries mecha's own
		// content (bayt.cue, the `*-image` targets). Stated by the consumer:
		// same-project refs in mecha's own stack, cross-project refs from an
		// app in the monorepo, pinned names where the images are pulled.
		images: {
			database: #From
			mesh:     #From
			conduit:  #From
			auth:     #From
			ticker:   #From
			clock:    #From
			compute:  #From
		}
		// The proxy's config, relative to the app dir.
		caddyfile: *"docker/Caddyfile" | string
		// The one published door, in compose's `host:container` form.
		door: *"${CADDY_TLS_HOST_PORT:-0}:8443" | string
		// The conduit pipeline, an envsubst template, relative to the app dir.
		conduitTemplate: *"docker/conduit-pipeline.yaml" | string
		statics: [...#Static]
		// The workspace root and the runtime's directory, as paths from the
		// app dir: the monorepo's unless the app states its own layout.
		root:    *"../../" | string
		runtime: *root | string
	}
}

// The cluster lowered into a bayt project. bayt names a service
// `<project>-<target>`, so `depends_on` keys take the prefix; the bare name
// stays as the service's network alias, which is what the Caddyfile, the
// pipelines and every `@database:5432` URL address. Each wait is also an
// image-only dep, so the entry closures carry the fragments of what they
// wait on. Rebuilt field by field rather than unified: unifying a qualified
// `depends_on` onto the bare one would keep both key sets. A target nulled
// by a hatch is dropped, and a wait on a name no target answers to fails
// here rather than at `up`.
#Runtime: R={
	project: string
	cluster: #Cluster

	_live: {for n, t in R.cluster.surface.targets if t != null {(n): t}}
	// What a target waits on; a target that waits on nothing has no field.
	_waits: W={
		t: _
		out: [if W.t.compose.depends_on != _|_ {W.t.compose.depends_on}, {}][0]
	}
	targets: {
		for n, t in R._live {
			(n): {
				for f, v in t if f != "compose" && f != "deps" {(f): v}
				deps: [for k, _ in (R._waits & {"t": t}).out {":\(k):outs"}]
				compose: {
					for f, v in t.compose if f != "depends_on" {(f): v}
					depends_on: {for k, v in (R._waits & {"t": t}).out {("\(R.project)-\(k)"): v}}
					networks: default: aliases: [n]
				}
			}
		}
	}
	_dangling: [
		for n, t in R._live for k, _ in (R._waits & {"t": t}).out
		if !list.Contains([for m, _ in R._live {m}], k) {"\(n) waits on \(k)"},
	]
	_dangling: []
}
