# Follow-ups

Known deferrals and rough edges, not blocking v1.4.0. Ordered roughly by value.

## Features deferred past v1.0

- **Screencast resource** (planned M5.2, cut). `Page.startScreencast` → 2fps JPEG frames exposed as `browser://session/{sid}/page/{pid}/screencast`, with `resources/updated` carrying the latest frame's blob sha. Stop the CDP screencast when no subscribers remain.
- ~~**`session_attach`** (title-based reattach).~~ **Resolved (v1.4.0).** The `session_attach` tool now points a connection at an existing session by id or by human **title** (attach-or-create when a title matches nothing), rehydrating a closed session's captured history from disk. The HTTP bridge also honors an `x-lc-session: <id>` reconnect header to return to the same session. Untrusted ids are validated by `assertSafeSessionId()` (no `/`, `\`, `..`, NUL, empty, >200 chars) to block path traversal.
- ~~**HTTP-bridge TLS + rate limiting.**~~ **Resolved (v1.7.0).** `src/mcp/http-bridge.ts` now does a constant-time bearer compare, caps POST bodies (`HTTP_MAX_BODY_BYTES`, 4 MiB → 413), rate-limits per client IP with a bounded token-bucket map (`HTTP_RATE_PER_MIN`, 600 → 429 + `Retry-After`, failed auth counted), caps concurrent MCP transports (`HTTP_MAX_SESSIONS`, 64 → 503), and serves HTTPS when both `HTTP_TLS_CERT` and `HTTP_TLS_KEY` are set (only one → bridge refuses to start). Smoke: `scripts/smoke-test-http-bridge.mjs`.
- ~~**In-place Chrome relaunch.** On Chrome disconnect the daemon exits and Docker's restart policy reboots it (sessions' browser state is lost, SQLite survives). A nicer recovery would relaunch Chrome in-process and re-create `BrowserContext`s + collectors + intercept engines without dropping the daemon.~~ **Resolved (v1.7.0).** On unexpected disconnect the daemon relaunches Chrome in-process (backoff 1s/3s/9s, falls back to exit on total failure); `SessionRegistry.rebind()` gives every live session a fresh `BrowserContext`, drops its (dead) pages, keeps intercept rules and all captured history; `dispatch()` gates browser-touching RPCs during the relaunch (≤30s); `daemon_status` exposes `chromeRelaunches`/`lastChromeRelaunchAt`. Per-page emulation and open pages are not restored. Smoke: `scripts/smoke-test-v17-relaunch.mjs`.

## Security / correctness

- ~~**Page-URL redaction.** Network/console tool output is now URL-redacted, but `page_list` / `page_navigate` / snapshot URLs are not.~~ **Resolved (v1.7.0).** `redactUrl` now covers network/console tools, all page/session tools that echo a page URL, `screenshot_take`, snapshot header/diff URLs, and MCP resource reads (text + structuredContent). Link hrefs inside snapshot bodies remain unredacted by design (see `docs/SECURITY.md` "Known limitations").

## Robustness (found during live testing, 2026-05-28)

- ~~**Concurrent tool calls can race.**~~ **Resolved (v1.7.0).** `dispatch()` now runs every browser/page-mutating RPC (`LOCKED_METHODS`: `page.*`, `input.*`, `emulate.*`, `intercept.add/remove`, `cookies.set/clear`, `storage.set/remove/clear`, `indexeddb.clear`, `screenshot.take`, `snapshot.take`) under a per-session FIFO promise-chain mutex (`Session.lock`, `src/shared/mutex.ts`), so an un-awaited `page_navigate` → `snapshot_take` keeps its order and concurrent navigates on a page-less session create one page. Long polls (`wait.for`, `network.wait_for`), read-only queries and `session.close` bypass the lock. Smoke: `scripts/smoke-test-v17-lifecycle.mjs`.
- **`network_list` is empty right after a fresh navigate.** The top-level document request fires `requestWillBeSent` before `frameNavigated` creates the nav row, so it's stored with `nav_id = NULL`. `network_list`'s default scope filters to the latest nav id and hides it. `network_wait_for` / `network_search` (no nav filter) do find it. Fix options: attribute null-nav requests to the page's newest nav at read time, or include null-nav rows in the current-nav default scope.
- ~~**Sessions accumulate; nothing closes them mid-run.**~~ **Resolved (v1.3.0).** A background **reaper** now evicts idle sessions (idle past `LEAN_CHRONOSCOPE_IDLE_MS`, default 30min) and oversized ones (`LEAN_CHRONOSCOPE_SIZE_CAP_BYTES`, default 500MB), prunes over-long console/network/snapshot rows, and runs the age-retention sweep (`LEAN_CHRONOSCOPE_RETENTION_DAYS`, default 7) ~hourly rather than only at daemon start. The HTTP bridge also closes its daemon session on client disconnect (`transport.onclose`), so BrowserContexts/SQLite no longer leak per HTTP connection. A persistent `registry.sqlite` tracks all sessions across restarts. Smokes still `session_close` when done as good hygiene, but leaked sessions are now reaped automatically.
- ~~**Shared session never reaped / one disconnect closes it for everyone.**~~ **Resolved (2026-10-19).** `dispatch()` no longer refreshes `lastActivity` for lifecycle/meta RPCs (`session.ensure`, `session.list`, `status`, `resources.*`, …), so connect-only churn on a pinned `x-lc-session` (or stdio `default`) no longer keeps an idle session alive. The HTTP bridge refcounts transports per daemon session and closes it only when the last one disconnects. Daemon shutdown is bounded (20s, then SIGKILL Chrome) to fit `stop_grace_period`; compose caps `cpus: "2"`.
- ~~**No page-level reaper.**~~ **Resolved (v1.7.0).** Pages now track `lastActivity`/`inFlight`, and the reaper tick closes non-selected pages idle past `LEAN_CHRONOSCOPE_PAGE_IDLE_MS` (default 15min) and enforces `LEAN_CHRONOSCOPE_MAX_PAGES_PER_SESSION` (default 20) by closing the oldest-idle non-selected pages over the cap. Never the selected page or one with an RPC in flight; skipped while the session lock is held, and done under it.
- ~~**Pruned rows leave orphaned blob files.**~~ **Resolved (v1.4.0).** `SessionWriter.prune()` now GCs orphaned blobs right after deleting old console/network rows: `BlobStore.sweepUnreferenced(keep)` + `BlobStore.remove(sha)` delete only `sessions/<id>/blobs/<sha>.bin` whose sha is no longer referenced by any surviving row (content-addressed dedup respected — a shared blob is kept while any row points to it). Previously pruned rows left orphaned blobs on disk until the 7-day age sweep removed the whole session dir.

## MCP client integration note

- **This runtime only mounts HTTP MCP servers into the agent session — not stdio.** Confirmed empirically: every HTTP server (playwright, Canva, Gmail, Drive) loaded; the only stdio server (lean-chronoscope via `docker exec -i … node`) never did, despite `claude mcp list` reporting it "✓ Connected" (the CLI spawns the stdio process locally just to health-check). No number of session restarts fixes a stdio registration here.
  - **Resolution:** register lean-chronoscope over its HTTP+SSE bridge (M4.5). `docker/docker-compose.yml` publishes `127.0.0.1:8780` and sets `LEAN_CHRONOSCOPE_HTTP_TOKEN` (legacy `BROWSER_MCP_HTTP_TOKEN` still honored); register with `claude mcp add lean-chronoscope -s user --transport http http://127.0.0.1:8780/mcp --header "Authorization: Bearer <token>"`. See `CLAUDE.md` → MCP client integration.
- **Tools still load only at Claude session startup** (true for any transport) — `claude mcp add` / the `/mcp` dialog don't inject tools into a running session; a full restart is required.
- **Claude Code defers MCP tool *schemas***, however (confirmed empirically): at mount it injects only tool *names* into the model's context and fetches each full JSON schema on demand via its `ToolSearch` mechanism. So lean-chronoscope-mcp's `tools/list` payload (~5,258 tok in full mode) is the *server-emitted* size, **not** what sits in the model's context at mount — actual mounted cost is closer to the names list. This makes server-side progressive disclosure (e.g. `--gateway` mode) **redundant for Claude Code**; it remains useful for clients that load the full payload upfront. Don't chase server-side `notifications/tools/list_changed` for this client: confirmed it ignores mid-session list changes (full session restart required for any tool-set update).

### Publishing the HTTP bridge behind your own TLS proxy

If your MCP client is on a different host (or, like Claude Code, can only reach *public* HTTPS MCP servers), you'll need to put the bridge behind a TLS reverse-proxy at a public hostname. The bridge already binds `127.0.0.1:8780` and requires a bearer token (`LEAN_CHRONOSCOPE_HTTP_TOKEN` in `docker/.env`; legacy `BROWSER_MCP_HTTP_TOKEN` still honored).

General steps:
1. **DNS:** point a hostname (e.g. `lean-chronoscope.example.com`) at your server.
2. **TLS reverse-proxy** (nginx / Caddy / Traefik): forward the hostname to `http://127.0.0.1:8780`. The proxy MUST: use HTTP/1.1, **disable response buffering** (SSE), keep the stream open, and pass the `Authorization` header through to the bridge. A reference nginx vhost is in [`deploy/lean-chronoscope.example.com.conf`](deploy/lean-chronoscope.example.com.conf).
3. **Register** with the client:
   ```
   claude mcp add lean-chronoscope -s user --transport http https://lean-chronoscope.example.com/mcp \
     --header "Authorization: Bearer <LEAN_CHRONOSCOPE_HTTP_TOKEN>"
   ```
4. Restart the client session — tool lists are loaded at startup.

Token rotation: change `LEAN_CHRONOSCOPE_HTTP_TOKEN` in `docker/.env` (recreate container) and the `Authorization: Bearer` header in `claude mcp add`.

If your client shares the host's network (stdio `docker exec`, or loopback HTTP), no public endpoint is needed.

## Cosmetic / ergonomics

- ~~**`session_new` can't create a *different* session id**~~ **Resolved (v1.4.0).** `session_new` still only opens a page in the connection's own session (its description now says so), but `session_attach` (v1.4.0) covers switching to — or creating — a session by id or title, with untrusted ids validated by `assertSafeSessionId()`.
- **Benign "intercept client detach failed" warning** logged on every page close. `InterceptionEngine.detach` awaits `client.detach()` inside a try/catch; when the page is already closed it logs a warning. Harmless (caught), but noisy — could check page-closed state first and skip the detach.

## Notes

- Under heavy host load, `tsc` builds can exceed a 10-min wrapper timeout; run `tsc` standalone (not via the combined `pnpm build`) and retry. Not a project issue.
