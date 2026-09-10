#!/bin/sh
set -e

# Verify GroupHello has aggregated results containing e2e test messages
curl -sf "http://crud:3000/GroupHello?messages=like.*e2e*test*" | /bin/busybox grep -q ','
