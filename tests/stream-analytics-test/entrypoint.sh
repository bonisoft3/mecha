#!/bin/sh
set -eu

# Insert 3 Hello records for Arroyo aggregation
for i in 1 2 3; do
  curl -X POST http://crud:3000/Hello \
    -H 'Content-Type: application/json' \
    -d "{\"message\": \"Hello from e2e test $i\"}" \
    -w "\nInserted stream analytics record $i\n"
done

exec /bin/busybox sleep infinity
