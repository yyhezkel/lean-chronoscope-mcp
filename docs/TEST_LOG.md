# Test Log

Append-only. Newest run first. Format: `## <UTC timestamp> — <suite>` then per-test PASS/FAIL.

---

## 2026-07-12T18:35Z — blob-GC + session_attach + HTTP persistence (v1.4.0)

New: dedup-safe blob-GC on prune; `session_attach` tool (by id/title, rehydrate, attach-or-create); `x-lc-session` header for HTTP session persistence; `assertSafeSessionId` path-traversal guard; `session.resolve` RPC; `title` on registry + `session_list`.

Rebuilt `lean-chronoscope-mcp:local` (v1.4.0); container healthy; registry `title` column added to the existing DB via idempotent ALTER.

- 57-tool suite (`scripts/test-all-tools.mjs`) — **57/57 PASS** (incl. new `session_attach`: attach-or-create by title, by-title reuse `created:false`, switch back by id)
- RPC layer (daemon-client): `session.resolve` by title (live + registry/closed), rehydrate closed session (`ensure` → `created:true`, reopens disk DB), path-traversal `../evil` **rejected** — **PASS**
- HTTP persistence: `initialize` with `x-lc-session: myapp` → deterministic id `myapp`; reconnect with same header → same session; no-header still mints random `http-*` — **PASS**
- Blob-GC (real `writer.prune()` + `blobs.sweepUnreferenced()` on a live DB with 2 blobs, `MAX_NETWORK=1`): orphaned `.bin` swept, surviving `.bin` matches the surviving row (dedup-safe) — **PASS**
- Live MCP: `session_attach({title:"live-demo"})` create → navigate on the switched session → attach again reuses it (`created:false`, page retained); `session_list` shows `title`/`source` — **PASS**

Summary: **57/57 tools + blob-GC + attach/resolve/rehydrate + HTTP-persistence + traversal-guard PASS**

---

## 2026-07-12T17:05Z — rename + session lifecycle + registry + DB retention (v1.3.0)

Full rename browser-mcp → lean-chronoscope-mcp (container/image/volumes/paths/env, `LEAN_CHRONOSCOPE_*` with legacy `BROWSER_MCP_*` fallback). New: `registry.sqlite` cross-session index, size accounting (db+wal+shm+blobs), idle+size reaper (evict-only), row pruning + VACUUM/checkpoint, clean close, HTTP-bridge leak fix.

Rebuilt image `lean-chronoscope-mcp:local`; container healthy; socket `/run/lean-chronoscope/daemon.sock`; `/health` → `{"ok":true}`.

- 56-tool suite (`scripts/test-all-tools.mjs`) — **56/56 PASS** (incl. `daemon_status v1.3.0`)
- `registry.sqlite` created; closed session recorded with `status`/`source=stdio`/`size_bytes=180340`/`page_count` — **PASS**
- Boot reconciliation: restart keeps closed row, no duplicate; orphaned 'open' → 'closed' — **PASS**
- Reaper (aggressive `IDLE_MS=4000`, `REAPER_INTERVAL_MS=3000`): abandoned session evicted, `session_list` (live) empty, row flipped `closed`, `"reaper evicting session"` logged — **PASS**
- `session_list { includeClosed:true }` unions closed registry rows — **PASS**
- HTTP-bridge leak fix: `initialize` created `http-*` session `source=http` `status=open`; DELETE/transport-close → daemon `session.close` → `status=closed` (no leak) — **PASS**

Summary: **56/56 tools + 5/5 lifecycle checks PASS**

---

## 2026-05-29T06:30Z — gateway + regression (v1.2.0)

New: `--gateway` / `BROWSER_MCP_GATEWAY=1` mode advertises 3 meta-tools (`tools_catalog`, `tool_schema`, `tools_invoke`) instead of 56; the underlying 56 stay callable by name (additive, not restrictive).

- gateway smoke (`scripts/smoke-test-gateway.mjs`) — **14/14 ✓**
- 56-tool regression in full mode (`scripts/test-all-tools.mjs`) — **56/56 PASS**

Measured `tools/list` payload by mode (browser-mcp v1.2.0):

| mode | tools | payload | tokens |
|---|---|---|---|
| full | 56 | 21,031 ch | ~5,258 |
| slim | 5 | 2,189 ch | ~547 |
| gateway | 3 | 1,284 ch | ~321 |

Note: for **Claude Code** the full-mode payload above is the *server-emitted* size; the client defers MCP tool schemas natively (only names mount, schemas fetched on demand via `ToolSearch`), so gateway is redundant there. See `docs/FOLLOWUPS.md`.

## 2026-05-28T15:40Z — all-tools suite (v1.1.1)

Every one of the 56 MCP tools exercised end-to-end over one shared session via
`scripts/test-all-tools.mjs`. Per-tool checklist: `docs/TOOL_TESTS.md`.

Summary: **56/56 PASS**

Found + fixed while building this suite:
- **page_back / page_forward reported `navigated:false` after a real navigation.**
  `pageHistory` set `navigated = resp != null`, but puppeteer resolves
  `goBack()`/`goForward()` to `null` for back-forward-cache navigations even
  though the page did navigate. Now also treats a URL change as navigation
  (`src/daemon/rpc-handlers.ts`). Verified via the script and the native MCP client.

Build/ops note (not a source bug): a stale on-disk `dist/.../migrations/001_initial.sql`
(an old copy that still carried `PRAGMA synchronous` inside the file) broke fresh
sessions with "Safety level may not be changed inside a transaction" — pragmas
must be set in `db.ts` before the migration transaction, which the source 001
already does. Fixed by a clean `rm -rf dist && pnpm build`. The deployed image is
built cleanly, so this only bit a hand-patched dist.

## 2026-05-28T08:39:21Z — all smokes (v1.1.0)

- m1            ........ PASS
- m2-socket     ........ PASS
- m2-collectors ........ PASS
- m2-mcp        ........ PASS
- m2-changes    ........ PASS
- m3            ........ PASS
- m5m6          ........ PASS
- v11           ........ PASS

Summary: **8/8 PASS**

v1.1 added: script_evaluate, page lifecycle (list/new/select/close/back/forward/reload), session lifecycle (list/new/close), wait_for, network_wait_for, upload_file (56 tools total).

Fixed this round:
- **Daemon crash on page close** — `ConsoleCollector` dispose did `void client.detach()`; the async rejection ("Session already detached") escaped as an unhandledRejection and killed the daemon. Now `.catch()`-guarded, plus daemon-level `uncaughtException`/`unhandledRejection` handlers.
- **Network responses never recorded** (latent since M1) — `requestId()` fell back to a random id per call when `_requestId` was undefined, so request-insert and response-update used different keys → status/headers stayed NULL. Now uses puppeteer 24's public `HTTPRequest.id`.

---

## 2026-05-28T07:23:16Z — all smokes (v1.0.0)

- m1            ........ PASS
- m2-socket     ........ PASS
- m2-collectors ........ PASS
- m2-mcp        ........ PASS
- m2-changes    ........ PASS
- m3            ........ PASS
- m5m6          ........ PASS

Summary: **7/7 PASS** (M4 rescaling/slim/retention/HTTP-bridge, M5 snapshot_diff/performance_metrics/FTS5 search, M6 daemon_status + v1.0 stamp)

---

## 2026-05-27T22:49:54Z — all smokes

- m1            ........ PASS
- m2-socket     ........ PASS
- m2-collectors ........ PASS
- m2-mcp        ........ PASS
- m2-changes    ........ PASS
- m3            ........ PASS

Summary: **6/6 PASS**
