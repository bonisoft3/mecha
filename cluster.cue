// The virtual cluster, published as CUE: mecha's canonical local topology in
// compose form, instantiated per app. Every service is an addressable field —
// consumers override by unification and drop by setting null; that is the
// escape hatch, and pinning or forking this package is the versioning story.
// Escape-hatch-free apps never see this file: pronto's emitter instantiates
// it; apps with hatches import it from their bayt.cue.
package cluster

import (
	"list"
	"strings"
)

// A file delivered into the cluster (caddy static, config payload).
#Static: {
	source: string // compose config name
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

	surface: {
		services: [string]: _
		services: {
			if X.capabilities.server {
				database: {
					build: {context: "\(X.meta.mechaPath)/services/database", dockerfile: "Dockerfile"}
					ports: ["5432"]
					environment: {
						POSTGRES_USER:        "${POSTGRES_USER:-postgres}"
						POSTGRES_PASSWORD:    "${POSTGRES_PASSWORD:-postgres}"
						POSTGRES_DB:          "${POSTGRES_DB:-\(X.meta.app)}"
						POSTGRES_INITDB_ARGS: "--no-sync --no-locale --encoding=UTF8 --auth=trust"
					}
					command: ["postgres", "-c", "wal_level=logical", "-c", "fsync=off", "-c", "synchronous_commit=off",
						"-c", "full_page_writes=off", "-c", "shared_buffers=32MB", "-c", "max_connections=200"]
					tmpfs: ["/postgresql-data"]
					healthcheck: {
						test: ["CMD", "pg_isready", "-h", "localhost", "-p", "5432", "-d", "${POSTGRES_DB:-\(X.meta.app)}", "-U", "${POSTGRES_USER:-postgres}"]
						start_interval: "100ms"
						start_period:   "5m"
					}
					configs: [for m in X.state.migrations {
						source: "migration-\(strings.SplitN(X._migBase[m], "_", 2)[0])"
						target: "/docker-entrypoint-initdb.d/\(X._migBase[m])"
					}]
					develop: watch: [{action: "rebuild", path: "services/database/migrations"}]
				}
				crud: {
					build: {context: X.meta.mechaPath, dockerfile: "services/crud/Dockerfile"}
					depends_on: database: condition: "service_healthy"
					healthcheck: {
						test: ["CMD", "httpcheck", "http://127.0.0.1:3001/ready"]
						interval:       "5s"
						start_interval: "500ms"
						start_period:   "30s"
					}
					environment: {
						PGRST_DB_URI:            "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
						PGRST_DB_SCHEMA:         "public"
						PGRST_DB_ANON_ROLE:      "anon"
						// Called once per request, in the request's transaction, after the
						// role switch: it sets app.scopes, which the tenancy floor reads.
						// Without it current_scopes() is empty and every floored table is
						// invisible -- the floor fails closed, so this is not optional.
						PGRST_DB_PRE_REQUEST:    "public.app_pre_request"
						PGRST_SERVER_HOST:       "*"
						PGRST_SERVER_PORT:       3000
						PGRST_ADMIN_SERVER_PORT: 3001
						if X.capabilities.auth {
							PGRST_JWT_SECRET: "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
						}
					}
				}
			}
			if X.capabilities.auth {
				"auth": {
					build: {context: "\(X.meta.mechaPath)/services/auth", dockerfile: "Dockerfile"}
					expose: ["9999"]
					depends_on: database: condition: "service_healthy"
					environment: {
						DATABASE_URL:     "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
						PGRST_JWT_SECRET: "${PGRST_JWT_SECRET:-\(_devJwtSecret)}"
						WEBAUTHN_RP_ID:   "${WEBAUTHN_RP_ID:-localhost}"
						WEBAUTHN_ORIGIN:  "https://localhost:${CADDY_TLS_HOST_PORT:-8443}"
					}
				}
			}
			caddy: {
				// The statics are baked in, not mounted. A compose `config` with a
				// `file:` is a bind mount, and an editor writing a file atomically
				// replaces its inode, leaving the mount pointing at something
				// deleted — every edit then 404s until the container is recreated.
				// `develop: watch` below updates them.
				//
				// The context stays the app's own directory so it is small;
				// statics living above it (the terminal's interpreter) arrive
				// through the `root` additional context, which is why their COPY
				// lines are rewritten relative to it.
				build: {
					context:    "."
					dockerfile: "docker/shell.Dockerfile"
					additional_contexts: root: "../.."
				}
				// One published door, and it is h2 over TLS. The plain listener
				// still exists inside the container — the healthcheck below uses
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
				// same trap the baked statics avoid.
				volumes: ["./.certs:/certs:ro"]
				healthcheck: {
					test: ["CMD", "/bin/httpcheck", "http://127.0.0.1:8080/health"]
					interval:       "5s"
					start_interval: "500ms"
					start_period:   "10s"
				}
				develop: watch: list.Concat([
					[{action: "sync+restart", path: "docker/Caddyfile", target: "/etc/caddy/Caddyfile"}],
					// Honoured, not assumed: a static that says it is not watched is
					// one whose edit is a rebuild — a generated file, or a vendored
					// unit whose megabytes would restart the proxy on every launch.
					[for s in X.meta.statics if s.watch {action: "sync+restart", path: s.file, target: s.target}],
				])
			}
			if X.capabilities.server {
				electric: {
					image: "electricsql/electric@sha256:f311edc272e227ddaea593c5205a02c3d1e5969c2db0f7655a039a5e24abb176"
					depends_on: database: condition: "service_healthy"
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
				redis: {
					image: "redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933"
					healthcheck: {
						test: ["CMD-SHELL", "redis-cli ping | grep PONG"]
						interval:     "5s", timeout:         "5s", retries: 6
						start_period: "10s", start_interval: "500ms"
					}
				}
				"mesh-events": {
					build: {context: X.meta.mechaPath, dockerfile: "services/mesh/Dockerfile", target: "events"}
					depends_on: {caddy: condition: "service_started", redis: condition: "service_started"}
					healthcheck: {
						test: ["CMD", "/bin/portcheck", "--port", "3500"]
						interval: "5s", start_interval: "500ms", start_period: "30s"
					}
					restart: "on-failure"
				}
				conduit: {
					build: {
						context: "./docker"
						dockerfile_inline: #"""
						FROM ghcr.io/conduitio/conduit:v0.14.0@sha256:dffc83f78caddac8fda0bf71b2b34212174e4a8cbe74ee5e1784a97a78b77e60
						ARG TARGETARCH
						RUN mkdir -p /app/connectors && \
						    ARCH=$$(case "$${TARGETARCH}" in arm64) echo "arm64" ;; *) echo "x86_64" ;; esac) && \
						    wget -qO- "https://github.com/conduitio-labs/conduit-connector-http/releases/download/v0.4.0/conduit-connector-http_0.4.0_Linux_$${ARCH}.tar.gz" \
						    | tar -xzf - -C /app/connectors conduit-connector-http && \
						    chmod +x /app/connectors/conduit-connector-http && \
						    apk add --no-cache gettext
						COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/httpcheck /bin/httpcheck
						COPY conduit-pipeline.yaml /conduit/pipelines/cdc-to-bus.yaml.tmpl
						CMD ["sh", "-c", "envsubst < /conduit/pipelines/cdc-to-bus.yaml.tmpl > /conduit/pipelines/cdc-to-bus.yaml && rm /conduit/pipelines/cdc-to-bus.yaml.tmpl && exec /app/conduit run"]

						"""#
					}
					depends_on: {database: condition: "service_healthy", "mesh-events": condition: "service_started"}
					develop: watch: [{action: "rebuild", path: "docker/conduit-pipeline.yaml"}]
					environment: {
						DATABASE_URL:           "postgres://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@database:5432/${POSTGRES_DB:-\(X.meta.app)}"
						CONDUIT_PIPELINES_PATH: "/conduit/pipelines"
						CONDUIT_DB_TYPE:        "inmemory"
					}
					healthcheck: {
						test: ["CMD", "httpcheck", "http://127.0.0.1:8080/healthz"]
						interval:     "5s", timeout:          "5s", retries: 20
						start_period: "120s", start_interval: "500ms"
					}
					restart: "on-failure"
				}
			}
			if X.capabilities.blobs {
				"rclone-s3": {
					build: {context: X.meta.mechaPath, dockerfile: "services/rclone-s3/Dockerfile"}
					environment: RCLONE_LOCAL_BUCKET: "mecha-objects"
					command: ["serve", "s3", "--addr=0.0.0.0:3900", "--vfs-cache-mode=off", "/data"]
					healthcheck: {
						test: ["CMD-SHELL", "wget -S -O /dev/null http://127.0.0.1:3900/ 2>&1 | grep -q 'HTTP/'"]
						interval:     "5s", timeout:         "5s", retries: 6
						start_period: "10s", start_interval: "500ms"
					}
				}
				imgproxy: {
					image: "ghcr.io/imgproxy/imgproxy:v3.31.1@sha256:2b7a56dbf9c8a8e12e7109a5bdd27d31a8c1aa49f2116c927c6aedc37e18db98"
					depends_on: "rclone-s3": condition: "service_started"
					environment: {
						IMGPROXY_USE_S3:      "true"
						IMGPROXY_S3_ENDPOINT: "http://rclone-s3:3900"
						// rclone serve s3 without auth keys accepts any credentials;
						// imgproxy's S3 client still insists on having a pair.
						AWS_ACCESS_KEY_ID:                  "${RCLONE_ACCESS_KEY:-GK000000000000000000000000}"
						AWS_SECRET_ACCESS_KEY:              "${RCLONE_SECRET_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
						AWS_REGION:                         "rclone"
						IMGPROXY_BIND:                      ":8081"
						IMGPROXY_MAX_SRC_RESOLUTION:        50
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
			if X.capabilities.server {
				transform: {
					build: {
						context: "."
						dockerfile_inline: #"""
						FROM redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c

						"""# + strings.Join([for p in X.state.pipelines {"COPY \(p.file) /pipelines/\(p.name).yaml"}], "\n") + "\n"
					}
					command: list.Concat([["streams", "--no-api"], [for p in X.state.pipelines {"/pipelines/\(p.name).yaml"}]])
					depends_on: {redis: condition: "service_healthy", crud: condition: "service_healthy"}
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
						path:   p.file
						target: "/pipelines/\(p.name).yaml"
					}]
				}
			}
			// Only an app that declares a schedule gets a clock. A ticker with
			// nothing to sweep is a container answering pokes nobody sends.
			if len(X.state.schedules) > 0 {
				ticker: {
					build: {context: "\(X.meta.mechaPath)/services/ticker", dockerfile: "Dockerfile"}
					depends_on: crud: condition: "service_healthy"
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
				// What pokes the ticker. services/clock/clock.yaml states the
				// pipeline and why the cadence is what it is.
				clock: {
					build: {context: X.meta.mechaPath, dockerfile: "services/clock/Dockerfile"}
					depends_on: ticker: condition: "service_started"
					environment: {
						POKE_INTERVAL: "${POKE_INTERVAL:-60s}"
						POKE_CALLER:   "compose"
						SERVICE_JWT:   "${SERVICE_JWT:-\(_devServiceJwt)}"
					}
					restart: "on-failure"
				}
			}
			launch: {
				image: "alpine/curl:latest"
				depends_on: {
					caddy: condition: "service_healthy"
					if X.capabilities.server {
						database: condition:      "service_healthy"
						crud: condition:          "service_healthy"
						electric: condition:      "service_healthy"
						redis: condition:         "service_healthy"
						"mesh-events": condition: "service_healthy"
						conduit: condition:       "service_healthy"
						transform: condition:     "service_started"
					}
					if X.capabilities.auth {
						auth: condition: "service_started"
					}
					if X.capabilities.blobs {
						"rclone-s3": condition: "service_healthy"
						imgproxy: condition:    "service_healthy"
					}
					// `launch` is what a consumer brings up, so a clock absent
					// from here is a clock nothing starts. It pulls the ticker
					// in behind it.
					if len(X.state.schedules) > 0 {
						clock: condition: "service_started"
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
				command: ["tail", "-f", "/dev/null"]
			}
		}
		// Checks the cluster asserts about its own surface. `verb` is the layer
		// the check needs, not a label: caddy validate reads a file and so
		// belongs at lint. The loop routes each into the matching rulemap.
		checks: [Name=string]: {verb: "setup" | "lint" | "test" | "integrate", cmds: [...string], note: string}
		checks: caddy: {
			verb: "lint"
			// `adapt`, not `validate`: validate also PROVISIONS, which loads the
			// TLS certificate — and the path in the config is the container's,
			// so a host-side lint would fail on every machine for a file that is
			// only ever mounted at runtime. adapt still fails on anything
			// malformed, which is what a lint is for. Output to /dev/null: in nu,
			// `| ignore` drops the exit code with it. The secret placeholder has
			// to hold something for the line to parse; compose sets it at
			// runtime, and this is not runtime.
			cmds: ["with-env {ELECTRIC_SECRET: lint} { mise exec -- caddy adapt --config docker/Caddyfile --adapter caddyfile out> /dev/null }"]
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
		checks: certs: {
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
	}

	meta: {
		app: string
		// Path from the app dir to libraries/mecha, for the build contexts.
		mechaPath: *"../../libraries/mecha" | string
		statics: [...#Static]
	}

	// The proxy image with this app's statics baked in. Emitted as
	// docker/shell.Dockerfile; see the caddy service for why these are COPYd
	// rather than mounted. Statics above the app dir are rewritten against the
	// `root` additional context.
	shellDockerfile: strings.Join(list.Concat([
		[
			"# generated by pronto from program.cue — do not edit",
			"FROM caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0",
			"COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/httpcheck /bin/httpcheck",
			"COPY docker/Caddyfile /etc/caddy/Caddyfile",
		],
		[for s in X.meta.statics {
			if strings.HasPrefix(s.file, "../../") {
				"COPY --from=root \(strings.TrimPrefix(s.file, "../../")) \(s.target)"
			}
			if !strings.HasPrefix(s.file, "../../") {
				"COPY \(s.file) \(s.target)"
			}
		}],
		[
			"HEALTHCHECK --interval=5s --timeout=5s --retries=6 --start-period=10s \\",
			"  CMD [\"httpcheck\", \"http://127.0.0.1:8080/health\"]",
			"",
		],
	]), "\n")

	_migBase: {for m in X.state.migrations {(m): strings.TrimPrefix(m, "services/database/migrations/")}}

	configs: [string]: _
	configs: {
		for m in X.state.migrations {
			"migration-\(strings.SplitN(X._migBase[m], "_", 2)[0])": file: m
		}
	}

	compose: {
		"services": {for n, s in X.surface.services if s != null {(n): s}}
		"configs": {for n, c in X.configs if c != null {(n): c}}
	}
}
