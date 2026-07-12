#!/bin/sh
set -e

# Daemon runs as PID 1 so SIGTERM is delivered cleanly.
exec node /app/dist/bin/daemon.js \
  --socket "${LEAN_CHRONOSCOPE_SOCKET:-$BROWSER_MCP_SOCKET}" \
  --data-dir "${LEAN_CHRONOSCOPE_DATA_DIR:-$BROWSER_MCP_DATA_DIR}"
