# HTTP+SSE bridge internals

> Moved verbatim from CLAUDE.md (origin/main 3c5eca0) §"MCP client integration" (bridge internals) on 2026-11-25 (CLAUDE.md trim).

Tools surface as `mcp__lean-chronoscope__*` after a session restart. The bridge mints
a fresh browser session per HTTP MCP session (recorded with `source='http'`), and
its `transport.onclose` now closes that daemon session so BrowserContexts/SQLite
don't leak on client disconnect. Each HTTP MCP session also gets its **own daemon
socket connection** (opened at initialize, closed with the transport — or right
away if the first request never initializes): daemon-side resource subscriptions
are keyed per connection, so one client's unsubscribe can't end another's stream,
and a disconnect releases its subscriptions (stopping a CDP screencast nobody else
watches). A client that dies without DELETE never fires `onclose` (the SDK has no
idle timeout, and a watched page is exempt from the daemon's idle eviction), so an
**idle sweep** closes transports with no request open (an open GET SSE stream
counts as alive; TCP keepalive detects half-open SSE sockets) and none started for
`HTTP_IDLE_MS` (default 30 min) via the same `onclose` path. A stale/unknown
`mcp-session-id` gets the spec'd **404** (`-32001 Session not found`) so the client
re-initializes; an `initialize` carrying a stale header is still accepted.

**Session persistence on reconnect:** the bridge honors a client-supplied
`x-lc-session: <id>` request header — reconnecting with the same header returns
to the same daemon session (rehydrated from disk if the earlier disconnect closed
it) instead of getting a fresh random `http-<rand>` id. No header → random id as
before. Session ids from untrusted callers (this header, and `session_attach`'s
`sessionId`) are validated by `assertSafeSessionId()` in the daemon's `ensure`,
which rejects ids containing `/`, `\`, `..`, NUL, or that are empty / >200 chars —
an id becomes a filesystem path, so this prevents traversal out of the sessions dir.

Bridge hardening: constant-time bearer compare, 4 MiB body cap (413), rate limits
in separate token buckets (429) — failed auth per client IP, authenticated requests
per MCP session, session-less (initialize) requests per IP — so parallel agents
behind docker-proxy's shared gateway IP don't starve each other and a bad-token
flood can't lock out live sessions; concurrent-session cap (503), and optional
built-in TLS — see the tunables table below. Invalid numeric limits (typos, NaN,
negative) log an error and fall back to the default (fail closed). Smoke: `scripts/smoke-test-http-bridge.mjs`.
