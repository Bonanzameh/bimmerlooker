#!/bin/sh
set -eu

mkdir -p /app/data /app/reports

if [ ! -s /app/data/latest.json ] && [ -s /app/seed-data/data/latest.json ]; then
  cp /app/seed-data/data/latest.json /app/data/latest.json
fi

if [ ! -s /app/reports/latest.md ] && [ -s /app/seed-data/reports/latest.md ]; then
  cp /app/seed-data/reports/latest.md /app/reports/latest.md
fi

exec "$@"
