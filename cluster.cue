// The virtual cluster, published as CUE: mecha's canonical local topology as
// bayt targets, instantiated per app. Every service is an addressable field —
// consumers override by unification and drop by setting null; that is the
// escape hatch, and pinning or forking this package is the versioning story.
// Escape-hatch-free apps never see this file: pronto's emitter instantiates
// it; apps with hatches import it from their bayt.cue.
//
// Each target is bayt's vocabulary: the image is the Dockerfile bayt emits
// from `dockerfile`, the runtime is its `compose` block. Names are bare and
// so are `depends_on` keys; the builder that lowers the targets into a bayt
// project qualifies the keys and gives each service its bare name as a
// network alias (plugins/pronto/builders/bayt.cue), which is what keeps
// `crud:3000` and `@database:5432` resolving.
package cluster

import (
	"list"
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	apt "github.com/bonisoft3/bayt/distros/apt"
)

// A health wait states no `restart`: bayt adds `restart: true` to every one
// (plugins/bayt/core/gen_compose.cue), so a dependency recreated inside an
// `up` recreates what waits on it.
_healthy: {condition: "service_healthy"}
_started: {condition: "service_started"}

// A file delivered into the cluster (caddy static).
#Static: {
	file:   string // path relative to the app dir
	target: string // absolute path inside the serving container
	watch:  *false | bool
}

// Pre-signed against the dev PGRST_JWT_SECRET: HS256, claims
// {role: "service", sub: all-zeros uuid, exp: 2033-01-01}. Compose default
// only — prod overrides both SERVICE_JWT and PGRST_JWT_SECRET together.
_devServiceJwt: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZSIsInN1YiI6IjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6MTk4ODE1MDQwMH0.eeAs4VbzZYwz32jEudSFT_zMeuL18M4cEFY8Jn1jPwY"

_devJwtSecret: "pronto-dev-secret-please-override-32ch"
// The query parameter caddy adds after the gate and electric checks; one
// literal, so the two cannot be given different ones by a slip.
_devElectricSecret: "dev-electric-secret"

_deno:    "denoland/deno:alpine-2.3.7@sha256:bec860a253508d9813bb622be2359fd7bb3f72ff9a85ed6f8ccd46ab8522bcf6"
_connect: "redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c"

#Cluster: X={
	state: {
		migrations: [...string]
		pipelines: [...{name: string, file: string}]
		// Names only: the cluster needs to know whether any schedule exists,
		// never what it says. The seed migration carries the rest.
		schedules: [...string]
	}

	capabilities: {
		// The data plane. Off, nothing server-side is instantiated: no
		// database, no crud gateway, no sync, no bus, no pipeline worker —
		// caddy alone, serving the terminal. An app whose every entity is a
		// browser tier (`tab`, `device`) stores nothing here to keep, and the
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

		// The blob plane: rclone-s3 object store (S3 wire protocol, bucket
		// mecha-objects, no auth keys — dev posture) and imgproxy, behind the
		// caddy /blobs and /img routes.
		blobs: *false | bool
	}

	// mecha's own files reach a target's build through the `mecha` context:
	// a path from .bayt/, where the emitted compose resolves it, to
	// libraries/mecha. A target's `copy` names the context; this wires it.
	_mecha: build: additional_contexts: mecha: "../\(X.meta.mechaPath)"

	// No target runs a lifecycle command: the image is the recipe, the
	// process is the base image's own entrypoint, and no toolchain
	// activator wraps it — these images carry none.
	_image: {
		cmd: "builtin": null
		activate: ""
	}

	surface: {
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
					srcs: globs: ["services/database/migrations/*.sql"]
					dockerfile: {
						from: name: "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8"
						// wal2json for logical decoding; plv8 hosts a Jessie
						// validation inside the write's transaction. PGDG apt
						// carries no plv8: the artifact is Pigsty's, fetched by
						// exact name and checked against its published sha256
						// per architecture, inside the same RUN so the .deb and
						// the fetch tooling leave no layer behind.
						defaultPreamble: extensions: (apt.#install & {
							pkgs: ["postgresql-18-wal2json", "ca-certificates", "wget"]
							then: [
								"arch=$(dpkg --print-architecture)",
								"case \"$arch\" in amd64) sum=d46aa5f0e85db736f6a881cdfaab8400c57a4007291c441007f205fe796ebe92;; arm64) sum=e0517a453c1421e3bd3b6bbd28e8446e90a59e00cfe4b27607e5df17e93a2abd;; *) echo \"no plv8 artifact for $arch\" >&2; exit 1;; esac",
								"wget -qO /tmp/plv8.deb \"https://repo.pigsty.io/apt/pgsql/trixie/pool/main/p/plv8/postgresql-18-plv8_3.2.4-1PIGSTY~trixie_$arch.deb\"",
								"echo \"$sum  /tmp/plv8.deb\" | sha256sum -c -",
								"dpkg -i /tmp/plv8.deb",
								"rm /tmp/plv8.deb",
							]
							purge: ["wget", "ca-certificates"]
						}).out
						// The data directory lives on the container's writable
						// layer, which `--force-recreate` discards with it.
						preamble: ["ENV PGDATA=/postgresql-data"]
						// The tenancy floor ships with the image, whatever emitted
						// the tables above it: it sorts after mecha's 002 grants
						// and before the app's 005 that calls rls_protect. The
						// app's migrations follow; postgres runs the directory in
						// name order on a fresh data directory.
						copy: [
							{from: {name: "mecha"}, srcs: ["services/database/rls/rls.sql"], dst: "/docker-entrypoint-initdb.d/002a_rls.sql"},
							{srcs: X.state.migrations, dst: "/docker-entrypoint-initdb.d/"},
						]
						cmd: ["postgres", "-c", "wal_level=logical", "-c", "fsync=off", "-c", "synchronous_commit=off",
							"-c", "full_page_writes=off", "-c", "shared_buffers=32MB", "-c", "max_connections=200"]
					}
					compose: X._mecha & {
						ports: ["5432"]
						environment: {
							POSTGRES_USER:        "${POSTGRES_USER:-postgres}"
							POSTGRES_PASSWORD:    "${POSTGRES_PASSWORD:-postgres}"
							POSTGRES_DB:          "${POSTGRES_DB:-\(X.meta.app)}"
							POSTGRES_INITDB_ARGS: "--no-sync --no-locale --encoding=UTF8 --auth=trust"
						}
						develop: watch: [{action: "rebuild", path: "../services/database/migrations", target: "/docker-entrypoint-initdb.d"}]
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
						depends_on: database: _healthy
						environment: {
							PGRST_DB_URI:       "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
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
								PGRST_JWT_SECRET: "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
							}
						}
					}
				}
			}
			if X.capabilities.auth {
				"auth": X._image & {
					dockerfile: {
						from: name: _deno
						// deno runs `main.ts` from the working directory.
						workdir: "/app"
						copy: [{from: {name: "mecha"}, srcs: ["services/auth/deno.json", "services/auth/deno.lock", "services/auth/main.ts"], dst: "/app/"}]
						epilogue: ["RUN deno cache main.ts"]
						expose: [9999]
						cmd: ["run", "--allow-net", "--allow-env", "main.ts"]
					}
					compose: X._mecha & {
						depends_on: database: _healthy
						environment: {
							DATABASE_URL:     "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
							PGRST_JWT_SECRET: "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
							WEBAUTHN_RP_ID:   "${WEBAUTHN_RP_ID:-localhost}"
							WEBAUTHN_ORIGIN:  "https://localhost:${CADDY_TLS_HOST_PORT:-8443}"
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
				// Statics living above the app dir (the terminal's
				// interpreter) arrive through the `root` additional context,
				// a path from .bayt/ to the monorepo root, which is why their
				// COPY lines are rewritten relative to it. The fingerprint
				// covers only the app's own files: a srcs glob cannot leave
				// the project directory.
				srcs: globs: list.Concat([
					["docker/Caddyfile"],
					[for s in X.meta.statics if !strings.HasPrefix(s.file, "../../") {s.file}],
				])
				dockerfile: {
					from: name: "caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0"
					copy: list.Concat([
						[{srcs: ["docker/Caddyfile"], dst: "/etc/caddy/Caddyfile"}],
						[for s in X.meta.statics {
							if strings.HasPrefix(s.file, "../../") {
								from: {name: "root"}
								srcs: [strings.TrimPrefix(s.file, "../../")]
							}
							if !strings.HasPrefix(s.file, "../../") {
								srcs: [s.file]
							}
							dst: s.target
						}],
					])
				}
				compose: {
					build: additional_contexts: root: "../../.."
					// One published door, and it is h2 over TLS. The plain listener
					// still exists inside the container — the healthcheck above uses
					// it — but it is deliberately NOT published: the browser's
					// six-connections-per-origin cap only exists on HTTP/1.1, and a
					// second front door is a path that only ever runs on a laptop
					// (docs/2026-08-09-connection-ceiling.md).
					ports: [
						"${CADDY_TLS_HOST_PORT:-8443}:8443",
					]
					// The Caddyfile substitutes this into the electric route, which is
					// the only place the secret is added. Same default as the electric
					// service reads, and both are overridden together or neither.
					environment: ELECTRIC_SECRET: "${ELECTRIC_SECRET:-\(_devElectricSecret)}"

					// mkcert's pair, issued on the host by `just setup` and trusted
					// there once with `mkcert -install`. A DIRECTORY mount, not two
					// file mounts: an editor or a re-issue replaces a file's inode and
					// leaves a file-mount pointing at something deleted, which is the
					// same trap the baked statics avoid. The path is from .bayt/.
					volumes: ["../.certs:/certs:ro"]
					// Watch paths are from .bayt/ too, hence the ../ on each.
					develop: watch: list.Concat([
						[{action: "sync+restart", path: "../docker/Caddyfile", target: "/etc/caddy/Caddyfile"}],
						// Honoured, not assumed: a static that says it is not watched is
						// one whose edit is a rebuild — a generated file, or a vendored
						// unit whose megabytes would restart the proxy on every launch.
						[for s in X.meta.statics if s.watch {action: "sync+restart", path: "../\(s.file)", target: s.target}],
					])
				}
			}
			if X.capabilities.server {
				electric: X._image & {
					dockerfile: from: name: "electricsql/electric@sha256:f311edc272e227ddaea593c5205a02c3d1e5969c2db0f7655a039a5e24abb176"
					compose: {
						depends_on: database: _healthy
						environment: {
							// Its own role, holding BYPASSRLS as a stated attribute: 001_roles
							// (emit.cue `_bypass`) says what an unstated one costs.
							// The role's password is the migration's literal (001_roles), and the
							// database trusts every password here (initdb --auth=trust); a
							// deployment sets the role's password and this URL together,
							// outside this file.
							DATABASE_URL: "postgresql://electric:electric@database:5432/${POSTGRES_DB:-\(X.meta.app)}?sslmode=disable"
							// The proxy is the only way in: caddy runs forward_auth against the
							// gatekeeper and then adds this, so a request that reaches electric
							// without passing the gate has no secret to present.
							ELECTRIC_SECRET: "${ELECTRIC_SECRET:-\(_devElectricSecret)}"
							// Validate the publication 007 declares rather than build one; 007
							// says what building one would require of this role.
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
				redis: bayt.healthcheck.redis & X._image & {
					healthcheck: {
						interval:       "5s"
						retries:        6
						start_period:   "10s"
						start_interval: "500ms"
					}
					dockerfile: from: name: "redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933"
					compose: {}
				}
				"mesh-events": bayt.healthcheck.tcp & X._image & {
					healthcheck: {
						port:           3500
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					dockerfile: {
						from: name: "daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125"
						// The entrypoint's interpreter: daprd's image ships no shell.
						copy: [
							{from: {name: "busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb"}, srcs: ["/bin/busybox"], dst: "/busybox"},
							{from: {name: "mecha"}, srcs: ["services/mesh/dapr/components/httpendpoints.yaml", "services/mesh/dapr/components/resiliency.yaml", "services/mesh/dapr/components/redis-streams.yaml"], dst: "/dapr/components/"},
							{from: {name: "mecha"}, srcs: ["services/mesh/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"},
						]
						entrypoint: ["/entrypoint.sh"]
					}
					compose: X._mecha & {
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
					srcs: globs: ["docker/conduit-pipeline.yaml"]
					dockerfile: {
						from: name: "ghcr.io/conduitio/conduit:v0.14.0@sha256:dffc83f78caddac8fda0bf71b2b34212174e4a8cbe74ee5e1784a97a78b77e60"
						// conduit's standalone plugin registry searches <cwd>/connectors.
						workdir: "/app"
						preamble: [
							"ARG TARGETARCH",
							"RUN mkdir -p /app/connectors && ARCH=$(case \"${TARGETARCH}\" in arm64) echo \"arm64\" ;; *) echo \"x86_64\" ;; esac) && wget -qO- \"https://github.com/conduitio-labs/conduit-connector-http/releases/download/v0.4.0/conduit-connector-http_0.4.0_Linux_${ARCH}.tar.gz\" | tar -xzf - -C /app/connectors conduit-connector-http && chmod +x /app/connectors/conduit-connector-http && apk add --no-cache gettext",
						]
						// The template sits beside the pipelines directory, not in it,
						// so the rendered file is the only pipeline conduit finds and
						// every start of the container can render it again.
						copy: [{srcs: ["docker/conduit-pipeline.yaml"], dst: "/conduit/cdc-to-bus.yaml.tmpl"}]
						cmd: ["sh", "-c", "mkdir -p /conduit/pipelines && envsubst < /conduit/cdc-to-bus.yaml.tmpl > /conduit/pipelines/cdc-to-bus.yaml && exec /app/conduit run"]
					}
					compose: {
						depends_on: {database: _healthy, "mesh-events": _started}
						develop: watch: [{action: "sync+restart", path: "../docker/conduit-pipeline.yaml", target: "/conduit/cdc-to-bus.yaml.tmpl"}]
						environment: {
							DATABASE_URL:           "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
							CONDUIT_PIPELINES_PATH: "/conduit/pipelines"
							CONDUIT_DB_TYPE:        "inmemory"
						}
						restart: "on-failure"
					}
				}
			}
			if X.capabilities.blobs {
				"rclone-s3": X._image & {
					dockerfile: {
						from: name: "rclone/rclone:1.71.0@sha256:fd635aecd9667ee3c3bf920d14118090d4f2a83a080c1fa77e0bafbd4587ca87"
						preamble: [
							"USER root",
							"RUN mkdir -p /data && chown -R 1000:1000 /data",
						]
						copy: [{from: {name: "mecha"}, srcs: ["services/rclone-s3/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"}]
						entrypoint: ["/entrypoint.sh"]
						cmd: ["serve", "s3", "--addr=0.0.0.0:3900", "--vfs-cache-mode=off", "/data"]
						epilogue: ["USER 1000"]
					}
					compose: X._mecha & {
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
			if X.capabilities.server {
				transform: X._image & {
					srcs: globs: [for p in X.state.pipelines {p.file}]
					dockerfile: {
						from: name: _connect
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
						develop: watch: [for p in X.state.pipelines {
							action: "sync+restart"
							path:   "../\(p.file)"
							target: "/pipelines/\(p.name).yaml"
						}]
					}
				}
			}
			// Only an app that declares a schedule gets a clock. A ticker with
			// nothing to sweep is a container answering pokes nobody sends.
			if len(X.state.schedules) > 0 {
				ticker: X._image & {
					dockerfile: {
						from: name: _deno
						workdir: "/app"
						copy: [{from: {name: "mecha"}, srcs: ["services/ticker/deno.json", "services/ticker/deno.lock", "services/ticker/due.ts", "services/ticker/main.ts"], dst: "/app/"}]
						epilogue: ["RUN deno cache main.ts"]
						cmd: ["run", "--allow-net", "--allow-env", "main.ts"]
					}
					compose: X._mecha & {
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
					dockerfile: {
						from: name: _connect
						copy: [{from: {name: "mecha"}, srcs: ["services/clock/clock.yaml"], dst: "/clock.yaml"}]
						cmd: ["run", "/clock.yaml"]
					}
					compose: X._mecha & {
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
							database:      _healthy
							crud:          _healthy
							electric:      _healthy
							redis:         _healthy
							"mesh-events": _healthy
							conduit:       _healthy
							transform:     _started
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
		// label — caddy validate reads a file and so belongs at lint. The loop
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
			// secret placeholder has to hold something for the line to parse;
			// compose sets it at runtime, and this is not runtime.
			cmds: ["with-env {ELECTRIC_SECRET: lint} { mise exec -- caddy adapt --config docker/Caddyfile --adapter caddyfile out> (if $nu.os-info.name == \"windows\" { \"NUL\" } else { \"/dev/null\" }) }"]
			note: "checks the cluster's own proxy config parses"
		}
		// The door is h2, h2 needs TLS, and TLS needs a certificate the
		// developer's browser trusts — so the cluster asks for one at setup
		// rather than issuing an untrusted one at boot. Issuing is idempotent
		// and touches nothing outside the app dir; TRUSTING it is the one step
		// left to a human, because it writes to the system keychain — so setup
		// ends by printing that command instead of running it.
		//
		// Untrusted, the cert is still served and the battery still drives it
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
		// Path from the app dir to libraries/mecha, for the `mecha` build context.
		mechaPath: *"../../libraries/mecha" | string
		statics: [...#Static]
	}
}
