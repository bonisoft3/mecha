#!/busybox sh
set -eu

if [ -n "${MESH_SUBSCRIPTIONS_DIR:-}" ]; then
  exec /daprd \
    --app-id mechaed \
    --dapr-listen-addresses 0.0.0.0 \
    --resources-path /dapr/components \
    --resources-path "$MESH_SUBSCRIPTIONS_DIR" \
    --app-channel-address "${MESH_APP_ADDRESS:-caddy}" \
    --app-port "${MESH_APP_PORT:-8080}" \
    --log-level info \
    --enable-api-logging
fi

exec /daprd \
  --app-id mechaed \
  --dapr-listen-addresses 0.0.0.0 \
  --resources-path /dapr/components \
  --app-channel-address "${MESH_APP_ADDRESS:-caddy}" \
  --app-port "${MESH_APP_PORT:-8080}" \
  --log-level info \
  --enable-api-logging
