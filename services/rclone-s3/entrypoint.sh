#!/bin/sh
set -e
if [ -n "${RCLONE_LOCAL_BUCKET:-}" ]; then
  mkdir -p "/data/${RCLONE_LOCAL_BUCKET}"
fi
exec rclone "$@"
