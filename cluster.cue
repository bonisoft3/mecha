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
@extern(embed)
package cluster

import (
	"encoding/json"
	"list"
	"path"
	"regexp"
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	grammar "github.com/bonisoft3/mecha/pgroll"
)

_electricPatch: _ @embed(file="services/electric/patch.exs", type=text)
_computeEvents: _ @embed(file="services/compute/events.yaml", type=text)

// Where postgres applies what an image carries, in name order, on a fresh data
// directory.
#InitdbDir: "/docker-entrypoint-initdb.d"

// Where the migrate image holds the pgroll migrations it applies, as
// <name>.json.
#PgRollDir: "/pgroll"

#ConduitSlot: {app: string, name: "\(strings.Replace(app, "-", "_", -1))_conduit_slot"}

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

// The ticker's table, placed where a schedule is declared, and carried inside
// the airlock's step where an effect is (bayt.cue). Its name places it after
// a caller's grants, whose reach it revokes, and before the seed the caller
// names after it.
//
// Initdb prefixes are split three ways: a caller's own steps hold 000-799,
// the framework's (mecha's and pronto's) 800-899, and a caller's seed 900.
// One file per prefix, so the framework keeps out of the range an app
// numbers its steps in, and pronto refuses an app step in 8xx.
#ScheduleMigration: "800_schedule.sql"
// Staged in the database image at 020 for compatibility with the published
// bonitao/mecha-database:0.8.0 image, and placed in initdb at 800.
#ScheduleStaged: "020_schedule.sql"

// Graphile Worker's schema and the airlock's tables, placed where an effect
// is declared, on the first digits after the steps a caller opens with
// (pronto's 000-010: extensions, roles, grants, types, tables, policies,
// publication, validations, and the machines, whose guards are plpgsql and
// resolve add_job and the ledger only when they run). Every caller step that
// can write a row, a held seed included, is numbered above them, since a row
// written into an invoking state claims the ledger and enqueues as it is
// written; a caller step on these digits is refused where effects are
// declared, as any two steps sharing digits are. The ledger's schema is its
// own (services/airlock/airlock.sql), so no grant over `public`, made before
// these steps or after, reaches it.
#GraphileMigration: "011_graphile_worker.sql"
#AirlockMigration:  "012_airlock.sql"

// What a sink may be: an https origin whose host is a DNS name of at least
// two labels, the last opening with a letter. This is spelling only: a
// single-label host (`database`) or an IP literal is refused here; a name that
// resolves inward, which spelling cannot see, is not, since the daprd dials
// what its binding names (pronto's external effects record, "The wall is the
// allowlist").
#OriginPattern: "^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:[0-9]{1,5})?$"
#Origin:        =~#OriginPattern

// A DNS label, which an effect's name is because its Dapr endpoint's is.
#EffectName: "^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$"

// What a computation's or an effect's module may be endowed with past the
// language, each only where its declaration names it, as pronto endows an
// omnishell module with Intl. services/compute/language.ts holds the same
// list (ENDOWABLE), and cluster_test.ts holds them to each other.
#CageEndowments: ["Crypto", "TextEncoder", "TextDecoder", "URL", "URLSearchParams"]
#CageEndowment:  or(#CageEndowments)

// An environment variable's name: where a secret reaches the airlock.
#SecretName: "^[A-Z][A-Z0-9_]*$"

// A server a bridge dials: a DNS name of two labels or more and its port.
// Spelling only, as #OriginPattern is; the bridge refuses a name that
// resolves inward at the address it connected (services/airlock/mail.ts).
#ServerPattern: "^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]([a-z0-9-]*[a-z0-9])?:[0-9]{1,5}$"

// A bridge: a container on the airlock's outbound network that takes HTTP
// from its daprd and speaks another protocol to one declared server, its
// `--allow-net` being that server and nothing else. `mail` is mecha's own,
// services/airlock/mail.ts: SMTP, STARTTLS required unless the program says
// the server is one it owns and runs in the clear.
#Bridge: B={
	name:   =~#EffectName
	kind:   "mail"
	server: =~#ServerPattern
	tls:    *"starttls" | "none"
	// The right-hand side of every Message-ID the bridge sends.
	domain: =~"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]([a-z0-9-]*[a-z0-9])?$"
	// The environment variables holding the server's credentials, together
	// or not at all.
	user?:     =~#SecretName
	password?: =~#SecretName
	if B.user != _|_ {password: =~#SecretName}
	if B.password != _|_ {user: =~#SecretName}
}

// What the mail bridge may read of its environment.
_bridgeEnv: ["MAIL_SMTP", "MAIL_TLS", "MAIL_MESSAGE_ID_DOMAIN", "MAIL_USER", "MAIL_PASSWORD", "ETHEREAL_API", "ETHEREAL_API_KEY", "ETHEREAL_CACHE", "ETHEREAL_WEB"]

// The port every bridge serves its daprd on.
#BridgePort: 8080

// An external effect as the cluster places it: its name, the one origin it
// may reach or the bridge it reaches through, and where the app keeps its
// handler and its binding.
#Effect: E={
	name: =~#EffectName
	{origin: #Origin} | {bridge: =~#EffectName}
	handler:  *"effects/\(E.name).js" | string
	endpoint: *"services/airlock/dapr/\(E.name).yaml" | string
	// The environment variables whose values the handler is handed.
	secrets?: [...=~#SecretName]
}

// The networks around the airlock. `airlock`, internal, holds the airlock, the
// database and the airlock's daprd, so the airlock reaches the world only
// through that daprd; `airlock-out`, internal, holds the daprd and the
// bridges, which no other service reaches. What goes out leaves on a network
// of its own, which nothing else joins: `airlock-egress` for the daprd's
// declared bindings, and `bridge-<name>-egress` for each bridge's one server.
// `airlock-wake`, internal, holds the airlock and the ticker alone, so the
// ticker's wake reaches the airlock's health port and nothing of its daprd.
// None of them stands on the default network, where every other service is,
// so no service there reaches the daprd's bindings API or a bridge. A consumer
// declares the networks at the top of its compose model, which bayt does not
// write; `surface.networks` is what it declares.
#AirlockNetworks: {
	airlock: internal:        true
	"airlock-out": internal:  true
	"airlock-wake": internal: true
	"airlock-egress": {}
}

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
		computations: [...{name: string, file: string, to: [...string] & [_, ...], wasm: [...string], onComplete?: string & =~"^[a-z_][a-z0-9_]{0,62}$", endowments: *[] | [...#CageEndowment]}]
		// Names only: the cluster needs to know whether any schedule exists,
		// never what it says. One brings the ticker, its clock and the table
		// they sweep (#ScheduleMigration); the caller's migrations seed it.
		schedules: [...string]
		// The external effects (services/airlock/README.md states the
		// contract). One brings the airlock, the daprd it goes out through,
		// the ticker and clock that wake it, and the tables they keep
		// (#GraphileMigration, #AirlockMigration, the schedule table inside
		// the latter).
		effects: [...#Effect]
		// The bridges those effects reach through, each placed as
		// bridge-<name> (#Bridge).
		bridges: *[] | [...#Bridge]
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
		// stack is the pre-auth one, byte for byte, but for crud verifying
		// the service token where a wake needs it (_serviceToken). Identity
		// is a row the cluster keeps, so it presupposes `server`.
		auth: *false | bool
		if auth {
			server: true
		}

		// The change feed: conduit reading the WAL onto the bus (redis, behind
		// the mesh-events sidecar) and transform running the pipelines off it.
		// A pipeline, computation or schedule turns it on, and refuses it off: the
		// pipeline would never run, and the ticker's wake is addressed to that
		// sidecar. Off otherwise, since nothing in the cluster reads the feed.
		// The WAL is the data plane's, so it presupposes `server`.
		capture: *false | bool
		if len(X.state.pipelines)+len(X.state.computations)+len(X.state.schedules) > 0 {
			capture: true
		}
		if capture {
			server: true
		}
		// An effect runs from the database's queue and settles in its ledger.
		if len(X.state.effects) > 0 {
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
	// opens with: the image's floor, the steps the cluster places for a
	// schedule and for effects, and the caller's migrations. Postgres globs
	// the directory in its locale's order and a replay sorts it by byte;
	// digits no other step holds, then `_`, put both in one order. The database copies the caller's
	// steps out of this, so a name it refuses fails the cluster where it is
	// built.
	_initdb: [K=string]: =~"(^|/)[0-9]{3}_[^/]*$" & =~"(^|/)\(K)_[^/]*$"
	_initdb: {
		(strings.SliceRunes(#TenancyMigration, 0, 3)): #TenancyMigration
		if len(X.state.schedules) > 0 {
			(strings.SliceRunes(#ScheduleMigration, 0, 3)): #ScheduleMigration
		}
		if len(X.state.effects) > 0 {
			(strings.SliceRunes(#GraphileMigration, 0, 3)): #GraphileMigration
			(strings.SliceRunes(#AirlockMigration, 0, 3)):  #AirlockMigration
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

	// The effects as every target reads them. A field's pattern is checked
	// when the field is exported, not when an interpolation reads it, so each
	// is matched here; one refused leaves an index out of range in every
	// command line and path built from it.
	_effects: [for e in X.state.effects {
		name:     [if regexp.Match(#EffectName, e.name) {e.name}][0]
		handler:  e.handler
		endpoint: e.endpoint
	}]
	// The origins and the bridges the effects reach, read from the
	// declaration as the signing keys are, so a refused origin or a bridge no
	// one declared fails the export rather than dropping out of a list.
	_origins: [for e in X.state.effects if e.origin != _|_ {[if regexp.Match(#OriginPattern, e.origin) {e.origin}][0]}]
	_reached: [for e in X.state.effects if e.bridge != _|_ {[if list.Contains(_bridgeNames, e.bridge) {e.bridge}][0]}]
	_bridgeNames: [for b in X.state.bridges {b.name}]
	_bridges: [for b in X.state.bridges {
		name:   [if regexp.Match(#EffectName, b.name) {b.name}][0]
		kind:   b.kind
		server: [if regexp.Match(#ServerPattern, b.server) {b.server}][0]
		tls:    b.tls
		domain: b.domain
		if b.user != _|_ {
			user:     [if regexp.Match(#SecretName, b.user) {b.user}][0]
			password: [if regexp.Match(#SecretName, b.password) {b.password}][0]
		}
	}]
	// The secrets, each matched like the fields above. Read from the
	// declaration, so a refused name fails the export instead of silently
	// leaving the airlock without it.
	_secrets: [for e in X.state.effects if e.secrets != _|_ for s in e.secrets {[if regexp.Match(#SecretName, s) {s}][0]}]

	// The steps the database image stages and this cluster places.
	// A schedule or an effect is woken by the ticker: a declared schedule by
	// its cadence, an effect by the one-shot row its guard re-arms, so a
	// cluster scaled to zero comes up for what was enqueued meanwhile.
	_wakes: len(X.state.schedules) > 0 || len(X.state.effects) > 0
	// The ticker reads and writes through crud as `service`, the role PostgREST
	// switches to on the token's claim and the one the schedule tables admit:
	// crud verifies the service token wherever something wakes, with or without
	// the auth plane. The token is a claim, not a peer identity, which is why no
	// transport credential stands in for it: without it every call is anon's.
	_serviceToken: X.capabilities.auth || X._wakes
	// The schedule table reaches an effect's cluster inside the airlock's
	// step (bayt.cue), ahead of any caller step.
	_staged: list.Concat([
		[if len(X.state.schedules) > 0 {{src: #ScheduleStaged, dst: #ScheduleMigration}}],
		[if len(X.state.effects) > 0 for m in [#GraphileMigration, #AirlockMigration] {{src: m, dst: m}}],
	])

	let databaseUrl = "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
	let jwtSecret = "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
	// The scheme and host a reader reaches the door at, stated by the
	// deployment and never read off a request: the door answers any Host. Its
	// default is the door's own name for a person's browser (the Caddyfile's)
	// on the port it binds, which bayt fills into `${<door.env>}`.
	let origin = "${ORIGIN:-\(X.meta.door.scheme)://localhost:${\(X.meta.door.env)}}"

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
		// The networks a consumer declares at the top of its compose model;
		// the targets below join them by name.
		if len(X.state.effects) > 0 {
			networks: {
				#AirlockNetworks
				for b in X._bridges {"bridge-\(b.name)-egress": {}}
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
						// and stages the ticker's table and the airlock's steps,
						// placed only where a schedule or an effect is declared;
						// the app's migrations join them in
						// the initdb directory, which postgres runs in name order
						// on a fresh data directory. That directory lives on the
						// container's writable layer, which `--force-recreate`
						// discards with it.
						copy: list.Concat([
							[{srcs: [for _, m in X._initdb if m != #TenancyMigration && !list.Contains([for s in X._staged {s.dst}], m) {m}], dst: "\(#InitdbDir)/"}],
							[for s in X._staged {
								from: (_from & {in: X.meta.images.database}).out
								srcs: ["\(#StagedDir)/\(s.src)"]
								dst:  "\(#InitdbDir)/\(s.dst)"
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
						if len(X.state.effects) > 0 {networks: ["default", "airlock"]}
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
							environment: {
								DATABASE_URL: "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}?sslmode=disable"
								// The schedule step is initdb's alone, so a volume older
								// than the cluster's first schedule lacks its table.
								if len(X.state.schedules) > 0 {REQUIRED_TABLES: "schedule"}
							}
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
							if X._serviceToken {
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
					// The root an app static's target mirrors its path under, or "".
					let _under = [for s in X.meta.statics {[
						if !strings.HasPrefix(s.file, X.meta.runtime) if strings.HasSuffix(s.target, "/\(s.file)") {strings.TrimSuffix(s.target, s.file)},
						"",
					][0]}]
					// Runs of consecutive statics under one root; any other static
					// is a run of its own.
					let _prev = list.Concat([[null], _under])
					let _starts = [for i, u in _under if u == "" || _prev[i] != u {i}]
					let _end = {for r, i in _starts {"\(i)": [if r+1 < len(_starts) {_starts[r+1]}, len(_under)][0]}}
					from: name: "caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0"
					copy: list.Concat([
						[{srcs: [X.meta.caddyfile], dst: "/etc/caddy/Caddyfile"}],
						// mkcert's pair, where `sayt setup` issued one on this host;
						// trusted there once with `mkcert -install`. The wildcard is
						// what makes it optional: a context without .certs copies
						// nothing, and the door then serves Caddy's own CA.
						[{srcs: [".cert[s]"], dst: "/certs/"}],
						// One COPY, so one image layer, per run: the image stays
						// under the overlay depth limit however many statics an
						// app serves, and runs keep their order for overwrites.
						[for i, s in X.meta.statics if _end["\(i)"] != _|_ {[
							if strings.HasPrefix(s.file, X.meta.runtime) {
								{from: {name: "root"}, srcs: [strings.TrimPrefix(s.file, X.meta.root)], dst: s.target}
							},
							if _under[i] != "" {
								{srcs: [for t in list.Slice(X.meta.statics, i, _end["\(i)"]) {t.file}], dst: _under[i], parents: true}
							},
							{srcs: [s.file], dst: s.target},
						][0]}],
					])
				}
				// One published door. For an app it is h2 over TLS; the plain
				// listener still exists inside the container — the healthcheck
				// above uses it — but is deliberately NOT published: the
				// browser's six-connections-per-origin cap only exists on
				// HTTP/1.1, and a second front door is a path that only ever
				// runs on a laptop (docs/proxy.md).
				expose: door: {
					port: X.meta.door.port
					publish: environment: X.meta.door.env
					if X.meta.door.host != _|_ {host: X.meta.door.host}
				}
				compose: {
					build: additional_contexts: root: strings.TrimSuffix("../\(X.meta.root)", "/")
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
					dockerfile: {
						from: name: "docker.io/electricsql/electric-temp:1.8.1@sha256:910d5ebeca68c87c930ccd1b35426c7bc94d79c099ccacc8f27547b74fb4353a"
						// Initialization must retain requests already waiting for the snapshot.
						preamble: ["COPY <<'ELIXIR' /tmp/electric-patch.exs\n\(_electricPatch)\nELIXIR"]
						epilogue: ["RUN DATABASE_URL=postgresql://compile:compile@localhost/compile ELECTRIC_SECRET=compile-only /app/bin/entrypoint eval 'Code.eval_file(\"/tmp/electric-patch.exs\")' && rm /tmp/electric-patch.exs"]
					}
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
			if len(X.state.pipelines)+len(X.state.computations) > 0 {
				transform: X._image & {
					srcs: globs: [for p in X.state.pipelines {p.file}]
					dockerfile: {
						from: name: "redpandadata/connect:4.112.0@sha256:5b70cd14fd2bbb8fe02a80358ed1510169596218d0d46cd7768659b1d1cf8420"
						copy: [for p in X.state.pipelines {srcs: [p.file], dst: "/pipelines/\(p.name).yaml"}]
						if len(X.state.computations) > 0 {
							epilogue: ["COPY <<'COMPUTE' /compute-events.yaml\n\(_computeEvents)\nCOMPUTE"]
						}
						cmd: list.Concat([["streams", "--no-api"], [for p in X.state.pipelines {"/pipelines/\(p.name).yaml"}], [if len(X.state.computations) > 0 {"/compute-events.yaml"}]])
					}
					compose: {
						depends_on: {redis: _healthy, crud: _healthy}
						if len(X.state.computations) > 0 {
							depends_on: compute: _healthy
						}
						environment: {
							// Straight to PostgREST: the proxy's client-facing Prefer
							// injection would clobber the pipelines' merge-duplicates upserts.
							CRUD_URL:  "http://crud:3000"
							REDIS_URL: "redis://redis:6379"
							if len(X.state.computations) > 0 {COMPUTE_GROUP: "\(X.meta.app)-compute"}
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
				// Healthy once it serves: its port opens after the bootstrap run, and an
				// invalidation refused while that runs would spend its retries.
				compute: bayt.healthcheck.tcp & X._image & {
					healthcheck: {
						port:           9997
						interval:       "5s"
						start_interval: "1s"
						start_period:   "15m"
					}
					srcs: globs: list.Concat([[for c in X.state.computations {c.file}], [for w in _wasm {w.file}]])
					dockerfile: {
						from: (_from & {in: X.meta.images.compute}).out
						copy: list.Concat([
							[for c in X.state.computations {srcs: [c.file], dst: "/app/computations/\(c.name).js"}],
							[for w in _wasm {srcs: [w.file], dst: w.target}],
						])
					}
					compose: {
						depends_on: {X._schemaReady, crud: _healthy, conduit: _healthy}
						environment: {
							CRUD_URL:     "http://crud:3000"
							DATABASE_URL: "postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
							LAKE_DIR:     "/lake"
							CDC_SLOT:     (#ConduitSlot & {app: X.meta.app}).name
							COMPUTATIONS: json.Marshal([for c in X.state.computations {
								name: c.name
								file: "/app/computations/\(c.name).js"
								to:   c.to
								wasm: [for w in c.wasm {_target[w]}]
								endowments: c.endowments
								if c.onComplete != _|_ {onComplete: c.onComplete}
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
			// Only an app that declares a schedule or an effect gets a clock. A
			// ticker with nothing to sweep is a container answering pokes nobody
			// sends.
			if X._wakes {
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
							// The units a tick needs up, each asleep at cloud tier:
							// mesh-events, never mesh, the daprd bundled with the WAL
							// reader and the pipeline worker; and the airlock, for the
							// job a guard enqueued.
							WAKE_URLS: strings.Join(list.Concat([
								[if X.capabilities.capture {"http://mesh-events:3500/v1.0/healthz/outbound"}],
								[if len(X.state.effects) > 0 {"http://airlock:9997/healthz"}],
							]), ",")
							SERVICE_JWT: "${SERVICE_JWT:-\(_devServiceJwt)}"
						}
						// The airlock's health port, on a network holding the two alone.
						if len(X.state.effects) > 0 {networks: ["default", "airlock-wake"]}
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
							POKE_URL:      "http://ticker:9998"
							POKE_INTERVAL: "${POKE_INTERVAL:-60s}"
							POKE_CALLER:   "compose"
							SERVICE_JWT:   "${SERVICE_JWT:-\(_devServiceJwt)}"
						}
						restart: "on-failure"
					}
				}
			}
			// Only an app that declares an effect gets an airlock, as only one
			// that declares a schedule gets a ticker. The airlock reaches the
			// database and its daprd (#AirlockNetworks); the daprd offers the
			// bindings API alone (services/airlock/dapr.yaml), and its bindings
			// are the program's declarations, so the only traffic leaving for the
			// world is a call of a declared binding. Nothing pokes it: its
			// worker hears a guard's enqueue at the guard's commit
			// (services/airlock/airlock.ts), and the instance is up whenever
			// the cluster is.
			if len(X.state.effects) > 0 {
				airlock: bayt.healthcheck.tcp & X._image & {
					// The port opens once every handler is admitted and the worker
					// runs; it serves nothing.
					healthcheck: {
						port:           9997
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					srcs: globs: list.Concat([[X.meta.airlock], [for e in X._effects {e.handler}]])
					dockerfile: {
						from: (_from & {in: X.meta.images.airlock}).out
						workdir: "/app/airlock"
						// Delivered where the manifest names them: AIRLOCK_DIR's
						// effects.json, and effects/<name>.js beside it.
						copy: list.Concat([
							[{srcs: [X.meta.airlock], dst: "/airlock/effects.json"}],
							[for e in X._effects {srcs: [e.handler], dst: "/airlock/effects/\(e.name).js"}],
						])
						// Its own reach, besides the network's: the database, its
						// daprd and the health port. Reads are unscoped because Graphile's
						// config search stats every directory up to `/`. A handler
						// runs in a worker with no permissions at all (handler.ts).
						cmd: ["run", "--frozen", "--unstable-worker-options", "--allow-net=database:5432,airlock-mesh:3500,0.0.0.0:9997", "--allow-read", "--allow-env", "--allow-sys", "main.ts"]
					}
					compose: {
						depends_on: {X._schemaReady, "airlock-mesh": _healthy}
						environment: {
							// The owner, not `service`: the ledger is closed to every
							// other role, and Graphile's migrate check, run at every
							// start, alters its own schema after an upgrade.
							DATABASE_URL: databaseUrl
							MESH_URL:     "http://airlock-mesh:3500"
							AIRLOCK_DIR:  "/airlock"
							// A secret has no default: compose refuses to start without
							// it rather than hand a handler a guessable one.
							for k in X._secrets {
								(k): "${\(k):?\(k) is required: an effect declares it}"
							}
						}
						networks: ["airlock", "airlock-wake"]
						restart: "on-failure"
						develop: watch: list.Concat([
							[{action: "sync+restart", path: "../\(X.meta.airlock)", target: "/airlock/effects.json"}],
							[for e in X._effects {action: "sync+restart", path: "../\(e.handler)", target: "/airlock/effects/\(e.name).js"}],
						])
					}
				}
				// The airlock's daprd: one output binding per effect and nothing
				// else, no Redis component and no resiliency policy, so a call is
				// made once and the ledger's `entered` counts every attempt; and
				// the bindings API alone, so no invoke reaches a full URL.
				"airlock-mesh": bayt.healthcheck.tcp & X._image & {
					healthcheck: {
						port:           3500
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					srcs: globs: [for e in X._effects {e.endpoint}]
					dockerfile: {
						from: (_from & {in: X.meta.images.mesh}).out
						copy: list.Concat([
							[{from: (_from & {in: X.meta.images.airlock}).out, srcs: ["/app/airlock/dapr.yaml"], dst: "/dapr/config.yaml"}],
							[for e in X._effects {srcs: [e.endpoint], dst: "/dapr/airlock/\(e.name).yaml"}],
						])
						entrypoint: ["/daprd", "--app-id", "airlock", "--dapr-listen-addresses", "0.0.0.0", "--resources-path", "/dapr/airlock", "--config", "/dapr/config.yaml", "--dapr-http-port", "3500", "--log-level", "info"]
					}
					compose: {
						depends_on: {for b in X._reached {"bridge-\(b)": _started}}
						// What this daprd may reach, on the container where an operator
						// looks (daprd reads neither): the declared origins and bridges.
						environment: {
							AIRLOCK_ORIGINS: strings.Join(X._origins, " ")
							AIRLOCK_BRIDGES: strings.Join([for b in X._bridges {b.name}], " ")
						}
						networks: ["airlock", "airlock-out", "airlock-egress"]
						restart: "on-failure"
						develop: watch: [for e in X._effects {action: "sync+restart", path: "../\(e.endpoint)", target: "/dapr/airlock/\(e.name).yaml"}]
					}
				}
				// Each bridge: mecha's mail bridge, a sink the cluster hosts, its net
				// permission being its port and its one server, reached only by
				// the airlock's daprd on `airlock-out`.
				for b in X._bridges {
					"bridge-\(b.name)": bayt.healthcheck.tcp & X._image & {
						healthcheck: {
							port:           #BridgePort
							interval:       "5s"
							start_interval: "500ms"
							start_period:   "30s"
						}
						dockerfile: {
							from: (_from & {in: X.meta.images.airlock}).out
							workdir: "/app/airlock"
							// Its own variables, the ETHEREAL_* nodemailer reads on import
							// (unset here), the host name it greets the server with, and
							// nothing to read.
							cmd: ["run", "--frozen", "--allow-net=0.0.0.0:\(#BridgePort),\(b.server)", "--allow-env=\(strings.Join(_bridgeEnv, ","))", "--allow-sys=hostname", "mail.ts"]
						}
						compose: {
							environment: {
								MAIL_SMTP:              b.server
								MAIL_TLS:               b.tls
								MAIL_MESSAGE_ID_DOMAIN: b.domain
								if b.user != _|_ {
									MAIL_USER:     "${\(b.user):?\(b.user) is required: bridge \(b.name)'s user}"
									MAIL_PASSWORD: "${\(b.password):?\(b.password) is required: bridge \(b.name)'s password}"
								}
							}
							networks: ["airlock-out", "bridge-\(b.name)-egress"]
							restart: "on-failure"
						}
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
						if len(X.state.pipelines)+len(X.state.computations) > 0 {
							transform: _started
						}
						if len(X.state.computations) > 0 {
							compute: _healthy
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
						if X._wakes {
							clock: _started
						}
						if len(X.state.effects) > 0 {
							airlock: _healthy
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
			airlock:  #From
		}
		// The program's effects.json (services/airlock/README.md), relative to
		// the app dir.
		airlock: *"services/airlock/effects.json" | string
		// The proxy's config, relative to the app dir.
		caddyfile: *"docker/Caddyfile" | string
		// The one published door: the port the proxy listens on, the scheme
		// it serves, and the host variable that moves it. Unset, the host port
		// is `host` where people type it, else the project's own
		// (bayt's #port.publish); only what a person brings up binds it.
		door: {
			port:   *8443 | int
			scheme: *"https" | "http"
			env:    *"CADDY_TLS_HOST_PORT" | string
			host?:  int
		}
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
// here rather than at `up`. A target joins the networks its compose block
// names, under its bare name on each, and the default network only when it
// names none.
#Runtime: R={
	project: string
	cluster: #Cluster

	_live: {for n, t in R.cluster.surface.targets if t != null {(n): t}}
	// What a target waits on; a target that waits on nothing has no field.
	_waits: W={
		t: _
		out: [if W.t.compose.depends_on != _|_ {W.t.compose.depends_on}, {}][0]
	}
	_networks: N={
		t: _
		out: [if N.t.compose.networks != _|_ {N.t.compose.networks}, ["default"]][0]
	}
	targets: {
		for n, t in R._live {
			(n): {
				for f, v in t if f != "compose" && f != "deps" {(f): v}
				deps: [for k, _ in (R._waits & {"t": t}).out {":\(k):outs"}]
				compose: {
					for f, v in t.compose if f != "depends_on" && f != "networks" {(f): v}
					depends_on: {for k, v in (R._waits & {"t": t}).out {("\(R.project)-\(k)"): v}}
					networks: {for nw in (R._networks & {"t": t}).out {(nw): aliases: [n]}}
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
