#!/bin/sh
# Smoke test: CRUD write + read via PostgREST through Caddy proxy.
# Compose ensures caddy (and transitively crud) are healthy before this runs.
set -eu

CRUD_URL="${CRUD_URL:-http://crud:3000}"
PROXY_URL="${PROXY_URL:-http://caddy:8080}"

echo "=== Mecha v2 crud smoke test ==="

# Insert via direct CRUD
RESPONSE=$(curl -sf -X POST "$CRUD_URL/Hello" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"message": "smoke-test"}')
echo "$RESPONSE" | grep -q "smoke-test" || { echo "FAIL: insert"; exit 1; }
echo "  insert OK"

# Read via Caddy proxy
curl -sf "$PROXY_URL/crud/Hello" | grep -q "smoke-test" || { echo "FAIL: proxy read"; exit 1; }
echo "  proxy read OK"

# Insert second record
curl -sf -X POST "$CRUD_URL/Hello" \
  -H "Content-Type: application/json" \
  -d '{"message": "smoke-test-2"}' > /dev/null
echo "  second insert OK"

# Count records
COUNT=$(curl -sf "$CRUD_URL/Hello" | grep -c "smoke-test")
[ "$COUNT" -ge 2 ] || { echo "FAIL: expected ≥2, got $COUNT"; exit 1; }
echo "  $COUNT records found"

echo "=== validation seat ==="
# The floor is on over "Owned": anon carries no app.scopes, so current_scopes()
# is empty and the tenancy policy matches nothing. This is the reach the
# refusal below is measured against.
OWNED=$(curl -s "$CRUD_URL/Owned")
[ "$OWNED" = "[]" ] || { echo "FAIL: anon sees through the floor: $OWNED"; exit 1; }
echo "  anon reads no Owned row"
# -f would swallow the body and the status; the refusal IS the assertion.
guarded() {
  curl -s -o "$1" -w '%{http_code}' -X POST "$CRUD_URL/Guarded" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=representation" \
    -d "$2"
}
CODE=$(guarded /tmp/refused.json '{"owner":"alice","target":"t1"}')
[ "$CODE" = "400" ] || { echo "FAIL: own target refused with $CODE"; cat /tmp/refused.json; exit 1; }
grep -q '"message":"validation Guarded.own-target"' /tmp/refused.json \
  || { echo "FAIL: the refusal names the validation"; cat /tmp/refused.json; exit 1; }
echo "  a refusal is a 400 naming the validation"
echo "  ...judged on an Owned row the caller cannot read: the trigger is SECURITY DEFINER"
CODE=$(guarded /dev/null '{"owner":"bob","target":"t1"}')
[ "$CODE" = "201" ] || { echo "FAIL: another owner's target accepted, got $CODE"; exit 1; }
echo "  an accepted write is a 201"
# A predicate answering neither true nor false is the app's program error, not
# a refusal: a distinct ERRCODE, still a 4xx so the outbox rolls back instead of
# retrying a write no retry can fix.
CODE=$(guarded /tmp/unanswered.json '{"owner":"bob","target":"shrug"}')
[ "$CODE" = "400" ] || { echo "FAIL: an unanswered predicate got $CODE"; cat /tmp/unanswered.json; exit 1; }
grep -q '"message":"predicate Guarded.own-target answered undefined"' /tmp/unanswered.json \
  || { echo "FAIL: the program error names the predicate and its answer"; cat /tmp/unanswered.json; exit 1; }
echo "  an unanswered predicate is a 400 naming the predicate, not a refusal"

# The update seat: the trigger judges NEW, so a standing row is refused by what
# the write would make it, never by what it was.
CODE=$(guarded /tmp/standing.json '{"owner":"carol","target":"t1"}')
[ "$CODE" = "201" ] || { echo "FAIL: the standing row was not accepted, got $CODE"; cat /tmp/standing.json; exit 1; }
ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/standing.json)
[ -n "$ID" ] || { echo "FAIL: no id in the accepted row"; cat /tmp/standing.json; exit 1; }
patch() {
  curl -s -o "$1" -w '%{http_code}' -X PATCH "$CRUD_URL/Guarded?id=eq.$ID" \
    -H "Content-Type: application/json" \
    -d "$2"
}
CODE=$(patch /tmp/patched.json '{"target":"t2"}')
[ "$CODE" = "204" ] || { echo "FAIL: an accepted update got $CODE"; cat /tmp/patched.json; exit 1; }
echo "  an accepted update is a 204"
CODE=$(patch /tmp/refused-update.json '{"owner":"alice","target":"t1"}')
[ "$CODE" = "400" ] || { echo "FAIL: a refused update got $CODE"; cat /tmp/refused-update.json; exit 1; }
grep -q '"message":"validation Guarded.own-target"' /tmp/refused-update.json \
  || { echo "FAIL: the refused update names the validation"; cat /tmp/refused-update.json; exit 1; }
echo "  an update onto the caller's own target is a 400 naming the validation"

# PostgREST maps a plv8 exception (XX000) to 500, which the client outbox
# retries forever; the trigger's explicit ERRCODE above is what makes a
# refusal a 400. This pins that mapping.
CODE=$(guarded /dev/null '{"owner":"bob","target":"boom"}')
[ "$CODE" = "500" ] || { echo "FAIL: a bare plv8 throw is an internal error, got $CODE"; exit 1; }
echo "  a bare plv8 throw is a 500"

echo "=== passed ==="
