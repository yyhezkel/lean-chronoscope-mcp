# CLAUDE.md

Project guide for Claude Code when working in `/home/runner/browser-mcp/`.

## Overview

Token-efficient browser MCP server: a long-running headless Chrome in Docker, shared by multiple MCP clients on the same host. TypeScript + Node 22 + puppeteer-core + `@modelcontextprotocol/sdk` + better-sqlite3.

Architecture: split between a **daemon** (owns Chrome + SQLite) and a per-Claude-session **mcp-server** (stdio), talking over a Unix socket with NDJSON JSON-RPC. Capture-everything firehose into per-session SQLite at `/var/lib/lean-chronoscope/sessions/<id>/db.sqlite`; tools are queries on top.

Full implementation plan: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md). Current state: **v1.3.0 — M0–M6 + full tool surface + session lifecycle/retention**, 56 tools (session/page lifecycle, input incl. upload_file, snapshot+diff, screenshot, console+search, network+search+wait, intercept, storage, script_evaluate, emulation, waits, daemon_status). Session management: a persistent cross-session `registry.sqlite` (survives daemon restarts, reconciled at boot), correct size accounting on `session_list`/`daemon_status` (db+wal+shm+blobs, with `dbBytes`/`blobBytes` breakdown; `session_list` takes `includeClosed`), and a background **reaper** that evicts idle/oversized sessions, prunes console/network/snapshot rows, and runs the age-retention sweep hourly. Security/trust model: [`docs/SECURITY.md`](docs/SECURITY.md).

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

Tools surface as `mcp__lean-chronoscope__*` after a session restart. The bridge mints
a fresh browser session per HTTP MCP session (recorded with `source='http'`), and
its `transport.onclose` now closes that daemon session so BrowserContexts/SQLite
don't leak on client disconnect. The bearer token lives in
`docker/docker-compose.yml` (`LEAN_CHRONOSCOPE_HTTP_TOKEN`, legacy
`BROWSER_MCP_HTTP_TOKEN` still honored); rotate it there + in the
`claude mcp add` header if needed.

## Tool-surface modes (mount-token cost)

| Mode | flag / env | tools advertised | `tools/list` payload |
|---|---|---|---|
| full (default) | — | 56 | ~5,258 tok |
| slim | `--slim` / `LEAN_CHRONOSCOPE_SLIM=1` | 5 core | ~547 tok |
| gateway | `--gateway` / `LEAN_CHRONOSCOPE_GATEWAY=1` | 3 meta (`tools_catalog`, `tool_schema`, `tools_invoke`); the 56 stay callable by name | ~321 tok |

Gateway mode advertises a 3-tool index — the model reads `tools_catalog`, fetches
`tool_schema` only for tools it needs, then dispatches via `tools_invoke`. Reproduces
client-side schema deferral for clients that don't have it. **Note:** Claude Code
already defers MCP tool schemas natively (only tool *names* enter context at mount;
full schemas load on demand via `ToolSearch`), so gateway is redundant there and
slightly worse (loses native function-calling + arg validation). Use it for
non-deferring clients or extreme token budgets. See [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Session lifecycle & retention

The daemon keeps a persistent `registry.sqlite` at `<dataDir>/registry.sqlite`
(a `sessions` table indexing every session across daemon restarts) and runs a
background **reaper** (`setInterval`) that flushes size stats to the registry,
evicts idle/oversized sessions (frees the BrowserContext + memory, leaves the
on-disk dir for the age sweep), prunes over-long console/network/snapshot tables,
and runs the age-retention sweep ~hourly. Session DBs open with
`auto_vacuum=INCREMENTAL` + `wal_autocheckpoint=1000` + `journal_size_limit=64MB`,
and `wal_checkpoint(TRUNCATE)` runs on clean close so the persisted `db.sqlite`
is complete/compact (docker-compose sets `stop_grace_period: 30s` to allow it).

Env tunables (all `LEAN_CHRONOSCOPE_*`; legacy `BROWSER_MCP_*` names still honored):

| Var | Default | Purpose |
|---|---|---|
| `LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS` | `60000` | reaper tick cadence; `0` disables the reaper |
| `LEAN_CHRONOSCOPE_IDLE_MS` | `1800000` (30min) | evict sessions idle longer than this |
| `LEAN_CHRONOSCOPE_SIZE_CAP_BYTES` | `524288000` (500MB) | evict sessions over this size; `0` disables |
| `LEAN_CHRONOSCOPE_RETENTION_DAYS` | `7` | age-retention sweep for on-disk session dirs |
| `LEAN_CHRONOSCOPE_MAX_CONSOLE` | `50000` | keep newest N console rows per session |
| `LEAN_CHRONOSCOPE_MAX_NETWORK` | `50000` | keep newest N network rows per session |
| `LEAN_CHRONOSCOPE_MAX_SNAPSHOTS_PER_PAGE` | `10` | keep newest N snapshots per page |
| `LEAN_CHRONOSCOPE_HTTP_TOKEN` | (unset) | HTTP bridge bearer token |
| `LEAN_CHRONOSCOPE_DATA_DIR` | `/var/lib/lean-chronoscope` | data root (sessions + `registry.sqlite`) |

## Tests

All e2e (real daemon, real Chromium, real CDP — no mocks).

- **Every tool (56):** `node scripts/test-all-tools.mjs` — one shared session, checkbox/PASS-FAIL matrix, closes its session at the end. Per-tool checklist: [`docs/TOOL_TESTS.md`](docs/TOOL_TESTS.md). Simple tools are tested inline in the runner; tools needing setup live in `scripts/tools/*.mjs` with a shared `harness.mjs` + seed `fixture.mjs`.
- **What each test covers:** [`docs/TESTS.md`](docs/TESTS.md)
- **Pass/fail history with timestamps:** [`docs/TEST_LOG.md`](docs/TEST_LOG.md)
- **Scripts:** `scripts/test-all-tools.mjs`, `scripts/smoke-test-*.mjs`

After each test run, append a timestamped entry to `docs/TEST_LOG.md`.

**Token benchmark:** `node scripts/bench-tokens.mjs [url]` measures model-visible output size per tool call + the fixed schema mount cost. Head-to-head vs Playwright MCP: [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Follow-ups

Known deferrals and rough edges (screencast, session_attach, HTTP TLS, in-place Chrome relaunch, network_list redaction, etc.): [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md).

## Gotchas

- `docker exec -i` does NOT propagate stdin EOF to the child node process. Smoke scripts must `proc.kill("SIGTERM")` after `stdin.end()` or they hang at the end (exit 124).
- Chromium denies IndexedDB on `data:` URLs (opaque origin). For IDB tests, serve seed HTML from a fake HTTPS host via `intercept_add` with a `respond` action.
- `page.setUserAgent(ua, metadata)` rejects when `metadata` isn't the full `Emulation.UserAgentMetadata` shape. Use the plain-string overload; pass `platform` via the options overload; push `Accept-Language` via `Network.setExtraHTTPHeaders`.
- FTS5: only one `snippet()`/`highlight()` per SELECT, and aux functions (`snippet`/`bm25`) don't combine with a JOIN on a multi-column external-content table (raises "SQL logic error") — rank in a subquery over the FTS table alone, then join. Bare queries with `.`/`:`/`-` (e.g. `example.com`) are FTS syntax errors; `normalizeFtsQuery` in `reader.ts` quotes them.
- IndexedDB is blocked on `data:` URLs (opaque origin).
