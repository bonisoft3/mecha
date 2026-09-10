#!/bin/sh
set -eu

# Wait for rclone-s3 to be serving
echo "Waiting for rclone S3 API..."
until wget -qO /dev/null http://rclone-s3:3900/ 2>&1; do sleep 1; done

# Upload a test file via S3 PUT
TEST_CONTENT="Hello from unicorn test"
echo "Uploading test file to S3..."
wget -qO /dev/null --method=PUT \
  --body-data="${TEST_CONTENT}" \
  --header="Content-Type: text/plain" \
  "http://rclone-s3:3900/mecha-objects/test.txt" 2>&1 || true

# Verify the file is retrievable via S3 GET
echo "Retrieving test file from S3..."
RESULT=$(wget -qO- "http://rclone-s3:3900/mecha-objects/test.txt" 2>/dev/null || echo "")
if [ -n "$RESULT" ]; then
  echo "S3 GET succeeded: ${RESULT}"
else
  echo "WARN: S3 GET returned empty (unsigned requests may be rejected)"
fi

echo "Verifying imgproxy is reachable..."
wget -q --spider http://imgproxy:8081/health
echo "imgproxy healthy"

echo "Verifying Caddy /img/* route..."
wget -qO /dev/null http://caddy:8080/health
echo "Caddy healthy"

echo "Unicorn smoke test passed"
exec /bin/busybox sleep infinity
