#!/bin/sh
# Start Arroyo, then create-or-update the hello_aggregation pipeline.
# Restart is unconditional so SQL changes in /queries/*.sql take effect.
set -eu

API="http://localhost:5115/api/v1"
NAME="hello_aggregation"
SQL_FILE="/queries/${NAME}.sql"

/app/arroyo cluster &
ARROYO_PID=$!
trap 'kill "$ARROYO_PID" 2>/dev/null || true' EXIT

echo "Waiting for Arroyo API..."
for _ in $(seq 1 60); do
  curl -sf "$API/ping" >/dev/null 2>&1 && break
  sleep 2
done || { echo "FATAL: Arroyo API not ready" >&2; exit 1; }

# Create (or 409 if already exists)
PAYLOAD=$(jq -n --rawfile q "$SQL_FILE" --arg n "$NAME" \
  '{name: $n, query: $q, parallelism: 1}')
STATUS=$(curl -s -o /tmp/resp.json -w '%{http_code}' -X POST \
  -H "Content-Type: application/json" -d "$PAYLOAD" "$API/pipelines")
echo "Pipeline create: HTTP $STATUS"
[ "$STATUS" = "200" ] || [ "$STATUS" = "409" ] || cat /tmp/resp.json >&2

ID=$(curl -s "$API/pipelines" | jq -r --arg n "$NAME" '.data[] | select(.name == $n) | .id')
[ -n "$ID" ] || { echo "FATAL: pipeline '$NAME' not found" >&2; exit 1; }

# Force-restart to pick up any SQL changes
curl -sf -X POST -H "Content-Type: application/json" -d '{"force":true}' \
  "$API/pipelines/$ID/restart" >/dev/null || true

echo "Waiting for pipeline '$NAME' to reach Running state..."
for _ in $(seq 1 30); do
  STATE=$(curl -s "$API/pipelines/$ID/jobs" | jq -r '.data[0].state // ""')
  if [ "$STATE" = "Running" ]; then
    echo "Pipeline '$NAME' is Running"
    wait "$ARROYO_PID"
  fi
  sleep 2
done

echo "WARNING: pipeline '$NAME' did not reach Running in time" >&2
wait "$ARROYO_PID"
