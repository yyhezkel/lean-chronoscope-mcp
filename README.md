# lean-chronoscope-mcp

**A token-efficient browser MCP server.** Headless Chrome in Docker, captures everything (console, network, exceptions, IndexedDB, snapshots) into a per-session SQLite store, and exposes 57 tools that query that store — so the model only pays for what it asks for.

Built for Claude Code, Claude Desktop, and any other MCP client. Drop-in alternative to [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) and [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp), with a sharper focus on tokens-per-task.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-blue)](#prerequisites)
[![MCP](https://img.shields.io/badge/MCP-1.x-purple)](https://modelcontextprotocol.io)

---

## Why?

Other browser MCP servers burn a lot of context: they re-emit the full accessibility tree on every action, list giant network logs, and inline screenshots on navigate. For a multi-step agent task that compounds fast.

This server takes a different shape:

- **Capture firehose, query on read.** A long-running daemon owns Chrome over CDP and writes every console message, network request, exception, and snapshot to a per-session SQLite + content-addressed blob store. Tools are queries on top — listings return summaries, detail tools fetch bodies.
- **Compact, interactive-only snapshot.** `[e12] button "Save"` style tree — ~2.8× smaller than Playwright's full aria YAML on the same page ([measured](docs/COMPARISON.md)).
- **Three mount-cost modes.** `full` (57 tools, ~5.3k tok at mount), `slim` (5 core tools, ~547 tok), or `gateway` (3 meta-tools, ~321 tok — the model picks tools on demand and the schemas load only when asked for).
- **Tools other servers lack:** IndexedDB read/write, network interception (abort / continue / respond), 3-mode secret redaction, FTS5 search across console + network history, snapshot diffs.
- **Live MCP resources** with real `listChanged` and per-section change-detect memo — `(unchanged since rev N)` collapses repeated polling.

## Quick start

### Prerequisites
- Docker + Docker Compose
- Node 22+ (only if you want to run scripts/tests from the host)

### Run the daemon

```bash
git clone https://github.com/yyhezkel/lean-chronoscope-mcp.git
cd lean-chronoscope-mcp

# Generate a bearer token for the HTTP bridge:
echo "LEAN_CHRONOSCOPE_HTTP_TOKEN=$(openssl rand -base64 32)" > docker/.env

docker compose -f docker/docker-compose.yml up -d --build
docker exec lean-chronoscope-mcp ls /run/lean-chronoscope/daemon.sock   # should exist
curl -s http://127.0.0.1:8780/health                       # {"ok":true,...}
```

### Register with an MCP client

**Claude Code (HTTP transport — recommended):**
```bash
claude mcp add lean-chronoscope -s user --transport http http://127.0.0.1:8780/mcp \
  --header "Authorization: Bearer $(grep LEAN_CHRONOSCOPE_HTTP_TOKEN docker/.env | cut -d= -f2)"
```
Restart your client session — tool lists load at startup.

**stdio (Claude Desktop, etc.):**
```jsonc
{
  "mcpServers": {
    "lean-chronoscope": {
      "command": "docker",
      "args": ["exec", "-i", "lean-chronoscope-mcp", "node", "/app/dist/bin/mcp.js", "--session", "default"]
    }
  }
}
```

Tools appear in your client as `mcp__lean-chronoscope__*` (or whatever alias you choose). The Docker container is named `lean-chronoscope-mcp` by default — that's a local name only; rename it via `container_name:` in `docker/docker-compose.yml` if you prefer.

**Reusing a session across reconnects (HTTP):** by default the HTTP bridge mints a fresh browser session per connection. Send an `x-lc-session: <id>` request header to pin a stable session id — reconnecting with the same header returns to the same daemon session (rehydrated from disk if the earlier disconnect closed it) instead of a new random one. Session ids from callers are validated (no `/`, `\`, `..`, NUL, empty, or >200 chars) to prevent path traversal, since an id becomes a filesystem path.

## Tool surface (57 tools)

| Category | Tools |
|---|---|
| Session | `session_list`, `session_new`, `session_attach`, `session_close` |
| Pages | `page_navigate`, `page_list`, `page_new`, `page_select`, `page_close`, `page_back`, `page_forward`, `page_reload` |
| Perception | `snapshot_take`, `snapshot_diff`, `screenshot_take`, `wait_for` |
| Input | `click`, `hover`, `type`, `fill_form`, `key`, `scroll`, `drag`, `upload_file` |
| Console | `console_list`, `console_get`, `console_search` (FTS5) |
| Network | `network_list`, `network_get`, `network_search` (FTS5), `network_wait_for` |
| Interception | `intercept_add`, `intercept_list`, `intercept_remove` |
| Storage | `cookies_*`, `localStorage_*`, `sessionStorage_*`, `indexeddb_*` |
| Emulation | `emulate_viewport`, `emulate_useragent`, `emulate_network`, `emulate_geolocation` |
| Diagnostics | `performance_metrics`, `daemon_status`, `script_evaluate` |

## Mount-cost modes

| Mode | Flag / env | Tools advertised | `tools/list` payload |
|---|---|---|---|
| `full` *(default)* | — | 57 | ~5,350 tok |
| `slim` | `--slim` / `LEAN_CHRONOSCOPE_SLIM=1` | 5 core | ~547 tok |
| `gateway` | `--gateway` / `LEAN_CHRONOSCOPE_GATEWAY=1` | 3 meta (`tools_catalog`, `tool_schema`, `tools_invoke`) — the 57 stay callable by name | ~321 tok |

**Gateway mode** advertises a 3-tool index: the model reads `tools_catalog`, fetches `tool_schema` only for tools it needs, then calls them via `tools_invoke`. Useful for MCP clients that don't already defer tool schemas on the client side. *Note:* Claude Code already defers MCP schemas natively — gateway is mostly useful for other clients or extreme token budgets. See [`docs/COMPARISON.md`](docs/COMPARISON.md) for the full breakdown.

## Architecture

```
┌─────────────────┐  Unix socket (NDJSON RPC)  ┌──────────────────────────────┐
│  mcp-server     │ ◀──────────────────────────▶ │  daemon (long-running)       │
│  (per session,  │                              │  ├─ Chrome via CDP           │
│   stdio / HTTP) │                              │  ├─ per-session SQLite       │
└─────────────────┘                              │  └─ content-addressed blobs  │
        ▲                                        └──────────────────────────────┘
        │ MCP                                              ▲
        │ (stdio or                                        │
        │  HTTP+SSE)                                       │ CDP
        ▼                                                  ▼
   MCP client                                         Chromium
```

The daemon owns the browser and writes the firehose to SQLite. Each MCP client connection spawns a thin per-session mcp-server that talks to the daemon over a Unix socket. Tools are queries on the store; listings return summaries, detail tools fetch bodies, big bodies become content-addressed blobs.

See [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the deeper design rationale.

## Session lifecycle & retention

Sessions are tracked in a persistent cross-session index, `registry.sqlite`, at
`<dataDir>/registry.sqlite` (a `sessions` table: id, created_at, last_activity,
status open/closed, source stdio/http, page_count, size_bytes, closed_at,
data_dir). It survives daemon restarts and is reconciled at boot (orphaned
`open` rows flip to `closed`, on-disk session dirs are re-indexed). `session_list`
reports `lastActivity`, `sizeBytes` (db+wal+shm+blobs), `status`, and `source`,
and takes an optional `includeClosed` to also surface closed sessions from the
registry; `daemon_status` reports the same accounting plus a `dbBytes`/`blobBytes`
breakdown.

Sessions can carry an optional human **`title`** (a column in `registry.sqlite`,
surfaced on `session_list`). The **`session_attach`** tool points a connection at
an existing session — by id or by title — and **rehydrates a closed session's
captured history** from disk (the BrowserContext starts fresh; browser state
isn't persisted, but all captured console/network/snapshot history is readable).
A title that matches nothing starts a new session carrying it (**attach-or-create**).

A background **reaper** keeps things bounded automatically:

- **Idle / size eviction** — frees the browser context + memory (leaving the
  on-disk DB for the age sweep) for sessions idle past `LEAN_CHRONOSCOPE_IDLE_MS`
  (default 30min) or over `LEAN_CHRONOSCOPE_SIZE_CAP_BYTES` (default 500MB,
  `0` disables).
- **Row pruning** — keeps the newest `LEAN_CHRONOSCOPE_MAX_CONSOLE` (50k) console
  rows, `LEAN_CHRONOSCOPE_MAX_NETWORK` (50k) network rows, and
  `LEAN_CHRONOSCOPE_MAX_SNAPSHOTS_PER_PAGE` (10) snapshots per page; FTS stays in
  sync via triggers and freed pages are reclaimed with `incremental_vacuum`. Prune
  now also **GCs orphaned blob files** right after deleting rows — a
  content-addressed blob (`blobs/<sha>.bin`) is removed only once no surviving row
  references its sha (dedup-safe), instead of lingering until the age sweep.
- **Age sweep** — session dirs older than `LEAN_CHRONOSCOPE_RETENTION_DAYS`
  (default 7) are removed ~hourly (not just at boot) and the registry stays in sync.

Reaper cadence is `LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS` (default 60000, `0`
disables the reaper). Sessions checkpoint (`wal_checkpoint(TRUNCATE)`) before
closing so the persisted `db.sqlite` is complete and compact.

> Env vars use the `LEAN_CHRONOSCOPE_*` prefix; the legacy `BROWSER_MCP_*` names
> are still honored as a fallback for backward compatibility.

## vs Playwright MCP / Chrome DevTools MCP

| | lean-chronoscope-mcp | @playwright/mcp | chrome-devtools-mcp |
|---|---|---|---|
| Snapshot format | compact, interactive-only | full aria YAML | aria + extras |
| Snapshot cost (HN, ~tok) | **~5,343** | ~14,756 | similar to Playwright |
| 5-step task cost (~tok) | **~5.6k** | ~24k | similar to Playwright |
| Mount overhead | 57 tools, ~5.3k tok (or 321 in gateway) | 20 tools, ~2k | ~30 tools |
| IndexedDB tools | ✅ | ❌ | ❌ |
| Network interception | ✅ abort / continue / respond | ❌ | ❌ |
| Secret redaction | ✅ 3-mode | ❌ | ❌ |
| FTS5 search (console / network) | ✅ | ❌ | ❌ |
| Persistence | per-session SQLite | in-memory | in-memory |

Full numbers + methodology in [`docs/COMPARISON.md`](docs/COMPARISON.md). Token estimate = chars/4; the ratio is tokenizer-independent.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — guide for working inside the repo (also useful for any agent-driven contribution).
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — full architecture + rationale.
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust model + redaction options.
- [`docs/COMPARISON.md`](docs/COMPARISON.md) — measured token comparison vs Playwright MCP.
- [`docs/TESTS.md`](docs/TESTS.md) + [`docs/TOOL_TESTS.md`](docs/TOOL_TESTS.md) — what each test covers; per-tool checklist.
- [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md) — known deferrals, deployment notes, MCP-client integration tips.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
docker compose -f docker/docker-compose.yml up -d --build
node scripts/test-all-tools.mjs        # 57-tool e2e suite (must pass 57/57)
node scripts/bench-tokens.mjs           # measure mount + per-call cost
node scripts/smoke-test-gateway.mjs     # gateway-mode smoke
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Yossi Yehezkel
