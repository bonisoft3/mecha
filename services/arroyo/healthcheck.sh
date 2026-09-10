#!/bin/sh
set -e

# Event-driven dependency checks - blocks until dependencies are ready
nc -w 5 -z database 5432
nc -w 5 -z redis 6379
nc -w 5 -z redpanda 9092

# Event-driven port check - blocks until Arroyo port is open
nc -w 5 -z localhost 5115

# Application readiness - quick API check (Docker HEALTHCHECK handles retries)
curl -sf http://localhost:5115/api/v1/ping >/dev/null