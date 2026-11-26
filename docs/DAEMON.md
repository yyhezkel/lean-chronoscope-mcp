# Daemon internals — screencast, session lifecycle, relaunch, reaper, locking

> Moved verbatim from CLAUDE.md (origin/main 3c5eca0) §"Screencast resource" and §"Session lifecycle & retention" on 2026-11-25 (CLAUDE.md trim).

## Screencast resource

Each page lists `browser://session/{sid}/page/{pid}/screencast` (`image/jpeg`).
Subscribing starts a CDP `Page.startScreencast` (JPEG q60, ≤1280px) for that page;
frames are throttled to ~2fps by delaying the frame ack, only the **latest** frame
is held (in memory — not BlobStore), and each one fires `resources/updated`. The
screencast stops when the URI's last subscriber leaves (unsubscribe or connection
drop — per-URI refcount via `SubscriptionRegistry.setUriHooks`) or the page closes
(daemon logs `screencast started` / `screencast stopped`). `resources/read` returns
an MCP `blob` content (base64 JPEG); without a live frame it captures one on demand.
Code: `src/daemon/screencast.ts`. Smoke: `scripts/smoke-test-v17-screencast.mjs`.

## Session lifecycle & retention

The daemon keeps a persistent `registry.sqlite` at `<dataDir>/registry.sqlite`
(a `sessions` table indexing every session across daemon restarts) and runs a
background **reaper** (`setInterval`) that flushes size stats to the registry,
evicts idle/oversized sessions (frees the BrowserContext + memory, leaves the
on-disk dir for the age sweep), prunes over-long console/network/snapshot tables,
and runs the age-retention sweep ~hourly. **Blob-GC (dedup-safe):**
`SessionWriter.prune()` now, right after deleting old console/network rows, sweeps
orphaned blob files — it deletes only `sessions/<id>/blobs/<sha>.bin` whose sha is
no longer referenced by ANY surviving row (content-addressed dedup is respected: a
shared blob stays while any row points to it), instead of leaving orphaned blobs
until the 7-day age sweep (`BlobStore.sweepUnreferenced(keep)` + `BlobStore.remove(sha)`).

**Chrome crash recovery (in-process relaunch):** if Chrome disconnects
unexpectedly, the daemon does NOT exit — `index.ts` relaunches Chrome in-process
with backoff (3 attempts at ~1s/3s/9s) and `RpcDispatcher.replaceBrowser()` →
`SessionRegistry.rebind()` re-points every live session at the new browser: a
fresh `BrowserContext`, old pages dropped (rows marked closed), intercept rules
kept (`InterceptionEngine.resetPages()`), per-page emulation lost; all captured
history on disk stays readable. The same MCP connection keeps working
(`page_navigate` opens a new page). While relaunching, `dispatch()` gates
browser-touching RPCs (bounded 30s wait, then a `BROWSER_DISCONNECTED` error);
passive reads/status stay answerable. `daemon_status` reports `chromeRelaunches`
+ `lastChromeRelaunchAt`. Only if all attempts fail does it fall back to exiting
for Docker to restart it. Smoke: `scripts/smoke-test-v17-relaunch.mjs`.

**Session reuse:** sessions can carry an optional `title` (a new column in
`registry.sqlite`, added via idempotent `ALTER TABLE`); the RPC
`session.resolve({title})` returns the newest active session id with that title.
The `session_attach` tool points a connection at an existing session by id or
title and rehydrates a closed session's captured history from disk (the
BrowserContext starts fresh — browser state isn't persisted — but all captured
console/network/snapshot history is readable); a title matching nothing starts a
new session carrying that title (attach-or-create). See "MCP client integration"
for the `x-lc-session` reconnect header and the `assertSafeSessionId` traversal guard.

**Page-level reaper:** each tick, in every surviving session, the reaper also
closes pages idle past `PAGE_IDLE_MS` and, beyond that, the oldest-idle pages
over `MAX_PAGES_PER_SESSION`. It never closes the selected page or a page with an
RPC in flight, skips a session whose lock is held, and closes under that lock.
Each page tracks `lastActivity`/`inFlight` (target = `pageId ?? selectedPageId`).

**Per-session serialization:** RPCs that mutate browser/page state (`page.*`
incl. evaluate, `input.*`, `emulate.*`, `intercept.add/remove`, `cookies.set/clear`,
`storage.set/remove/clear`, `indexeddb.clear`, `screenshot.take`, `snapshot.take`)
run under a per-session FIFO mutex (`Session.lock`, `src/shared/mutex.ts`;
allowlist `LOCKED_METHODS` in `rpc-handlers.ts`), so un-awaited calls (navigate →
snapshot) keep their order. `wait.for` / `network.wait_for`, read-only queries,
`session.close` and `page.close` deliberately bypass it (so a stuck page can
always be closed). Each locked op is bounded by `LOCKED_OP_TIMEOUT_MS` (60s;
navigate gets its own `timeoutMs`+5s if longer): on expiry the lock is released
and the RPC fails with TIMEOUT (-32005), but the puppeteer call may keep running
until it settles, the page navigates, or `page_close` kills it — e.g. an
`awaitPromise` evaluate that never settles, or a JS `alert`/`confirm` opened by a
click (dialogs are not auto-dismissed). The abandoned op keeps its session/page
`inFlight` guards until it actually settles (so the reaper can't close a page it
still drives; the settle is logged as `abandoned op settled`, with `ms`), and a
late-finishing `page.new` only takes the selection if nothing was `page_select`-ed
meanwhile. Because the op timeout is the hard cap, `page_navigate` with
`timeoutMs: 0` ("no navigation timeout") is still bounded by
`LOCKED_OP_TIMEOUT_MS`. An invalid value (e.g. `6O0`) logs an error once and
falls back to 60000. Queued locked RPCs re-check the Chrome
relaunch gate once they acquire the lock. `SessionRegistry.ensure` dedupes
concurrent creations of one id (in-flight promise map), so racing navigates /
HTTP initializes on a brand-new id share one Session.

Session DBs open with
`auto_vacuum=INCREMENTAL` + `wal_autocheckpoint=1000` + `journal_size_limit=64MB`,
and `wal_checkpoint(TRUNCATE)` runs on clean close so the persisted `db.sqlite`
is complete/compact (docker-compose sets `stop_grace_period: 30s` to allow it).
