package cluster

import bayt "github.com/bonisoft3/bayt/core:bayt"

#ActivepiecesContainer: A={
	image:  #From
	source: string
	secrets: *[] | [...=~#SecretName]
	target: bayt.healthcheck.tcp & {
		cmd: builtin: null
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http: {port: 8080, env: "PORT"}
		entrypoint: {
			shell:      "nu"
			do:         "let app = (if ('services/activepieces/main.ts' | path exists) { 'services/activepieces' } else { ((^mise where github:bonisoft3/mecha | str trim) | path join 'services/activepieces') }); ^deno cache --frozen --config '\(A.source)/deno.json' '\(A.source)/registry.ts'; with-env { ACTIVEPIECES_MANIFEST: ($env.PWD | path join '\(A.source)/manifest.json' | str replace -a (char -u 5c) '/'), ACTIVEPIECES_REGISTRY: ($env.PWD | path join '\(A.source)/registry.ts' | str replace -a (char -u 5c) '/') } { exec deno run --frozen --config ($app | path join 'deno.json') --allow-env --allow-read --allow-net --allow-run ($app | path join 'main.ts') }"
			dockerfile: null
			env: {
				for secret in A.secrets {(secret): "${\(secret):?\(secret) is required by the integration hatch}"}
			}
		}
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
