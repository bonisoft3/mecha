# Unicorn profile smoke tester — verifies rclone S3 + imgproxy.
FROM busybox:1.36.1-musl@sha256:2f9af5cf39068ec3a9e124feceaa11910c511e23a1670dcfdff0bc16793545fb

COPY --chmod=755 tests/unicorn-test/entrypoint.sh /entrypoint.sh
COPY --chmod=755 tests/unicorn-test/healthcheck.sh /healthcheck.sh

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]

HEALTHCHECK --interval=5s --timeout=5s --retries=12 --start-period=30s CMD ["/bin/sh", "/healthcheck.sh"]
