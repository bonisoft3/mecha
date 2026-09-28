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

echo "=== sync path ==="
# A string field of a one-line JSON object; the values read here hold no quote.
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# `started` is all compose knows of the auth service: it answers once its
# migration has run against app_user, so the guest door is polled.
guest() {
  for _ in $(seq 1 60); do
    curl -sf -X POST "$PROXY_URL/auth/guest" && return 0
    sleep 1
  done
  return 1
}
OTHER=$(guest) || { echo "FAIL: the auth service never issued a guest"; exit 1; }
GUEST=$(guest) || { echo "FAIL: the auth service issued one guest and not two"; exit 1; }
TOKEN=$(echo "$GUEST" | field token)
SUBJECT=$(echo "$GUEST" | field id)
OTHER_ID=$(echo "$OTHER" | field id)
[ -n "$TOKEN" ] && [ -n "$SUBJECT" ] || { echo "FAIL: a guest without a token: $GUEST"; exit 1; }
echo "  auth issues guests"

SHAPE=$(curl -sf -X POST "$PROXY_URL/auth/shape" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"table":"app_user"}') || { echo "FAIL: no shape token for app_user"; exit 1; }
SHAPE_TOKEN=$(echo "$SHAPE" | field token)
WHERE=$(echo "$SHAPE" | field where)
echo "  the gate authorizes a shape over the guest's scopes"

# -f would swallow the status; the gate's answer IS the assertion.
shape() {
  curl -s -o /tmp/shape.json -w '%{http_code}' -G "$PROXY_URL/electric/v1/shape" \
    --data-urlencode "table=app_user" --data-urlencode "where=$WHERE" \
    --data-urlencode "offset=-1" "$@"
}
CODE=$(shape)
[ "$CODE" = "401" ] || { echo "FAIL: a shape without a token got $CODE"; cat /tmp/shape.json; exit 1; }
echo "  a shape without a token is refused at the gate"

# electric's health is up before its first shape can be served.
for _ in $(seq 1 30); do
  CODE=$(shape -H "Authorization: Bearer $SHAPE_TOKEN")
  [ "$CODE" = "200" ] && break
  sleep 1
done
[ "$CODE" = "200" ] || { echo "FAIL: electric answered the shape with $CODE"; cat /tmp/shape.json; exit 1; }
ROWS=$(grep -o '"operation":"insert"' /tmp/shape.json | wc -l | tr -d ' ')
[ "$ROWS" = "1" ] && grep -q "$SUBJECT" /tmp/shape.json && ! grep -q "$OTHER_ID" /tmp/shape.json \
  || { echo "FAIL: the guest's shape is not its own row alone"; cat /tmp/shape.json; exit 1; }
echo "  electric serves the guest its own row, and not another guest's"

echo "=== passed ==="
