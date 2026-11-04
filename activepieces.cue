package cluster

import bayt "github.com/bonisoft3/bayt/core:bayt"

#ActivepiecesContainer: A={
	image:  #From
	source: string
	secrets: *[] | [...=~#SecretName]
	target: bayt.healthcheck.tcp & {
		cmd: builtin: null
		activate: ""
		srcs: globs: ["\(A.source)/**"]
		healthcheck: {port: 8080, interval: "5s", start_interval: "500ms", start_period: "30s"}
		dockerfile: {
			from: (_from & {in: A.image}).out
			workdir: "/app"
			copy: [{srcs: ["\(A.source)/"], dst: "/app/"}]
			epilogue: ["RUN deno cache --frozen --config /app/deno.json /app/registry.ts"]
		}
		compose: {
			environment: {
				ACTIVEPIECES_MANIFEST: "/app/manifest.json"
				ACTIVEPIECES_REGISTRY: "/app/registry.ts"
				PORT:                  "8080"
				for secret in A.secrets {(secret): "${\(secret):?\(secret) is required by the integration hatch}"}
			}
			restart: "on-failure"
		}
	}
}
