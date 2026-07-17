#!/bin/sh
set -eu

mkdir -p /app/data /app/reports

find /app/data -mindepth 1 -maxdepth 1 -exec rm -rf {} +
find /app/reports -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [ -s /app/seed-data/data/latest.json ]; then
  cp -f /app/seed-data/data/latest.json /app/data/latest.json
fi

if [ -s /app/seed-data/data/postal-coordinates.json ]; then
  cp -f /app/seed-data/data/postal-coordinates.json /app/data/postal-coordinates.json
fi

if [ -s /app/seed-data/data/search-cache.json ]; then
  cp -f /app/seed-data/data/search-cache.json /app/data/search-cache.json
fi

if [ -s /app/seed-data/reports/latest.md ]; then
  cp -f /app/seed-data/reports/latest.md /app/reports/latest.md
fi

exec "$@"
