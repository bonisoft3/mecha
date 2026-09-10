# Dapr sidecar with bundled component definitions.
FROM busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb AS busybox

FROM daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125 AS base

COPY --from=busybox /bin/busybox /busybox
COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/portcheck /bin/portcheck

# Base components: httpendpoints + resiliency.
COPY services/mesh/dapr/components/httpendpoints.yaml /dapr/components/
COPY services/mesh/dapr/components/resiliency.yaml /dapr/components/
COPY --chmod=755 services/mesh/entrypoint.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]

HEALTHCHECK --interval=5s --timeout=5s --retries=6 --start-period=30s \
  CMD ["portcheck", "--port", "3500"]

# Events target: adds Redis Streams pubsub component.
FROM base AS events
COPY services/mesh/dapr/components/redis-streams.yaml /dapr/components/
