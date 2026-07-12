# Follow-ups

Known deferrals and rough edges, not blocking v1.4.0. Ordered roughly by value.

## Features deferred past v1.0

- **Screencast resource** (planned M5.2, cut). `Page.startScreencast` → 2fps JPEG frames exposed as `browser://session/{sid}/page/{pid}/screencast`, with `resources/updated` carrying the latest frame's blob sha. Stop the CDP screencast when no subscribers remain.
- ~~**`session_attach`** (title-based reattach).~~ **Resolved (v1.4.0).** The `session_attach` tool now points a connection at an existing session by id or by human **title** (attach-or-create when a title matches nothing), rehydrating a closed session's captured history from disk. The HTTP bridge also honors an `x-lc-session: <id>` reconnect header to return to the same session. Untrusted ids are validated by `assertSafeSessionId()` (no `/`, `\`, `..`, NUL, empty, >200 chars) to block path traversal.
- **HTTP-bridge TLS + rate limiting.** `src/mcp/http-bridge.ts` has bearer-token auth and binds loopback only; it has no built-in TLS and no rate limiting. Intended for SSH/Wireguard or behind an nginx TLS proxy. Add TLS termination options if it's ever exposed directly.
- **In-place Chrome relaunch.** On Chrome disconnect the daemon exits and Docker's restart policy reboots it (sessions' browser state is lost, SQLite survives). A nicer recovery would relaunch Chrome in-process and re-create `BrowserContext`s + collectors + intercept engines without dropping the daemon.

## Security / correctness

- **`network_list` URL redaction.** Redaction runs in `network_get` (headers + bodies) but not on `network_list` summaries. A URL with inline credentials (`https://user:pass@host`) would appear unredacted in the list. See `docs/SECURITY.md` "Known limitations".

## Robustness (found during live testing, 2026-05-28)

- **Concurrent tool calls can race.** Firing tool calls without awaiting the previous one (e.g. `page_navigate` immediately followed by `snapshot_take`) can fail with "Page not found: (no selected page)" because the snapshot runs before navigate finishes creating/selecting the page. Real MCP clients await each call, so it's fine in practice — but the daemon could serialize calls per-session (a per-session mutex, mirroring chrome-devtools-mcp's `Mutex`) to make ordering robust regardless of client behavior.
- **`network_list` is empty right after a fresh navigate.** The top-level document request fires `requestWillBeSent` before `frameNavigated` creates the nav row, so it's stored with `nav_id = NULL`. `network_list`'s default scope filters to the latest nav id and hides it. `network_wait_for` / `network_search` (no nav filter) do find it. Fix options: attribute null-nav requests to the page's newest nav at read time, or include null-nav rows in the current-nav default scope.
- ~~**Sessions accumulate; nothing closes them mid-run.**~~ **Resolved (v1.3.0).** A background **reaper** now evicts idle sessions (idle past `LEAN_CHRONOSCOPE_IDLE_MS`, default 30min) and oversized ones (`LEAN_CHRONOSCOPE_SIZE_CAP_BYTES`, default 500MB), prunes over-long console/network/snapshot rows, and runs the age-retention sweep (`LEAN_CHRONOSCOPE_RETENTION_DAYS`, default 7) ~hourly rather than only at daemon start. The HTTP bridge also closes its daemon session on client disconnect (`transport.onclose`), so BrowserContexts/SQLite no longer leak per HTTP connection. A persistent `registry.sqlite` tracks all sessions across restarts. Smokes still `session_close` when done as good hygiene, but leaked sessions are now reaped automatically.
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

- **`session_new` can't create a *different* session id** from an existing MCP connection — the session id is fixed per stdio connection by design. The tool only ensures/instantiates the connection's own session. Creating arbitrary sessions would need the daemon `session.ensure` exposed with an explicit id (intentionally not done, to avoid cross-session confusion from a single client).
- **Benign "intercept client detach failed" warning** logged on every page close. `InterceptionEngine.detach` awaits `client.detach()` inside a try/catch; when the page is already closed it logs a warning. Harmless (caught), but noisy — could check page-closed state first and skip the detach.

## Notes

- Under heavy host load, `tsc` builds can exceed a 10-min wrapper timeout; run `tsc` standalone (not via the combined `pnpm build`) and retry. Not a project issue.
