#!/bin/sh
# Health: daemon socket exists and is connectable.
SOCKET="${BROWSER_MCP_SOCKET:-/run/browser-mcp/daemon.sock}"
test -S "$SOCKET" || exit 1
exit 0
