# Conduit CDC service: PostgreSQL WAL to HTTP delivery.
# Downloads the standalone HTTP connector binary from GitHub releases.
FROM ghcr.io/conduitio/conduit:v0.14.0@sha256:dffc83f78caddac8fda0bf71b2b34212174e4a8cbe74ee5e1784a97a78b77e60

ARG TARGETARCH
RUN mkdir -p /app/connectors && \
    ARCH=$(case "${TARGETARCH}" in arm64) echo "arm64" ;; *) echo "x86_64" ;; esac) && \
    wget -qO- "https://github.com/conduitio-labs/conduit-connector-http/releases/download/v0.4.0/conduit-connector-http_0.4.0_Linux_${ARCH}.tar.gz" \
    | tar -xzf - -C /app/connectors conduit-connector-http && \
    chmod +x /app/connectors/conduit-connector-http

COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/httpcheck /bin/httpcheck

COPY services/cdc/pipelines /conduit/pipelines

HEALTHCHECK --interval=5s --timeout=5s --retries=6 --start-period=30s \
  CMD ["httpcheck", "http://127.0.0.1:8080/healthz"]
