# Per-Tool Tests — all 56 MCP tools

One control runner exercises **every** tool end-to-end (real daemon, real
Chromium, real CDP) over a single shared session, then closes that session.

- **Run:** `node scripts/test-all-tools.mjs` (exits 0 only if all 56 PASS)
- **Control file:** [`scripts/test-all-tools.mjs`](../scripts/test-all-tools.mjs) — owns the master tool list, the simple one-line tests, and the checkbox matrix.
- **Complete-file tests** (tools needing real setup): [`scripts/tools/`](../scripts/tools/) — `input.mjs`, `network.mjs`, `indexeddb.mjs`, `intercept.mjs`, `snapshot.mjs`, `lifecycle.mjs`, plus `fixture.mjs` (serves the seed page via interception) and `harness.mjs` (shared RPC/assert/cleanup).
- **Seed fixture:** [`scripts/fixtures/tool-smoke.html`](../scripts/fixtures/tool-smoke.html) — one page giving real DOM, console logs, a fetch, storage, and an IndexedDB so most tools have something genuine to act on.

`Where`: `inline` = tested directly in the control runner; otherwise the file under `scripts/tools/`.

_Last run: **2026-05-28T15:40Z** — **56/56 PASS** (v1.1.1)._

## Session
- [x] `session_list` — lists our session — _inline_
- [x] `session_new` — opens a page in this connection's session — _lifecycle_
- [x] `session_close` — closes our own session at teardown (closed=true) — _inline_

## Pages
- [x] `page_navigate` — seed URL returns 200 — _inline_
- [x] `page_list` — ≥2 open pages — _lifecycle_
- [x] `page_new` — returns a new pageId — _lifecycle_
- [x] `page_select` — switches active page — _lifecycle_
- [x] `page_close` — closes the page — _lifecycle_
- [x] `page_back` — history back changes url (bfcache-safe) — _lifecycle_
- [x] `page_forward` — history forward changes url — _lifecycle_
- [x] `page_reload` — reloads — _lifecycle_

## Snapshot / Screenshot
- [x] `snapshot_take` — returns uid tree (12 uids) — _inline_
- [x] `snapshot_diff` — detects an added element — _snapshot_
- [x] `screenshot_take` — returns inline image + dimensions — _inline_
- [x] `wait_for` — matches visible text — _inline_

## Console
- [x] `console_list` — ≥3 captured messages — _inline_
- [x] `console_get` — full detail of one message — _inline_
- [x] `console_search` — FTS match on a log token — _inline_

## Network
- [x] `network_list` — captured requests for the host — _network_
- [x] `network_get` — headers/body of one request — _network_
- [x] `network_search` — FTS match on a URL — _network_
- [x] `network_wait_for` — waits for the seed fetch — _network_

## Input
- [x] `click` — fires onclick (verified via script) — _input_
- [x] `hover` — completes — _input_
- [x] `type` — sets the field value — _input_
- [x] `fill_form` — text + select + check in one call — _input_
- [x] `key` — Backspace edits the focused field — _input_
- [x] `scroll` — page scrollY increases — _input_
- [x] `drag` — completes from→to — _input_
- [x] `upload_file` — sets one file on the input — _input_

## Storage: Cookies
- [x] `cookies_set` — sets 2 cookies — _inline_
- [x] `cookies_list` — round-trips a cookie — _inline_
- [x] `cookies_clear` — clears by name — _inline_

## Storage: localStorage
- [x] `localStorage_set` — _inline_
- [x] `localStorage_get` — reads back the value — _inline_
- [x] `localStorage_list` — counts keys — _inline_
- [x] `localStorage_remove` — existed=true — _inline_
- [x] `localStorage_clear` — empties storage — _inline_

## Storage: sessionStorage
- [x] `sessionStorage_set` — _inline_
- [x] `sessionStorage_get` — reads back the value — _inline_
- [x] `sessionStorage_list` — counts keys — _inline_
- [x] `sessionStorage_remove` — existed=true — _inline_
- [x] `sessionStorage_clear` — empties storage — _inline_

## Storage: IndexedDB
- [x] `indexeddb_list_databases` — finds seeded `smokeDb` — _indexeddb_
- [x] `indexeddb_query` — reads 2 rows — _indexeddb_
- [x] `indexeddb_clear` — empties the store — _indexeddb_

## Intercept
- [x] `intercept_add` — adds a respond rule — _intercept_
- [x] `intercept_list` — rule appears — _intercept_
- [x] `intercept_remove` — removed=true — _intercept_

## Emulation
- [x] `emulate_viewport` — echoes set size — _inline_
- [x] `emulate_useragent` — echoes UA — _inline_
- [x] `emulate_network` — applies a preset (then restores) — _inline_
- [x] `emulate_geolocation` — override applied — _inline_

## Performance & Diagnostics
- [x] `performance_metrics` — returns Nodes/heap metrics — _inline_
- [x] `daemon_status` — version + browser connected — _inline_

## Script
- [x] `script_evaluate` — evaluates an expression — _inline_

---

After each run, append a timestamped entry to [`TEST_LOG.md`](TEST_LOG.md).
