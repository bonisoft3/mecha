#!/busybox sh
set -eu

exec /daprd \
  --app-id mechaed \
  --dapr-listen-addresses 0.0.0.0 \
  --resources-path /dapr/components \
  --app-channel-address caddy \
  --app-port 8080 \
  --log-level info \
  --enable-api-logging
