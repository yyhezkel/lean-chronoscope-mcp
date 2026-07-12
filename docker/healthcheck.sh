#!/bin/sh
# Health: daemon socket exists and is connectable.
SOCKET="${LEAN_CHRONOSCOPE_SOCKET:-${BROWSER_MCP_SOCKET:-/run/lean-chronoscope/daemon.sock}}"
test -S "$SOCKET" || exit 1
exit 0
