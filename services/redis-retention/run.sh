#!/bin/sh
set -eu

: "${REDIS_URL:?REDIS_URL is required}"
: "${STREAM:?STREAM is required}"
: "${EXPECTED_GROUPS:?EXPECTED_GROUPS is required}"
: "${BOOTSTRAP_GROUPS?BOOTSTRAP_GROUPS must be set}"
MODE=${MODE:-apply}
INTERVAL_SECONDS=${INTERVAL_SECONDS:-5}
TRIM_LIMIT=${TRIM_LIMIT:-10000}
if [ -n "${HEALTH_FILE:-}" ]; then
  rm -f "$HEALTH_FILE"
  trap 'rm -f "$HEALTH_FILE"' EXIT
fi
case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*|0) echo 'invalid INTERVAL_SECONDS' >&2; exit 1 ;;
esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
redis-cli -e -u "$REDIS_URL" --raw --eval "$script_dir/init.lua" "$STREAM" , "$EXPECTED_GROUPS" "$BOOTSTRAP_GROUPS"
while :; do
  if result=$(redis-cli -e -u "$REDIS_URL" --raw --eval "$script_dir/retain.lua" "$STREAM" , "$EXPECTED_GROUPS" "$TRIM_LIMIT" "$MODE"); then
    printf '%s\n' "$result"
  else
    printf '%s\n' "$result" >&2
    exit 1
  fi
  if [ -n "${HEALTH_FILE:-}" ]; then date +%s > "$HEALTH_FILE"; fi
  delay=$INTERVAL_SECONDS
  case "$result" in
    *'"trimmed":0'*) ;;
    *'"trimmed":'*) delay=0.1 ;;
  esac
  sleep "$delay"
done
