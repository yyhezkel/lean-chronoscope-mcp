# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[semver](https://semver.org/).

## [1.3.0] — 2026-07-12

### Changed
- **Renamed browser-mcp → lean-chronoscope-mcp** to match the GitHub repo.
  Docker container/image/compose-service is `lean-chronoscope-mcp`; filesystem
  paths are `/var/lib/lean-chronoscope`, `/run/lean-chronoscope`,
  `/var/log/lean-chronoscope` (log file `lean-chronoscope.log`); the env prefix
  is `LEAN_CHRONOSCOPE_*`. The MCP client alias stays `lean-chronoscope`
  (`mcp__lean-chronoscope__*`). **Backward-compatible:** the legacy
  `BROWSER_MCP_*` env names are still read as a fallback (a one-time
  deprecation warning is logged at boot). Filesystem/volume paths changed, so
  existing session data in the old volumes is orphaned — a clean cutover, as
  captured session data is ephemeral.
- `daemon_status` now reports a correct `sizeBytes` (db+wal+shm+blobs) — it
  previously counted only `db.sqlite` (bug) — plus `dbBytes`/`blobBytes`
  breakdown, `lastActivity`, and `source`. The unused `totalRevisions` field
  was removed.
- `session_list` entries gained `lastActivity`, `sizeBytes`, `status`, and
  `source`; the call takes an optional `includeClosed` to also list closed
  sessions from the registry.
- Session DBs now open with `auto_vacuum=INCREMENTAL`, `wal_autocheckpoint=1000`,
  and `journal_size_limit=64MB`; `docker-compose` gained `stop_grace_period:
  30s` so in-flight sessions checkpoint before SIGKILL.

### Added
- **`registry.sqlite`** — a persistent cross-session index at
  `<dataDir>/registry.sqlite` (id, created_at, last_activity, status, source,
  page_count, size_bytes, closed_at, data_dir). Reconciled at boot: orphaned
  'open' rows → 'closed', and on-disk session dirs are indexed. Survives daemon
  restarts.
- **Idle/size reaper** — a periodic tick evicts sessions idle past
  `LEAN_CHRONOSCOPE_IDLE_MS` (default 30 min) or over
  `LEAN_CHRONOSCOPE_SIZE_CAP_BYTES` (default 500 MB, 0=off). Evict frees the
  BrowserContext + memory; the on-disk dir is left for the age sweep. Tunables:
  `LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS` (default 60000, 0 disables). The age
  sweep (`LEAN_CHRONOSCOPE_RETENTION_DAYS`, default 7) now also runs ~hourly
  from the reaper, not only at boot, and keeps the registry in sync.
- **Row pruning** to bound in-session growth (count-based): keeps newest
  `LEAN_CHRONOSCOPE_MAX_CONSOLE` (50k) / `LEAN_CHRONOSCOPE_MAX_NETWORK` (50k)
  rows and `LEAN_CHRONOSCOPE_MAX_SNAPSHOTS_PER_PAGE` (10) snapshots per page;
  FTS mirrors stay consistent via triggers; freed pages returned via
  `incremental_vacuum`.

### Fixed
- **HTTP-bridge session leak.** `transport.onclose` now calls `session.close`
  on the daemon, so BrowserContexts + SQLite + on-disk dirs no longer leak on
  client disconnect (previously they piled up until daemon restart or the
  7-day age sweep). HTTP sessions are recorded with `source='http'`.
- **Clean close.** Sessions `PRAGMA wal_checkpoint(TRUNCATE)` before closing so
  the persisted `db.sqlite` is complete and compact — an abrupt kill afterward
  loses nothing.

## [1.2.0] — 2026-05-29

### Added
- **`--gateway` / `BROWSER_MCP_GATEWAY=1` mode.** Advertises three meta-tools
  (`tools_catalog`, `tool_schema`, `tools_invoke`) instead of all 56. The 56
  stay callable by name — the model picks tools on demand and loads only the
  schemas it needs. Mount drops from ~5,258 to ~321 tokens. Server-side
  reproduction of client schema deferral, for MCP clients that don't already
  do it themselves.
- New gateway smoke (`scripts/smoke-test-gateway.mjs`, 14/14 ✓).
- Permanent token-benchmark script (`scripts/bench-tokens.mjs`).
- Token / context comparison doc (`docs/COMPARISON.md`) — measured numbers
  for `full` / `slim` / `gateway` mounts and per-task cost vs Playwright MCP.

### Changed
- Tool-list selection generalized: `selectTools(mode)` with
  `"full" | "slim" | "gateway"` (was a boolean `slim`).
- `toJsonSchemaDraft2020` extracted to `src/mcp/tools/jsonschema.ts` and shared
  by stdio + HTTP server.
- HTTP bridge now respects the same mode via `BROWSER_MCP_GATEWAY` /
  `BROWSER_MCP_SLIM` env vars.

### Fixed
- `page_back` / `page_forward` reported `navigated:false` for back-forward-cache
  navigations even though the page navigated. Now also treats a URL change as
  navigation (`src/daemon/rpc-handlers.ts`).

## [1.1.0] — 2026-05-28

### Added
- Full 56-tool surface (`script_evaluate`, page lifecycle, session lifecycle,
  `wait_for`, `network_wait_for`, `upload_file`).
- Per-tool e2e test suite (`scripts/test-all-tools.mjs`, 56/56 ✓) with
  checklist doc (`docs/TOOL_TESTS.md`).
- Slim mode (`--slim`) — 5 core tools, ~547 tok at mount.
- Optional HTTP+SSE bridge (`src/mcp/http-bridge.ts`) with bearer-token auth.

### Fixed
- Daemon crash on page close — `ConsoleCollector` dispose threw an unhandled
  rejection; now caught + daemon-level `uncaughtException`/`unhandledRejection`
  handlers.
- Network responses never recorded (latent since M1) — `requestId()` used a
  random fallback; now uses puppeteer's public `HTTPRequest.id`.

## [1.0.0] — 2026-05-28

Initial public-ready cut. Milestones M0–M6:
- M0 — walking skeleton.
- M1 — storage + collectors + capture firehose.
- M2 — live MCP resources (broadcaster + debounce + `resources/updated` +
  `resources/list_changed` + change-detect memo).
- M3 — storage (cookies / localStorage / sessionStorage / IndexedDB) +
  network interception + emulation + 3-mode secret redaction.
- M4 — retention sweep, screenshot rescaling cap, pino log rotation, HTTP+SSE
  bridge.
- M5 — `snapshot_diff`, `performance_metrics`, FTS5 console/network search.
- M6 — Chrome crash recovery, `daemon_status`, security audit.
