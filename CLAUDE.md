# CLAUDE.md

Project guide for Claude Code when working in this repository.

## Overview

Token-efficient browser MCP server: a long-running headless Chrome in Docker, shared by multiple MCP clients on the same host. TypeScript + Node 22 + puppeteer-core + `@modelcontextprotocol/sdk` + better-sqlite3.

Architecture: split between a **daemon** (owns Chrome + SQLite) and a per-Claude-session **mcp-server** (stdio), talking over a Unix socket with NDJSON JSON-RPC. Capture-everything firehose into per-session SQLite at `/var/lib/lean-chronoscope/sessions/<id>/db.sqlite`; tools are queries on top.

Full implementation plan: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md). Current version and release log: `CHANGELOG.md`, `PROGRESS.md`. Security/trust model: [`docs/SECURITY.md`](docs/SECURITY.md).

## Run / dev

```bash
pnpm install
pnpm typecheck
pnpm build
cd docker && docker compose up -d --build       # rebuild + (re)start
docker exec lean-chronoscope-mcp ls /run/lean-chronoscope/daemon.sock   # should exist
```

Daemon listens on `/run/lean-chronoscope/daemon.sock` inside the container. MCP servers are spawned per Claude session via `docker exec -i lean-chronoscope-mcp node /app/dist/bin/mcp.js --session <id>`.

## MCP client integration

**Use the HTTP transport, not stdio.** This Claude Code runtime only mounts
HTTP MCP servers into the agent session; stdio servers (`docker exec -i … node`)
show "✓ Connected" under `claude mcp list` (the CLI health-checks them by
spawning locally) but their tools never load into the running session. Every
HTTP server here loads; the lone stdio one didn't — that's the tell.

So lean-chronoscope runs its built-in **HTTP+SSE bridge** (`src/mcp/http-bridge.ts`,
M4.5), published to host loopback and registered over HTTP:

```bash
# docker-compose publishes 127.0.0.1:8780 and sets LEAN_CHRONOSCOPE_HTTP_TOKEN.
claude mcp add lean-chronoscope -s user --transport http http://127.0.0.1:8780/mcp \
  --header "Authorization: Bearer <LEAN_CHRONOSCOPE_HTTP_TOKEN>"
claude mcp list      # lean-chronoscope: http://127.0.0.1:8780/mcp (HTTP) - ✓ Connected
curl -s http://127.0.0.1:8780/health   # {"ok":true,...} (no auth)
```

Bridge internals (per-connection daemon sockets, idle sweep, 404 on stale session, `x-lc-session` reconnect, hardening/rate limits): [`docs/HTTP_BRIDGE.md`](docs/HTTP_BRIDGE.md).

Session ids from untrusted callers (this header, and `session_attach`'s
`sessionId`) are validated by `assertSafeSessionId()` in the daemon's `ensure`,
which rejects ids containing `/`, `\`, `..`, NUL, or that are empty / >200 chars —
an id becomes a filesystem path, so this prevents traversal out of the sessions dir.

The bearer token lives in `docker/.env` (`LEAN_CHRONOSCOPE_HTTP_TOKEN`, read by
`docker/docker-compose.yml`; legacy `BROWSER_MCP_HTTP_TOKEN` still honored); rotate it there + in the
`claude mcp add` header if needed.

## Reference (lazy — read when touching the area)

| Area | Doc |
|---|---|
| Screencast resource, registry/reaper/blob-GC, Chrome in-process relaunch, session reuse, page reaper, per-session lock, SQLite pragmas | [`docs/DAEMON.md`](docs/DAEMON.md) |
| Tool-surface modes (full/slim/gateway) + all `LEAN_CHRONOSCOPE_*` env tunables | [`docs/CONFIG.md`](docs/CONFIG.md) |
| Fonts / custom-font drop-in / `fonts_list` | [`docs/FONTS.md`](docs/FONTS.md) |

- Claude Code already defers MCP tool schemas natively, so gateway mode is redundant there (see `docs/CONFIG.md`).
- Headless Chrome renders with the **container's** fonts. Dropping fonts into `/home/mcp/.fonts` auto-restarts the daemon, which kills active sessions' browser state (captured history survives in SQLite).
- A new RPC that mutates browser/page state must be added to `LOCKED_METHODS` in `src/daemon/rpc-handlers.ts` (per-session FIFO lock — see `docs/DAEMON.md`).

## Tests

All e2e (real daemon, real Chromium, real CDP — no mocks).

- **Every tool (58):** `node scripts/test-all-tools.mjs` — one shared session, checkbox/PASS-FAIL matrix, closes its session at the end. Per-tool checklist: [`docs/TOOL_TESTS.md`](docs/TOOL_TESTS.md). Simple tools are tested inline in the runner; tools needing setup live in `scripts/tools/*.mjs` with a shared `harness.mjs` + seed `fixture.mjs`.
- **What each test covers:** [`docs/TESTS.md`](docs/TESTS.md)
- **Pass/fail history with timestamps:** [`docs/TEST_LOG.md`](docs/TEST_LOG.md)
- **Scripts:** `scripts/test-all-tools.mjs`, `scripts/smoke-test-*.mjs`

After each test run, append a timestamped entry to `docs/TEST_LOG.md`.

**Token benchmark:** `node scripts/bench-tokens.mjs [url]` measures model-visible output size per tool call + the fixed schema mount cost. Head-to-head vs Playwright MCP: [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Follow-ups

Known deferrals and rough edges: [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md).

## Gotchas

- `docker exec -i` does NOT propagate stdin EOF to the child node process. Smoke scripts must `proc.kill("SIGTERM")` after `stdin.end()` or they hang at the end (exit 124).
- Chromium denies IndexedDB on `data:` URLs (opaque origin). For IDB tests, serve seed HTML from a fake HTTPS host via `intercept_add` with a `respond` action.
- `page.setUserAgent(ua, metadata)` rejects when `metadata` isn't the full `Emulation.UserAgentMetadata` shape. Use the plain-string overload; pass `platform` via the options overload; push `Accept-Language` via `Network.setExtraHTTPHeaders`.
- FTS5: only one `snippet()`/`highlight()` per SELECT, and aux functions (`snippet`/`bm25`) don't combine with a JOIN on a multi-column external-content table (raises "SQL logic error") — rank in a subquery over the FTS table alone, then join. Bare queries with `.`/`:`/`-` (e.g. `example.com`) are FTS syntax errors; `normalizeFtsQuery` in `reader.ts` quotes them.
