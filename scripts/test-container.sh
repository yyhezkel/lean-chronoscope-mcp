#!/usr/bin/env bash
# Build the current tree into a throwaway container for e2e tests, without
# touching the production lean-chronoscope-mcp. Usage:
#   scripts/test-container.sh [extra docker run -e flags...]
# Then: LC_CONTAINER=lc-test node scripts/test-all-tools.mjs
set -euo pipefail
NAME="${LC_CONTAINER:-lc-test}"
PORT="${LC_TEST_PORT:-18799}"
cd "$(dirname "$0")/.."
docker build -q -f docker/Dockerfile -t "$NAME" . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --init --shm-size 1g -p "127.0.0.1:${PORT}:8780" \
  -e CHROME_BIN=/usr/bin/google-chrome -e LEAN_CHRONOSCOPE_HTTP_TOKEN=test-token \
  -e LEAN_CHRONOSCOPE_HTTP_HOST=0.0.0.0 "$@" "$NAME" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$NAME" test -S /run/lean-chronoscope/daemon.sock 2>/dev/null && { echo "$NAME up on :$PORT"; exit 0; }
  sleep 1
done
echo "$NAME failed to start" >&2; docker logs "$NAME" | tail -20 >&2; exit 1
