#!/bin/sh
# The claim contract: a conditional PATCH as mutual exclusion.
#
# DESIGN.md §14 (services/esocial-rpa) builds the engine's tenant lease, its
# operation claim and Chatwoot's outbound send on one mechanism — PATCH with a
# filter that pins the pre-state, where the loser must be able to tell it lost.
# Every sink in this tree either discards the response or accepts {200,204}, so
# nothing here has ever exercised the losing branch. This probes it directly:
# `processed_at` is the claim column, `source` the holder.
set -eu

CRUD_URL="${CRUD_URL:-http://crud:3000}"

echo "=== Mecha claim-contract probe ==="

# An id that fails to parse would build `id=eq.` — a filter matching nothing,
# which every arm below would read as a lost claim rather than a broken probe.
require_id() {
	[ -n "$1" ] || { echo "FAIL: could not parse an id from $2"; exit 1; }
}


ROW=$(curl -sf -X POST "$CRUD_URL/Hello" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"message": "claim-probe"}')
ID=$(echo "$ROW" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
require_id "$ID" "the claim insert"
echo "  row $ID"

# One claim: filter pins processed_at IS NULL, so a redelivery cannot re-match.
claim() {
	curl -s -o /tmp/body -w '%{http_code}' -X PATCH \
		"$CRUD_URL/Hello?id=eq.$ID&processed_at=is.null" \
		-H "Content-Type: application/json" \
		-H "Prefer: return=representation" \
		-d "{\"processed_at\": \"now()\", \"source\": \"$1\"}"
}

WIN_CODE=$(claim worker-a)
WIN_BODY=$(cat /tmp/body)
echo "  winner: HTTP $WIN_CODE  body=$WIN_BODY"
echo "$WIN_BODY" | grep -q 'worker-a' || { echo "FAIL: winner did not get the row back"; exit 1; }

LOSE_CODE=$(claim worker-b)
LOSE_BODY=$(cat /tmp/body)
echo "  loser:  HTTP $LOSE_CODE  body=$LOSE_BODY"

# The whole contract rests on this being distinguishable from a win.
[ "$LOSE_BODY" = "[]" ] || { echo "FAIL: loser body is not an empty array: $LOSE_BODY"; exit 1; }
echo "  loser is an empty array — a claim can detect that it lost"

# And the sink must not have been applied twice.
HOLDER=$(curl -sf "$CRUD_URL/Hello?id=eq.$ID&select=source" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')
[ "$HOLDER" = "worker-a" ] || { echo "FAIL: holder is '$HOLDER', expected worker-a"; exit 1; }
echo "  holder still worker-a — the second claim mutated nothing"

echo "=== status codes: winner=$WIN_CODE loser=$LOSE_CODE ==="

# Redelivery is sequential; a race is not. Two claimers on one fresh row must
# leave exactly one winner, or the lease in §14 is not exclusion at all.
ROW2=$(curl -sf -X POST "$CRUD_URL/Hello" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"message": "claim-race"}')
ID=$(echo "$ROW2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

race() {
	curl -s -X PATCH "$CRUD_URL/Hello?id=eq.$ID&processed_at=is.null" \
		-H "Content-Type: application/json" \
		-H "Prefer: return=representation" \
		-d "{\"processed_at\": \"now()\", \"source\": \"$1\"}" > "/tmp/race-$1"
}
race racer-a & race racer-b & wait

WINNERS=0
for r in racer-a racer-b; do
	grep -q "$r" "/tmp/race-$r" 2>/dev/null && WINNERS=$((WINNERS + 1))
done
echo "  race winners: $WINNERS"
[ "$WINNERS" = "1" ] || { echo "FAIL: $WINNERS claimers won one row"; exit 1; }
echo "  exactly one claimer won — the guard is atomic at row level"

# --- Lease reclaim -------------------------------------------------------
# §14's tenant lease is not the operation claim: a crashed holder has to be
# reclaimable, so the guard is "unheld OR expired" rather than "unheld". That
# is an or= filter inside a conditional PATCH, which nothing here has run.
# processed_at stands in for lease_expires_at, source for holder.
lease_row() {
	_body=$(curl -sf -X POST "$CRUD_URL/Hello" \
		-H "Content-Type: application/json" -H "Prefer: return=representation" \
		-d "{\"message\": \"lease\", \"source\": \"holder-a\", \"processed_at\": \"$1\"}")
	_id=$(echo "$_body" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
	require_id "$_id" "the lease insert"
	echo "$_id"
}
reclaim() {
	curl -s -X PATCH \
		"$CRUD_URL/Hello?id=eq.$1&or=(processed_at.is.null,processed_at.lt.$2)" \
		-H "Content-Type: application/json" -H "Prefer: return=representation" \
		-d '{"source": "holder-b"}'
}

PAST="2020-01-01T00:00:00Z"
FUTURE="2999-01-01T00:00:00Z"

EXPIRED=$(lease_row "$PAST")
OUT=$(reclaim "$EXPIRED" "$FUTURE")
echo "  expired lease -> $OUT"
echo "$OUT" | grep -q 'holder-b' || { echo "FAIL: an expired lease was not reclaimable"; exit 1; }
echo "  an expired lease is reclaimable"

HELD=$(lease_row "$FUTURE")
OUT=$(reclaim "$HELD" "$PAST")
echo "  live lease    -> $OUT"
[ "$OUT" = "[]" ] || { echo "FAIL: a live lease was stolen: $OUT"; exit 1; }
echo "  a live lease is not stealable — or= holds inside a conditional PATCH"

# --- The claim through the proxy -----------------------------------------
# caddy rewrites Prefer on the way in, which is how idempotent inserts work.
# The rewrite is scoped `@post method POST`, so a PATCH should keep the header
# it sent — and it must, because return=representation is the claim's only
# discriminator. A clobber here would not fail: every claim would read as won.
PROXY_URL="${PROXY_URL:-http://caddy:8080}"
PROXIED=$(curl -sf -X POST "$PROXY_URL/crud/Hello" \
  -H "Content-Type: application/json" \
  -d '{"message": "claim-via-proxy"}' |
  sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
require_id "$PROXIED" "the proxied insert"

OUT=$(curl -s -X PATCH "$PROXY_URL/crud/Hello?id=eq.$PROXIED&processed_at=is.null" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"processed_at": "now()", "source": "via-proxy"}')
echo "  proxied claim -> $OUT"
echo "$OUT" | grep -q 'via-proxy' || { echo "FAIL: return=representation did not survive caddy"; exit 1; }

LOST=$(curl -s -X PATCH "$PROXY_URL/crud/Hello?id=eq.$PROXIED&processed_at=is.null" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"processed_at": "now()", "source": "via-proxy-2"}')
[ "$LOST" = "[]" ] || { echo "FAIL: proxied loser is not empty: $LOST"; exit 1; }
echo "  a claim keeps its discriminator through caddy — the rewrite is POST-only"

echo "claim-contract probe OK"
