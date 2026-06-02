#!/bin/sh
set -e

# Daemon runs as PID 1 so SIGTERM is delivered cleanly.
exec node /app/dist/bin/daemon.js \
  --socket "${BROWSER_MCP_SOCKET}" \
  --data-dir "${BROWSER_MCP_DATA_DIR}"
