# PROGRESS

## Current
- **v1.7.0 released and deployed** (tag `v1.7.0`, production container rebuilt 2026-10-19). Nothing in flight.
- Open items: none — every entry in [`docs/FOLLOWUPS.md`](docs/FOLLOWUPS.md) is resolved.

## Log

### 2026-10-19 — v1.7.0: close all FOLLOWUPS
Started from an external issue report ("shared `default` session is never reaped").
- **v1.6.x fix (`4d96ba7`):** passive RPCs (`session.ensure`, status, resources.*) no longer
  refresh the idle timer; the HTTP bridge refcounts transports per daemon session; shutdown
  bounded to 20s; compose `cpus: "2"`. The report's claim that plain HTTP shares `default`
  was wrong (no `x-lc-session` → random id); the rest was confirmed.
- **v1.7.0** (3 waves of parallel subagents + 2 code-review rounds, 13 + 5 findings fixed):
  - Output redaction for URLs/headers/bodies/console in text **and** `structuredContent`
    (incl. `network_get` structured leak, page URLs, `performance_metrics`, presigned/OAuth/jsessionid params).
  - Default nav scope includes the document request (loader-id match); same-document navs deduped;
    quiet intercept detach.
  - HTTP bridge: constant-time auth, 4 MiB body cap, split rate buckets, session cap, idle sweep
    for dead clients, 404 on stale session, optional TLS, fail-closed env parsing; one daemon
    connection per HTTP session.
  - Per-session lock for mutating RPCs + locked-op timeout (`LOCKED_OP_TIMEOUT_MS`, 60s);
    page reaper (`PAGE_IDLE_MS` 15m, `MAX_PAGES_PER_SESSION` 20); `ensure()` dedupe.
  - In-process Chrome relaunch (daemon survives a Chrome crash; sessions rebound).
  - Screencast MCP resource (`browser://session/{sid}/page/{pid}/screencast`, ~2fps JPEG).
- **Verification (post-merge, main `59edfd4`):** typecheck/build OK · vitest 26/26 ·
  test-all-tools 58/58 · smoke lifecycle/screencast/relaunch/m2-mcp/http-bridge all PASS ·
  real Claude Code over HTTP OK · `docker stop` exit 0. Production: healthy, v1.7.0,
  live navigate + `daemon_status` OK, 0 error log lines.
- **Not exercised:** relaunch fallback when all 3 attempts fail; Claude Code's re-init on a 404
  (not reached in practice — it keeps an SSE stream open).
- **Behavior changes to know:** `HTTP_RATE_PER_MIN` now default 60 and counts failed auth only;
  non-selected, unwatched pages close after 15 min idle.

### 2026-07-16 — v1.6.0
Multi-script fonts (Noto baked in), `fonts_list` tool, font-watch auto-reload.

### 2026-07-12 — v1.3.0 / v1.4.0
Rename to lean-chronoscope-mcp; session lifecycle, registry & DB retention; `session_attach`
(reuse by id/title); dedup-safe blob GC.

### 2026-06-02 — v1.2.0
Initial public release.
