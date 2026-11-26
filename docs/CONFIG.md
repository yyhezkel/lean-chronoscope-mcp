# Configuration — tool-surface modes and env tunables

> Moved verbatim from CLAUDE.md (origin/main 3c5eca0) §"Tool-surface modes" and §"Session lifecycle & retention" (env table) on 2026-11-25 (CLAUDE.md trim). One edit: full-mode tool count 57 → 58 (`allTools` in `src/mcp/tools/tools.ts:46` has 58 entries).

## Tool-surface modes (mount-token cost)

| Mode | flag / env | tools advertised | `tools/list` payload |
|---|---|---|---|
| full (default) | — | 58 | ~5,350 tok |
| slim | `--slim` / `LEAN_CHRONOSCOPE_SLIM=1` | 5 core | ~547 tok |
| gateway | `--gateway` / `LEAN_CHRONOSCOPE_GATEWAY=1` | 3 meta (`tools_catalog`, `tool_schema`, `tools_invoke`); the 58 stay callable by name | ~321 tok |

Gateway mode advertises a 3-tool index — the model reads `tools_catalog`, fetches
`tool_schema` only for tools it needs, then dispatches via `tools_invoke`. Reproduces
client-side schema deferral for clients that don't have it. **Note:** Claude Code
already defers MCP tool schemas natively (only tool *names* enter context at mount;
full schemas load on demand via `ToolSearch`), so gateway is redundant there and
slightly worse (loses native function-calling + arg validation). Use it for
non-deferring clients or extreme token budgets. See [`docs/COMPARISON.md`](docs/COMPARISON.md).

## Env tunables

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
| `LEAN_CHRONOSCOPE_PAGE_IDLE_MS` | `900000` (15min) | reaper closes non-selected pages idle longer than this; `0` disables |
| `LEAN_CHRONOSCOPE_MAX_PAGES_PER_SESSION` | `20` | reaper closes oldest-idle non-selected pages beyond this cap; `0` disables |
| `LEAN_CHRONOSCOPE_LOCKED_OP_TIMEOUT_MS` | `60000` | max time a locked RPC may hold the session lock before failing with TIMEOUT; `0` disables; invalid → logged + default |
| `LEAN_CHRONOSCOPE_FONT_WATCH` | `1` | auto-restart daemon when fonts change in `FONTS_DIR`; `0` disables |
| `LEAN_CHRONOSCOPE_FONTS_DIR` | `/home/mcp/.fonts` | custom-font drop-in dir watched by font-watch |
| `LEAN_CHRONOSCOPE_HTTP_TOKEN` | (unset) | HTTP bridge bearer token |
| `LEAN_CHRONOSCOPE_HTTP_MAX_BODY_BYTES` | `4194304` (4 MiB) | HTTP bridge POST body cap; larger → 413 |
| `LEAN_CHRONOSCOPE_HTTP_RATE_PER_MIN` | `60` | failed-auth attempts per client IP (token bucket, burst = rate) → 429 + `Retry-After`; once exhausted, requests without a live `mcp-session-id` are refused before the token compare, and a bad token on a live sid gets 429 instead of 401; `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_SESSION_RATE_PER_MIN` | `600` | authenticated requests per MCP session (`mcp-session-id`) → 429; DELETE exempt; `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_INIT_RATE_PER_MIN` | `120` | authenticated requests with no live session (initialize) per client IP → 429; `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_MAX_SESSIONS` | `64` | max concurrent HTTP MCP transports; new sessions beyond → 503; `0` = unlimited |
| `LEAN_CHRONOSCOPE_HTTP_IDLE_MS` | `1800000` (30min) | close HTTP MCP sessions with no open request (incl. SSE stream) for this long — releases daemon connection/subscriptions/screencast; client gets 404 and re-inits; `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_TLS_CERT` / `_TLS_KEY` | (unset) | PEM file paths; both set → bridge serves HTTPS; only one set → bridge refuses to start (fail closed) |
| `LEAN_CHRONOSCOPE_DATA_DIR` | `/var/lib/lean-chronoscope` | data root (sessions + `registry.sqlite`) |
