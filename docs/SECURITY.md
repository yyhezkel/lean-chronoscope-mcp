# Security model

lean-chronoscope-mcp runs a real browser with full automation on the server. Treat it as
a privileged service. This document records the trust model and the audit done
for v1.0.

## Trust model

- **Single-tenant, operator-controlled.** The daemon and all MCP sessions belong
  to the same operator. There is no per-user authz inside the daemon — anyone who
  can reach the Unix socket or the (optional) HTTP bridge can drive the browser.
- **Primary access is the Unix socket** at `/run/lean-chronoscope/daemon.sock`
  (mode `0660`), reachable only inside the container or via `docker exec`. Access
  is therefore gated by Docker/host permissions + SSH, not by anything in-process.
- **The browser is shared infrastructure.** Sessions are isolated by
  `BrowserContext` (separate cookies/storage/cache — verified by
  `scripts/test-multi-session-isolation.mjs`), but they share one Chrome process.

## Surfaces & controls

| Surface | Control |
|---|---|
| Unix socket | File perms `0660`; container/SSH boundary. |
| HTTP+SSE bridge (opt-in) | Disabled unless `LEAN_CHRONOSCOPE_HTTP_TOKEN` set. Requires `Authorization: Bearer <token>`. Constant-time token compare (`timingSafeEqual` over SHA-256 digests — no length leak). Binds `127.0.0.1` by default — **never** expose it beyond loopback without TLS (built-in via `HTTP_TLS_CERT`/`_KEY`, or a TLS-terminating proxy). Half-configured TLS (only cert or only key) → bridge refuses to start. POST body cap (default 4 MiB → 413), token-bucket rate limits (429 + `Retry-After`; `/health` exempt) in three separate buckets: failed auth per client IP (default 60/min — once exhausted, requests without a live session are refused before the token compare, so brute force stays throttled; a bad token presented with a live `mcp-session-id` skips that pre-check but is still counted and answered 429 once over the limit), authenticated requests per MCP session (default 600/min; DELETE exempt), session-less/initialize requests per IP (default 120/min); concurrent MCP-session cap (default 64 → 503). Invalid numeric limit env values log an error and use the default (fail closed, never "no limit"). Each HTTP MCP session uses its own daemon connection, so resource subscriptions (incl. the CDP screencast) are isolated per client and released on disconnect. An idle sweep closes sessions with no open request (an open SSE stream counts; TCP keepalive on SSE sockets) for `HTTP_IDLE_MS` (default 30 min), so a client that dies without DELETE can't pin a session/daemon connection/screencast forever; unknown session ids get 404 (client re-initializes). |
| Process user | Container runs as non-root `mcp:1500`. |
| Chrome flags | `--no-sandbox` (required in container) + `--disable-dev-shm-usage`; `shm_size: 2g`. |
| Secret leakage in captures | 3-mode redaction (`src/shared/redact.ts`), default `external`: redacts Authorization/Cookie/API-key headers, token-shaped body values, and URL credentials (userinfo + secret-named query/fragment/path-matrix params, also inside `Referer`/`Location`) for non-trusted hosts. URL params additionally match short names that would be false-positive-prone in free-form bodies and are therefore URL-only: `token`, OAuth `code`, Google `key`, `sig`/`signature`, `auth`, `session`/`session_id`/`sessionid`, AWS SigV4 presign `X-Amz-Signature`/`X-Amz-Credential`/`X-Amz-Security-Token`, GCS `X-Goog-Signature`/`X-Goog-Credential` (bodies match only compound names such as `access_token`, `id_token`, `api_key`, `jwt`). A query value is redacted up to the next `&`/`#`/whitespace (a `/` inside it, e.g. base64, stays redacted); a path `;name=value` stops at the next `/`, `;` or `?`. Applied in the MCP tool layer to text **and** `structuredContent` of `network_list`/`network_get`/`network_search`/`network_wait_for` and `console_list`/`console_get`/`console_search` (console rows gate on their source url; rows without one are treated as external). Page URLs are redacted the same way in `page_navigate`/`page_list`/`page_new`/`page_back`/`page_forward`/`page_reload`/`session_new`, `screenshot_take`, `performance_metrics`, the `snapshot_take` header + `snapshot_diff` `beforeUrl`/`afterUrl`, and MCP resource reads (`…/url`, `…/pages`, console/network/exceptions live feeds). |
| Blob paths | Blobs stored under `/var/lib/lean-chronoscope/sessions/<id>/blobs`; only sha referenced in tool output, not host paths. |
| Logs | pino → file only, never stdout (stdout is MCP framing). Rotated at 10MB, 5 archives. |
| Retention | Session dirs older than `LEAN_CHRONOSCOPE_RETENTION_DAYS` (default 7) swept on daemon start. |

## Known limitations (acceptable for v1.0)

- **Redaction is output-side only.** The SQLite capture (and FTS index) stores raw
  URLs/headers/bodies; tools redact what they return. So FTS still *matches* on a
  secret value (e.g. `network_search` for a token finds the request), it just
  never echoes it. Anyone with direct access to the session DB sees raw data.
- **Snapshot bodies are not URL-redacted.** Only the page URL in the `snapshot_take`
  header/structured output is; link `href`s and other URLs inside the accessibility
  tree text (and `snapshot_diff` patches) are passed through. Values read back by
  storage/cookie/`script_evaluate` tools are likewise raw — they reflect live page
  state the caller can already read.
- **HTTP bridge IP buckets are keyed on the socket peer.** `X-Forwarded-For` is
  deliberately not trusted, so behind docker-proxy / a reverse proxy all host
  clients share the failed-auth and initialize buckets. Authenticated traffic is
  bucketed per MCP session, and a request carrying a live `mcp-session-id` (an
  unguessable UUID only handed out after auth) skips the failed-auth pre-check —
  so a bad-token flood can't lock out connected clients. It *can* delay **new**
  sessions from the same IP until the bucket refills (≤ 1 min); raise
  `LEAN_CHRONOSCOPE_HTTP_RATE_PER_MIN` / `_INIT_RATE_PER_MIN` or rate-limit at the proxy.
  Built-in TLS uses the PEM files as-is; there's no hot reload — restart the
  container after rotating the cert.
- **No per-tool authorization.** A connected client can run every tool, including
  `script_evaluate`-class power (via `page.evaluate` inside storage tools) and
  interception. Anyone with socket access has full browser control by design.
- **Redaction is best-effort pattern matching**, not a guarantee. Novel secret
  shapes can slip through. Use `LEAN_CHRONOSCOPE_REDACT_MODE=all` for demos/recordings.

## Env reference

| Var | Default | Purpose |
|---|---|---|
| `LEAN_CHRONOSCOPE_REDACT_MODE` | `external` | `all` / `external` / `none` |
| `LEAN_CHRONOSCOPE_TRUSTED_DOMAINS` | `localhost,127.0.0.1,::1` | hosts treated as internal in `external` mode (extend with your own) |
| `LEAN_CHRONOSCOPE_HTTP_TOKEN` | (unset) | enables HTTP bridge; bearer token |
| `LEAN_CHRONOSCOPE_HTTP_HOST` / `_PORT` | `127.0.0.1` / `8780` | HTTP bridge bind |
| `LEAN_CHRONOSCOPE_HTTP_TLS_CERT` / `_TLS_KEY` | (unset) | PEM paths; both → HTTPS; only one → bridge not started |
| `LEAN_CHRONOSCOPE_HTTP_MAX_BODY_BYTES` | `4194304` | POST body cap (413) |
| `LEAN_CHRONOSCOPE_HTTP_RATE_PER_MIN` | `60` | failed-auth attempts per IP (429); `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_SESSION_RATE_PER_MIN` | `600` | authenticated requests per MCP session (429); `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_INIT_RATE_PER_MIN` | `120` | session-less (initialize) requests per IP (429); `0` disables |
| `LEAN_CHRONOSCOPE_HTTP_MAX_SESSIONS` | `64` | concurrent MCP transports (503); `0` = unlimited |
| `LEAN_CHRONOSCOPE_HTTP_IDLE_MS` | `1800000` | close HTTP MCP sessions idle this long (no open request/SSE stream); `0` disables |
| `LEAN_CHRONOSCOPE_RETENTION_DAYS` | `7` | session retention sweep |
| `LEAN_CHRONOSCOPE_LOG_MAX_BYTES` / `_LOG_KEEP` | `10MB` / `5` | log rotation |

The legacy `BROWSER_MCP_*` env names are still honored as a fallback for backward compatibility.
