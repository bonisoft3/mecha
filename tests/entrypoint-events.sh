#!/bin/sh
# Smoke test: full CDC pipeline (insert → Conduit → Dapr → Redis Streams → rpk → PATCH).
# Compose ensures conduit is healthy before this runs.
set -eu

CRUD_URL="${CRUD_URL:-http://crud:3000}"

echo "=== Mecha v2 events pipeline smoke test ==="

START=$(date +%s)

curl -sf -X POST "$CRUD_URL/Hello" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"message": "cdc-test"}' > /dev/null
echo "  insert OK"

# Wait up to 30s for rpk to enrich the record
echo "  waiting for rpk enrichment..."
i=0
while [ $i -lt 30 ]; do
  if curl -sf "$CRUD_URL/Hello?source=eq.mecha-rpk" | grep -q "mecha-rpk"; then
    ELAPSED=$(($(date +%s) - START))
    echo "=== passed in ${ELAPSED}s ==="
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "FAIL: no enriched record after 30s"
exit 1
