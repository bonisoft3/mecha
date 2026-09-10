#!/bin/sh
set -e

# Verify imgproxy is healthy (rclone-s3 backing store)
wget -q --spider http://imgproxy:8081/health
