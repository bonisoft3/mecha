# Arroyo stream-processing cluster with auto-bootstrap query loader.
FROM ghcr.io/arroyosystems/arroyo:latest@sha256:6562fa23703e2d6c420de887ddf7aae5245f0a934aa65949b9aa117e117a20df

RUN apt-get update -y && apt-get install -y curl jq netcat-openbsd && apt-get clean -y && rm -rf /var/lib/apt/lists/*

COPY --chmod=755 services/arroyo/arroyo-init.sh /init-scripts/arroyo-init.sh
COPY --chmod=755 services/arroyo/healthcheck.sh /usr/local/bin/arroyo-healthcheck.sh
COPY services/arroyo/queries /queries

ENTRYPOINT ["/bin/sh", "/init-scripts/arroyo-init.sh"]

HEALTHCHECK --interval=5s --timeout=5s --retries=6 --start-period=30s CMD ["/usr/local/bin/arroyo-healthcheck.sh"]
