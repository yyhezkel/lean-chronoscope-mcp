# Tests

All tests are end-to-end against a running `browser-mcp` Docker container (real daemon, real Chromium, real CDP). No mocks.

**Per-tool coverage:** [`scripts/test-all-tools.mjs`](../scripts/test-all-tools.mjs) exercises **all 56 tools** over one shared session and prints a checkbox/PASS-FAIL matrix; the per-tool checklist lives in [`TOOL_TESTS.md`](TOOL_TESTS.md). The milestone smokes below remain as feature/regression tests.

| Test | Milestone | Asserts | Transport |
|---|---|---|---|
| `scripts/test-all-tools.mjs` | all | every one of the 56 tools, in dependency order, one session, session closed at end | stdio |
| `scripts/smoke-test-m1.mjs` | M1 | page_navigate + screenshot + console_list + network_list capture + bodies | stdio (host → `docker exec`) |
| `scripts/smoke-test-m2.mjs` | M2 | `resources.list/read/subscribe/unsubscribe` + `resource.updated` notifications | daemon Unix socket (in-container) |
| `scripts/smoke-test-m2-collectors.mjs` | M2 | console / network / snapshot / url emit live updates; 5× console collapses to 1 (debounce) | daemon Unix socket (in-container) |
| `scripts/smoke-test-m2-mcp.mjs` | M2 | MCP `resources/list/read/subscribe` + `notifications/resources/updated` + `resources/list_changed` on new page | stdio |
| `scripts/smoke-test-m2-changes.mjs` | M2.5 | change-detect collapses identical sections to "(unchanged since rev N)"; migration 002 applied | stdio |
| `scripts/smoke-test-m3.mjs` | M3 | cookies + localStorage + IndexedDB + interception (respond) + emulation (viewport/UA/network/geo) + redaction (Authorization stripped for external hosts) | stdio |
| `scripts/smoke-test-m5m6.mjs` | M5/M6 | tool registry + snapshot_diff + performance_metrics + console/network FTS5 search + daemon_status + screenshot rescaling cap | stdio |
| `scripts/smoke-test-v11.mjs` | v1.1 | script_evaluate + page lifecycle + session lifecycle + wait_for + network_wait_for + upload_file registration | stdio |

## Run all

```bash
node scripts/test-all-tools.mjs          # all 56 tools (one session)
docker cp scripts/smoke-test-m2.mjs browser-mcp:/tmp/m2.mjs
docker cp scripts/smoke-test-m2-collectors.mjs browser-mcp:/tmp/m2c.mjs
node scripts/smoke-test-m1.mjs
docker exec -i browser-mcp node /tmp/m2.mjs
docker exec -i browser-mcp node /tmp/m2c.mjs
node scripts/smoke-test-m2-mcp.mjs
node scripts/smoke-test-m2-changes.mjs
node scripts/smoke-test-m3.mjs
node scripts/smoke-test-m5m6.mjs
node scripts/smoke-test-v11.mjs
```

Each script exits 0 on PASS, non-zero on FAIL. Append the run to `docs/TEST_LOG.md`.
