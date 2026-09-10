#!/bin/sh
# Declarative Garage bootstrap via the garage CLI. No API parsing.
set -eu

BUCKET_NAME="${BUCKET_NAME:-mecha}"
ACCESS_KEY="${GARAGE_ACCESS_KEY:-GK00000000000000000000dev}"
SECRET_KEY="${GARAGE_SECRET_KEY:-0000000000000000000000000000000000000000000000000000000000000000}"
RPC_HOST="${GARAGE_RPC_HOST:-garage:3901}"

g() { garage --rpc-host "${RPC_HOST}" --rpc-secret "${GARAGE_RPC_SECRET}" "$@"; }

echo "Waiting for Garage RPC at ${RPC_HOST}..."
until g status >/dev/null 2>&1; do sleep 0.5; done

# Layout: assign the single node (id is the first hex token on the node line)
NODE_ID=$(g status | awk '/^[0-9a-f]{16}/ {print $1; exit}')
echo "Configuring single-node layout for ${NODE_ID}..."
g layout assign -z dc1 -c 1G "${NODE_ID}" 2>/dev/null || true
g layout apply --version 1 2>/dev/null || true

# Bucket (idempotent)
g bucket create "${BUCKET_NAME}" 2>/dev/null || echo "Bucket ${BUCKET_NAME} exists"

# Key: import with static credentials (idempotent — fails if already exists)
g key import --yes "${ACCESS_KEY}" "${SECRET_KEY}" -n mecha-key 2>/dev/null || echo "Key mecha-key exists"

# Grant read+write+owner on the bucket
g bucket allow --read --write --owner "${BUCKET_NAME}" --key "${ACCESS_KEY}"

echo "Garage initialized: bucket=${BUCKET_NAME} key=${ACCESS_KEY}"
