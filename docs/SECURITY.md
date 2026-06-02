# Security model

browser-mcp runs a real browser with full automation on the server. Treat it as
a privileged service. This document records the trust model and the audit done
for v1.0.

## Trust model

- **Single-tenant, operator-controlled.** The daemon and all MCP sessions belong
  to the same operator. There is no per-user authz inside the daemon — anyone who
  can reach the Unix socket or the (optional) HTTP bridge can drive the browser.
- **Primary access is the Unix socket** at `/run/browser-mcp/daemon.sock`
  (mode `0660`), reachable only inside the container or via `docker exec`. Access
  is therefore gated by Docker/host permissions + SSH, not by anything in-process.
- **The browser is shared infrastructure.** Sessions are isolated by
  `BrowserContext` (separate cookies/storage/cache — verified by
  `scripts/test-multi-session-isolation.mjs`), but they share one Chrome process.

## Surfaces & controls

| Surface | Control |
|---|---|
| Unix socket | File perms `0660`; container/SSH boundary. |
| HTTP+SSE bridge (opt-in) | Disabled unless `BROWSER_MCP_HTTP_TOKEN` set. Requires `Authorization: Bearer <token>`. Binds `127.0.0.1` by default — **never** `0.0.0.0` without a TLS-terminating proxy. No built-in TLS. |
| Process user | Container runs as non-root `mcp:1500`. |
| Chrome flags | `--no-sandbox` (required in container) + `--disable-dev-shm-usage`; `shm_size: 2g`. |
| Secret leakage in captures | 3-mode redaction (`src/shared/redact.ts`), default `external`: redacts Authorization/Cookie/API-key headers + token-shaped body values for non-trusted hosts. Applied in `network_get`. |
| Blob paths | Blobs stored under `/var/lib/browser-mcp/sessions/<id>/blobs`; only sha referenced in tool output, not host paths. |
| Logs | pino → file only, never stdout (stdout is MCP framing). Rotated at 10MB, 5 archives. |
| Retention | Session dirs older than `BROWSER_MCP_RETENTION_DAYS` (default 7) swept on daemon start. |

## Known limitations (acceptable for v1.0)

- **`network_list` summaries are not redacted** — only `network_get` is. URLs with
  inline credentials (`https://user:pass@host`) would appear in the list. Mitigation:
  redaction of list URLs is a follow-up; avoid credential-in-URL flows.
- **HTTP bridge has no TLS and no rate limiting.** Intended for loopback or behind
  a reverse proxy / SSH tunnel only.
- **No per-tool authorization.** A connected client can run every tool, including
  `script_evaluate`-class power (via `page.evaluate` inside storage tools) and
  interception. Anyone with socket access has full browser control by design.
- **Redaction is best-effort pattern matching**, not a guarantee. Novel secret
  shapes can slip through. Use `BROWSER_MCP_REDACT_MODE=all` for demos/recordings.

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `BROWSER_MCP_REDACT_MODE` | `external` | `all` / `external` / `none` |
| `BROWSER_MCP_TRUSTED_DOMAINS` | `localhost,127.0.0.1,::1` | hosts treated as internal in `external` mode (extend with your own) |
| `BROWSER_MCP_HTTP_TOKEN` | (unset) | enables HTTP bridge; bearer token |
| `BROWSER_MCP_HTTP_HOST` / `_PORT` | `127.0.0.1` / `8780` | HTTP bridge bind |
| `BROWSER_MCP_RETENTION_DAYS` | `7` | session retention sweep |
| `BROWSER_MCP_LOG_MAX_BYTES` / `_LOG_KEEP` | `10MB` / `5` | log rotation |
