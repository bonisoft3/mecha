# Lightweight reverse proxy with Caddy.
FROM caddy:2.9-alpine@sha256:b4e3952384eb9524a887633ce65c752dd7c71314d2c2acf98cd5c715aaa534f0

COPY --from=tarampampam/microcheck:1@sha256:79c187c05bfa67518078bf4db117771942fa8fe107dc79a905861c75ddf28dfa /bin/httpcheck /bin/httpcheck

COPY services/proxy/Caddyfile /etc/caddy/Caddyfile

HEALTHCHECK --interval=5s --timeout=5s --retries=6 --start-period=10s \
  CMD ["httpcheck", "http://127.0.0.1:8080/health"]
