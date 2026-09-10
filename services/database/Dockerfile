# Database image with versioned SQL migrations.
#
# Atlas is dev-only (see task atlas:diff). At runtime we just drop the .sql
# migration files into /docker-entrypoint-initdb.d/ — PostgreSQL's entrypoint
# runs them in alphabetical order on fresh data directories.
#
# Healthcheck is provided by compose.yml (with start_interval for fast startup).

# plv8 hosts a Jessie validation inside the write's transaction. PGDG apt
# carries no plv8; the artifact is Pigsty's, fetched by exact name and checked
# against its published sha256 per architecture. It lands in a stage of its
# own so the final image mounts it for the install and never carries the
# ~6 MB .deb in a layer.
FROM scratch AS plv8
ARG TARGETARCH
ADD https://repo.pigsty.io/apt/pgsql/trixie/pool/main/p/plv8/postgresql-18-plv8_3.2.4-1PIGSTY~trixie_${TARGETARCH}.deb /plv8.deb

FROM postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8

# Install wal2json extension for logical decoding output
RUN apt-get update -y && apt-get install -y postgresql-18-wal2json && apt-get clean -y && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN --mount=type=bind,from=plv8,source=/plv8.deb,target=/tmp/plv8.deb \
    case "$TARGETARCH" in \
      amd64) sum=d46aa5f0e85db736f6a881cdfaab8400c57a4007291c441007f205fe796ebe92 ;; \
      arm64) sum=e0517a453c1421e3bd3b6bbd28e8446e90a59e00cfe4b27607e5df17e93a2abd ;; \
      *) echo "no plv8 artifact for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && echo "$sum  /tmp/plv8.deb" | sha256sum -c - \
 && dpkg -i /tmp/plv8.deb

# Ephemeral data directory (mounted as tmpfs in compose)
ENV PGDATA=/postgresql-data

# Copy migration SQL files — PostgreSQL runs them in alphabetical order on initdb
COPY migrations/000_extensions.sql     /docker-entrypoint-initdb.d/000_extensions.sql
COPY migrations/001_roles.sql          /docker-entrypoint-initdb.d/001_roles.sql
COPY migrations/002_grants.sql         /docker-entrypoint-initdb.d/002_grants.sql
# The floor ships with the image, not with a generator, so it is present in
# every mecha database whatever emitted the tables above it. Sorts after 002 and
# before the app-emitted 005 that calls rls_protect.
COPY rls/rls.sql                       /docker-entrypoint-initdb.d/002a_rls.sql
COPY migrations/003_publication.sql    /docker-entrypoint-initdb.d/003_publication.sql
COPY migrations/004_create_tables.sql  /docker-entrypoint-initdb.d/004_create_tables.sql

CMD ["postgres", \
     "-c", "wal_level=logical", \
     "-c", "fsync=off", \
     "-c", "synchronous_commit=off", \
     "-c", "full_page_writes=off", \
     "-c", "shared_buffers=32MB", \
     "-c", "max_connections=20"]
