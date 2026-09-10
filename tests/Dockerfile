# Smoke test: CRUD write + proxy read.
FROM tarampampam/curl@sha256:617b3306349beaacb7ad82bddda8d6876a40c3bad06d7a28981504d230802d7e AS curl
FROM busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb

COPY --from=curl /bin/curl /bin/curl
COPY --chmod=755 tests/entrypoint.sh /entrypoint.sh
COPY --chmod=755 tests/entrypoint-events.sh /entrypoint-events.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
