#!/bin/sh
set -e

# Refresh the font cache so custom fonts mounted into /home/mcp/.fonts are
# visible to Chrome. Must run BEFORE Chrome launches — Chrome builds its font
# list at startup and won't pick up fonts added later without a relaunch.
fc-cache -f >/dev/null 2>&1 || true

# Daemon runs as PID 1 so SIGTERM is delivered cleanly.
exec node /app/dist/bin/daemon.js \
  --socket "${LEAN_CHRONOSCOPE_SOCKET:-$BROWSER_MCP_SOCKET}" \
  --data-dir "${LEAN_CHRONOSCOPE_DATA_DIR:-$BROWSER_MCP_DATA_DIR}"
