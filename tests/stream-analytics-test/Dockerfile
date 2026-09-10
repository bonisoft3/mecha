# End-to-end stream analytics tester, emits sample events then idles.
FROM busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb AS busybox

FROM tarampampam/curl@sha256:617b3306349beaacb7ad82bddda8d6876a40c3bad06d7a28981504d230802d7e

COPY --chmod=755 tests/stream-analytics-test/entrypoint.sh /entrypoint.sh
COPY --chmod=755 tests/stream-analytics-test/healthcheck.sh /healthcheck.sh

COPY --from=busybox /bin/busybox /bin/busybox

ENTRYPOINT ["/bin/busybox", "sh", "/entrypoint.sh"]

HEALTHCHECK --interval=5s --timeout=5s --retries=12 --start-period=30s CMD ["/bin/busybox", "sh", "/healthcheck.sh"]
