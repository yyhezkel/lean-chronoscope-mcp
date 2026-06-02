# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project adheres to
[semver](https://semver.org/).

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
