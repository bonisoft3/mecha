// libraries/mecha/bayt.cue — mecha's bayt project: the images it builds,
// the packages workspace consumers pull as sources, and its own stack.
//
// Images: every service that carries mecha's own content is an `*-image`
// target here, public, so the cluster template (cluster.cue) starts each
// service FROM it and adds only what is the app's. bayt emits them as
// plain Dockerfiles under .bayt/, which is what a consumer without bayt
// builds with `docker build`.
//
// Sources: a workspace consumer whose lockfile links
// ../../libraries/mecha/packages/* pulls the package sources into its build
// context via `deps: ["libraries_mecha:setup:srcs"]`. The package build/test
// loop lives in mecha's own Taskfile.
//
// The stack: the cluster instantiated for mecha itself, FROM its own images,
// plus what the cluster does not cover — stream processing, the AI gateway
// placeholder, a debug shell, and the smoke suites the Taskfile runs. The
// stack is the worked example of consuming the images, and the smoke suites
// are the check on both.
//
package mecha

import (
	bayt "github.com/bonisoft3/bayt/core:bayt"
	apt "github.com/bonisoft3/bayt/distros/apt"
	mise "github.com/bonisoft3/bayt/stacks/mise"
	sayt "github.com/bonisoft3/bayt/stacks/sayt"
	cluster "github.com/bonisoft3/mecha:cluster"
)

_postgres: "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8"
// The one pgroll in the repository: every migration a cluster is given runs
// through it, and pgroll/pgroll_test.ts holds the grammar to its tag.
_pgroll: "ghcr.io/xataio/pgroll:v0.16.3@sha256:aca5425285691ed78079196c1629de039e7d7b795773b1ff63e1419d79dbd830"
_deno:    "denoland/deno:alpine-2.3.7@sha256:bec860a253508d9813bb622be2359fd7bb3f72ff9a85ed6f8ccd46ab8522bcf6"
_connect: "redpandadata/connect:4.46.0@sha256:f84ebd666931dc667b8b33c70900ff49a34c73d1811b096f668e360d66a05d4c"
// The compute service's Deno is the repository's (mise.toml), on glibc for
// DuckDB's native binding.
_denoCompute: "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
_busybox: "busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb"
_curl:    "tarampampam/curl@sha256:617b3306349beaacb7ad82bddda8d6876a40c3bad06d7a28981504d230802d7e"

// An image target: public, no lifecycle command, no toolchain activator —
// the process is the base image's own entrypoint, or the CMD stated here.
_image: {
	visibility: "public"
	cmd: "builtin": null
	activate: ""
}

// A stack target: runs on bare `up`, or by name when `manual`.
_run: {
	cmd: "builtin": null
	activate: ""
}

_stack: cluster.#Cluster & {
	meta: {
		app: "mecha"
		images: {
			database:   {ref: ":database-image"}
			migrate:    {ref: ":migrate-image"}
			mesh:       {ref: ":mesh-image"}
			conduit:    {ref: ":conduit-image"}
			auth:       {ref: ":auth-image"}
			ticker:     {ref: ":ticker-image"}
			clock:      {ref: ":clock-image"}
			compute:    {ref: ":compute-image"}
			"rclone-s3": {ref: ":rclone-s3-image"}
		}
		// A plain-HTTP door: mecha's proxy config serves no TLS, and the
		// smoke suites and the benchmark address localhost:8080.
		caddyfile:       "services/proxy/Caddyfile"
		door:            "8080:8080"
		conduitTemplate: "services/cdc/pipelines/cdc-to-dapr.yaml"
		statics: []
	}
	state: {
		// mecha's own schema, the identity table its auth plane keeps, then the
		// validation-seat fixtures the crud smoke asserts against.
		migrations: [
			"services/database/migrations/000_extensions.sql",
			"services/database/migrations/001_roles.sql",
			"services/database/migrations/002_grants.sql",
			"services/database/migrations/004_create_tables.sql",
			"services/database/migrations/005_electric_publication.sql",
			"services/database/migrations/006_conduit_publication.sql",
			"services/database/007_identity.sql",
			"tests/008_validation_smoke.sql",
		]
		// A change to a table the migrations above built, so every boot of the
		// stack runs the migrate target; services/migrate/migrate_test.ts
		// boots it against volumes of every age.
		pgroll: "01_hello_mood": operations: [{add_column: {table: "Hello", column: {name: "mood", type: "text", nullable: true}}}]
		pipelines: [{name: "passthrough", file: "services/transform/passthrough.yaml"}]
		// Any name: the cluster only asks whether a schedule exists, and the
		// ticker and clock are part of what this stack exercises.
		schedules: ["tick"]
	}
	capabilities: {auth: true, blobs: true}
}

// Where the project lives. One literal, rewritten by the mirror
// (copy.bara.sky): at the mirror's root the project is `.`, named `mecha`.
// bayt's scan reads this file alone, so the value cannot come from another
// file. Same-project refs below never depend on it.
_where: {dir: ".", name: "mecha"}

_mecha: bayt.#project & _where & {
	activate: "mise x --"

	targets: (cluster.#Runtime & {project: _mecha.name, "cluster": _stack}).targets
	targets: {
		// Public so workspace consumers COPY the package sources
		// (`libraries_mecha:setup:srcs`). Sources cover every workspace
		// member plus the root manifests an install resolves against.
		"setup": sayt.setup & mise.install & {
			// packages/** covers the workspace members plus packages/package.json
			// — mecha's workspace root lives under packages/, not at dir root.
			visibility: "public"
			srcs: globs: ["packages/**"]
			dockerfile: bayt.nubox
		}
		"doctor": sayt.doctor & mise.doctor

		// build = lint mecha's proto definitions. No emitted image (consumed as
		// source via setup:srcs); FROM :setup for the buf toolchain. CUE
		// type-checking lives in test, which regenerates gen/ (buf:generate dep)
		// that the tmpl embeds need.
		"build": sayt.build & mise.exec & {
			srcs: globs: ["proto/**"]
			cmd: "builtin": do: "buf lint proto"
			dockerfile: from: ref: ":setup"
		}

		// ---- The images -------------------------------------------------

		"database-image": _image & {
			srcs: globs: ["services/database/rls/rls.sql", "services/ticker/schedule.sql"]
			dockerfile: {
				from: name: _postgres
				// plv8 hosts a Jessie validation inside the write's transaction.
				// PGDG apt carries no plv8: the artifact is Pigsty's, fetched by
				// exact name and checked against its published sha256 per
				// architecture, inside the same RUN so the .deb and the fetch
				// tooling leave no layer behind.
				defaultPreamble: extensions: (apt.#install & {
					pkgs: ["ca-certificates", "wget"]
					then: [
						"arch=$(dpkg --print-architecture)",
						"case \"$arch\" in amd64) sum=969ca7bbf2341ea747f8ffa99226f0ae7ce2cd74353d12e9d13b09cc2362c47f;; arm64) sum=52bb956d95a3e51262250316cb3124e5cfd38aaeef60379cba615b0c5aedd05a;; *) echo \"no plv8 artifact for $arch\" >&2; exit 1;; esac",
						"wget -qO /tmp/plv8.deb \"https://repo.pigsty.io/apt/pgsql/trixie/pool/main/p/plv8/postgresql-18-plv8_3.2.5-1PGSTY~trixie_$arch.deb\"",
						"echo \"$sum  /tmp/plv8.deb\" | sha256sum -c -",
						"dpkg -i /tmp/plv8.deb",
						"rm /tmp/plv8.deb",
					]
					purge: ["wget", "ca-certificates"]
				}).out
				// The data directory lives on the container's writable layer.
				preamble: ["ENV PGDATA=/postgresql-data"]
				// The tenancy floor ships with the image, whatever emitted the
				// tables above it. The ticker's table is staged outside the
				// initdb directory, for a cluster that declares a schedule to
				// place.
				copy: [
					{srcs: ["services/database/rls/rls.sql"], dst: "\(cluster.#InitdbDir)/\(cluster.#TenancyMigration)"},
					{srcs: ["services/ticker/schedule.sql"], dst: "\(cluster.#StagedDir)/\(cluster.#ScheduleMigration)"},
				]
				cmd: ["postgres", "-c", "wal_level=logical", "-c", "fsync=off", "-c", "synchronous_commit=off",
					"-c", "full_page_writes=off", "-c", "shared_buffers=32MB", "-c", "max_connections=200"]
			}
		}
		// The migration runner: pgroll, and the psql its ledger checks and the
		// schema reload go through, on the database's own base.
		"migrate-image": _image & {
			srcs: globs: ["services/migrate/migrate.sh"]
			dockerfile: {
				from: name: _postgres
				copy: [
					{from: {name: _pgroll}, srcs: ["/usr/bin/pgroll"], dst: "/usr/local/bin/pgroll"},
					{srcs: ["services/migrate/migrate.sh"], dst: "/migrate.sh", chmod: "755"},
				]
				entrypoint: ["/migrate.sh"]
			}
		}
		"mesh-image": _image & {
			srcs: globs: ["services/mesh/dapr/components/*.yaml", "services/mesh/entrypoint.sh"]
			dockerfile: {
				from: name: "daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125"
				// The entrypoint's interpreter: daprd's image ships no shell.
				copy: [
					{from: {name: _busybox}, srcs: ["/bin/busybox"], dst: "/busybox"},
					{srcs: ["services/mesh/dapr/components/resiliency.yaml", "services/mesh/dapr/components/redis-streams.yaml"], dst: "/dapr/components/"},
					{srcs: ["services/mesh/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"},
				]
				entrypoint: ["/entrypoint.sh"]
			}
		}
		"conduit-image": _image & {
			dockerfile: {
				from: name: "ghcr.io/conduitio/conduit:v0.14.0@sha256:dffc83f78caddac8fda0bf71b2b34212174e4a8cbe74ee5e1784a97a78b77e60"
				// conduit's standalone plugin registry searches <cwd>/connectors.
				workdir: "/app"
				preamble: [
					"ARG TARGETARCH",
					"RUN mkdir -p /app/connectors && ARCH=$(case \"${TARGETARCH}\" in arm64) echo \"arm64\" ;; *) echo \"x86_64\" ;; esac) && wget -qO- \"https://github.com/conduitio-labs/conduit-connector-http/releases/download/v0.4.0/conduit-connector-http_0.4.0_Linux_${ARCH}.tar.gz\" | tar -xzf - -C /app/connectors conduit-connector-http && chmod +x /app/connectors/conduit-connector-http && apk add --no-cache gettext",
				]
			}
		}
		"auth-image": _image & {
			srcs: globs: ["services/auth/deno.json", "services/auth/deno.lock", "services/auth/jwt.ts", "services/auth/main.ts"]
			dockerfile: {
				from: name: _deno
				// deno runs `main.ts` from the working directory.
				workdir: "/app"
				copy: [{srcs: ["services/auth/deno.json", "services/auth/deno.lock", "services/auth/jwt.ts", "services/auth/main.ts"], dst: "/app/"}]
				epilogue: ["RUN deno cache main.ts"]
				expose: [9999]
				cmd: ["run", "--allow-net", "--allow-env", "main.ts"]
			}
		}
		"ticker-image": _image & {
			srcs: globs: ["services/ticker/deno.json", "services/ticker/deno.lock", "services/ticker/due.ts", "services/ticker/main.ts"]
			dockerfile: {
				from: name: _deno
				workdir: "/app"
				copy: [{srcs: ["services/ticker/deno.json", "services/ticker/deno.lock", "services/ticker/due.ts", "services/ticker/main.ts"], dst: "/app/"}]
				epilogue: ["RUN deno cache main.ts"]
				cmd: ["run", "--allow-net", "--allow-env", "main.ts"]
			}
		}
		// The extensions a computation's lake needs are installed at build: a
		// running service reaches no extension host. Workers take no
		// permissions of their own, an option Deno still calls unstable.
		"compute-image": _image & {
			let _files = ["deno.json", "deno.lock", "main.ts", "workers.ts", "cage.ts", "language.ts", "job.ts", "wasi.ts", "install.ts"]
			srcs: globs: [for f in _files {"services/compute/\(f)"}]
			dockerfile: {
				from: name: _denoCompute
				workdir: "/app"
				copy: [{srcs: [for f in _files {"services/compute/\(f)"}], dst: "/app/"}]
				epilogue: [
					"RUN deno cache main.ts cage.ts job.ts",
					"RUN deno run --allow-ffi --allow-read --allow-write --allow-net --allow-env install.ts",
				]
				cmd: ["run", "--unstable-worker-options", "--allow-ffi", "--allow-read", "--allow-write", "--allow-net", "--allow-env", "/app/main.ts"]
			}
		}
		"clock-image": _image & {
			srcs: globs: ["services/clock/clock.yaml"]
			dockerfile: {
				from: name: _connect
				copy: [{srcs: ["services/clock/clock.yaml"], dst: "/clock.yaml"}]
				cmd: ["run", "/clock.yaml"]
			}
		}
		"rclone-s3-image": _image & {
			srcs: globs: ["services/rclone-s3/entrypoint.sh"]
			dockerfile: {
				from: name: "rclone/rclone:1.71.0@sha256:fd635aecd9667ee3c3bf920d14118090d4f2a83a080c1fa77e0bafbd4587ca87"
				preamble: [
					"USER root",
					"RUN mkdir -p /data && chown -R 1000:1000 /data",
				]
				copy: [{srcs: ["services/rclone-s3/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"}]
				entrypoint: ["/entrypoint.sh"]
				cmd: ["serve", "s3", "--addr=0.0.0.0:3900", "--vfs-cache-mode=off", "/data"]
				epilogue: ["USER 1000"]
			}
		}

		// ---- The stack beyond the cluster ---------------------------------
		// Up with the cluster on a bare `up`: bayt has harnesses (manual,
		// reached by name) and the stack, and an optional plane is neither —
		// a wait on a manual target's service is a wait on nothing.

		// Stream processing: Redpanda and Arroyo, fed by a second rpk
		// pipeline teeing the CDC stream onto Kafka.
		"redpanda": _run & {
			dockerfile: from: name: "redpandadata/redpanda:v24.3.7@sha256:f3049dcb004ce1ccc0a8b3dc3c7d6ca1f32cb4d6d1da98a47874457dd8cb9907"
			compose: {
				// 512M: v24.3.7's allocator aborts on its first large
				// allocation at 100M, before a client connects.
				command: ["redpanda", "start", "--kafka-addr=internal://0.0.0.0:9092", "--advertise-kafka-addr=internal://redpanda:9092", "--mode=dev-container", "--smp=1", "--memory=512M", "--default-log-level=warn"]
				ports: ["9092"]
				networks: default: aliases: ["redpanda"]
				healthcheck: {
					// rpk's overview prints `Healthy: true`.
					test: ["CMD-SHELL", "rpk cluster health --api-urls=localhost:9644 | grep -q 'Healthy: *true'"]
					interval:     "5s", timeout:         "5s", retries: 6
					start_period: "15s", start_interval: "500ms"
				}
			}
		}
		"kafka-fanout": _run & {
			srcs: globs: ["services/transform/kafka-fanout.yaml"]
			dockerfile: {
				from: name: _connect
				copy: [{srcs: ["services/transform/kafka-fanout.yaml"], dst: "/pipelines/kafka-fanout.yaml"}]
				cmd: ["run", "/pipelines/kafka-fanout.yaml"]
			}
			compose: {
				depends_on: {
					"\(_mecha.name)-redis":    {condition: "service_healthy"}
					"\(_mecha.name)-redpanda": {condition: "service_healthy"}
				}
				restart: "on-failure"
				develop: watch: [{action: "sync+restart", path: "../services/transform/kafka-fanout.yaml", target: "/pipelines/kafka-fanout.yaml"}]
			}
		}
		"arroyo": _run & {
			srcs: globs: ["services/arroyo/arroyo-init.sh", "services/arroyo/healthcheck.sh", "services/arroyo/queries/*"]
			dockerfile: {
				from: name: "ghcr.io/arroyosystems/arroyo:0.15.0@sha256:6562fa23703e2d6c420de887ddf7aae5245f0a934aa65949b9aa117e117a20df"
				defaultPreamble: tools: (apt.#install & {pkgs: ["curl", "jq", "netcat-openbsd"]}).out
				copy: [
					{srcs: ["services/arroyo/arroyo-init.sh"], dst: "/init-scripts/arroyo-init.sh", chmod: "755"},
					{srcs: ["services/arroyo/healthcheck.sh"], dst: "/usr/local/bin/arroyo-healthcheck.sh", chmod: "755"},
					{srcs: ["services/arroyo/queries"], dst: "/queries"},
				]
				entrypoint: ["/bin/sh", "/init-scripts/arroyo-init.sh"]
				healthcheck: {
					test: ["CMD", "/usr/local/bin/arroyo-healthcheck.sh"]
					interval: "5s", timeout: "5s", retries: 6, start_period: "30s"
				}
			}
			compose: {
				depends_on: {
					"\(_mecha.name)-redpanda": {condition: "service_healthy"}
					"\(_mecha.name)-database": {condition: "service_started"}
					"\(_mecha.name)-redis":    {condition: "service_started"}
				}
				ports: ["5115"]
				networks: default: aliases: ["arroyo"]
				restart: "on-failure"
				develop: watch: [{action: "sync+restart", path: "../services/arroyo/queries/", target: "/queries/"}]
			}
		}
		// The AI gateway's seat (github.com/maximhq/bifrost), a placeholder
		// that holds the port.
		"bifrost": _run & {
			dockerfile: {
				from: name: bayt.lock.images.busybox
				cmd: ["sleep", "infinity"]
			}
			compose: {
				ports: ["8090:8090"]
			}
		}
		// A debug shell with the stack visible over the compose network,
		// reached by name: `docker compose run --rm -it nubox`.
		"nubox": _run & {
			dockerfile: bayt.nubox
			compose: {
				manual: true
				entrypoint: ["nu"]
				depends_on: "\(_mecha.name)-database": {condition: "service_healthy"}
			}
		}

		// ---- The smoke suites ---------------------------------------------
		// Each waits on the slice it exercises, so running one brings that
		// slice up. `smoke` and `smoke-cdc` exit with their verdict (`run`);
		// `smoke-stream` and `smoke-blobs` hold while their healthcheck
		// asserts (`up --wait`). The Taskfile spells both.

		_smokeImage: {
			dockerfile: {
				from: name: _busybox
				copy: [
					{from: {name: _curl}, srcs: ["/bin/curl"], dst: "/bin/curl"},
					{srcs: ["tests/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"},
					{srcs: ["tests/entrypoint-events.sh"], dst: "/entrypoint-events.sh", chmod: "755"},
				]
			}
			srcs: globs: ["tests/entrypoint.sh", "tests/entrypoint-events.sh"]
		}
		// CRUD write and proxy read, the validation seat and the tenancy floor,
		// then the sync path: a guest from auth, a shape through the gate.
		"smoke": _run & _smokeImage & {
			dockerfile: entrypoint: ["/bin/sh", "/entrypoint.sh"]
			compose: {
				manual: true
				depends_on: {
					"\(_mecha.name)-crud":     {condition: "service_healthy"}
					"\(_mecha.name)-caddy":    {condition: "service_healthy"}
					"\(_mecha.name)-auth":     {condition: "service_started"}
					"\(_mecha.name)-electric": {condition: "service_healthy"}
				}
			}
		}
		// The CDC pipeline end to end: insert, WAL, bus, rpk, PATCH back —
		// so it waits on every hop, transform included.
		"smoke-cdc": _run & _smokeImage & {
			dockerfile: entrypoint: ["/bin/sh", "/entrypoint-events.sh"]
			compose: {
				manual: true
				depends_on: {
					"\(_mecha.name)-conduit":   {condition: "service_healthy"}
					"\(_mecha.name)-redis":     {condition: "service_healthy"}
					"\(_mecha.name)-transform": {condition: "service_started"}
				}
				environment: CRUD_URL: "http://crud:3000"
			}
		}
		// Stream analytics: emits sample events, then holds while its
		// healthcheck asserts Arroyo aggregated them — `up --wait` returns on
		// that verdict. The events reach Arroyo through the CDC path and the
		// Kafka fan-out, so both are waited on.
		"smoke-stream": _run & {
			srcs: globs: ["tests/stream-analytics-test/entrypoint.sh", "tests/stream-analytics-test/healthcheck.sh"]
			dockerfile: {
				from: name: _curl
				copy: [
					{srcs: ["tests/stream-analytics-test/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"},
					{srcs: ["tests/stream-analytics-test/healthcheck.sh"], dst: "/healthcheck.sh", chmod: "755"},
					{from: {name: _busybox}, srcs: ["/bin/busybox"], dst: "/bin/busybox"},
				]
				entrypoint: ["/bin/busybox", "sh", "/entrypoint.sh"]
				healthcheck: {
					test: ["CMD", "/bin/busybox", "sh", "/healthcheck.sh"]
					interval: "5s", timeout: "5s", retries: 12, start_period: "30s"
				}
			}
			compose: {
				manual: true
				depends_on: {
					"\(_mecha.name)-arroyo":       {condition: "service_healthy"}
					"\(_mecha.name)-kafka-fanout": {condition: "service_started"}
					"\(_mecha.name)-conduit":      {condition: "service_healthy"}
					"\(_mecha.name)-transform":    {condition: "service_started"}
				}
			}
		}
		// The blob plane: an S3 PUT through rclone, an image through imgproxy;
		// holds while its healthcheck asserts both, like the stream suite.
		"smoke-blobs": _run & {
			srcs: globs: ["tests/unicorn-test/entrypoint.sh", "tests/unicorn-test/healthcheck.sh"]
			dockerfile: {
				from: name: _busybox
				copy: [
					{srcs: ["tests/unicorn-test/entrypoint.sh"], dst: "/entrypoint.sh", chmod: "755"},
					{srcs: ["tests/unicorn-test/healthcheck.sh"], dst: "/healthcheck.sh", chmod: "755"},
				]
				entrypoint: ["/bin/sh", "/entrypoint.sh"]
				healthcheck: {
					test: ["CMD", "/bin/sh", "/healthcheck.sh"]
					interval: "5s", timeout: "5s", retries: 12, start_period: "30s"
				}
			}
			compose: {
				manual: true
				depends_on: {
					"\(_mecha.name)-rclone-s3": {condition: "service_healthy"}
					"\(_mecha.name)-imgproxy":  {condition: "service_healthy"}
				}
			}
		}
	}
}

project: _mecha
