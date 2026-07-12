# Token / Context Comparison — lean-chronoscope-mcp vs Playwright MCP

Head-to-head on the same pages. **All numbers below are measured** (2026-05-29):
lean-chronoscope-mcp via `node scripts/bench-tokens.mjs`; Playwright MCP (`@playwright/mcp` 0.0.70, 20 tools) via its live tools, inline outputs sized exactly. Token estimate = chars/4; the ratio is tokenizer-independent.

## Important: how each server handles the snapshot
- **lean-chronoscope-mcp** — navigate/actions return a terse status (~27 tok). You call `snapshot_take` to get a **compact, interactive-elements-only** tree inline (`[e12] link "…"`).
- **Playwright MCP (this deployment)** — navigate/actions **save the full aria snapshot to a file** (`.playwright-mcp/page-*.yml`) and return only a ~59-tok reference. `browser_snapshot` (no `filename`) returns the **full aria YAML inline** — every node incl. text content, table structure, `/url` per link, `[cursor=pointer]` flags. Richer, but ~2.8× heavier than lean-chronoscope-mcp's tree.

(An earlier draft of this doc assumed Playwright inlines the snapshot on every action ~8k tok. That's wrong for 0.0.70 — it defers to a file. Corrected with measured data.)

## Per-call, measured (chars · ~tokens)

| Call | page | lean-chronoscope-mcp | Playwright MCP |
|---|---|---|---|
| navigate | example.com | 103 · **~26** | 223 · **~55** (snapshot→file) |
| navigate | Hacker News | 109 · **~27** | 238 · **~59** (snapshot→file) |
| snapshot (inline) | example.com | 194 · **~49** | 534 · **~133** |
| snapshot (inline) | Hacker News | 21,371 · **~5,343** | 59,022 · **~14,756** |
| console (none) | Hacker News | 70 · **~18** | 54 · **~13** |
| network | Hacker News | 546 · **~137** (lists reqs) | 11 · **~2** (hides static) |
| **mount (fixed)** | — | 57 tools · **~5,350** | 20 tools · **~2,000** |

### Mount cost by lean-chronoscope-mcp mode (measured v1.2.0; full-mode figure approximated for the 57-tool v1.4.0 surface)

| Mode | tools advertised | payload | tokens |
|---|---|---|---|
| `full` (default) | 57 | ~21,400 ch | **~5,350** |
| `--slim` | 5 (page_navigate, snapshot_take, screenshot_take, click, script_evaluate) | 2,189 ch | **~547** |
| `--gateway` | 3 (`tools_catalog`, `tool_schema`, `tools_invoke`) — the 57 stay callable by name | 1,284 ch | **~321** |

**Gateway mode** advertises a 3-tool base; the model reads the catalog (~321 tok), fetches the schema only for tools it needs (`tool_schema`), and dispatches via `tools_invoke`. Reproduces client-side schema deferral for clients that don't have it. Note: for **Claude Code** the full-mode payload above is the *server* payload — the client defers schemas and only injects tool names into context at mount, so gateway is largely redundant there (and slightly worse: it loses native per-tool function-calling + arg validation). Useful for non-deferring clients and extreme token budgets.

## Per-task totals (Hacker News, a content-heavy page)

| Task | lean-chronoscope-mcp | Playwright | winner |
|---|---|---|---|
| Open + read page structure (nav + snapshot) | **~5,370** | ~14,815 | lean-chronoscope-mcp ~2.8× |
| Find + click an element (nav + snapshot + click) | **~5,410** | ~14,875 | lean-chronoscope-mcp ~2.8× |
| Fill a 3-field form (nav + snapshot + 3 fills + submit) | **~5,530** | ~15,055 | lean-chronoscope-mcp ~2.7× |
| Read console errors (nav + console) | **~45** | ~72 | ~tie (both tiny) |
| Inspect network (nav + list) | ~164 | **~61** | Playwright (but hides static → less complete) |
| Screenshot (nav + screenshot) | ~image | ~image | ~tie (both return binary) |
| **One-time mount** | ~5,258 | **~2,000** | Playwright |

## Bottom line
- **Any task that needs the accessibility tree** (the common case: read/click/fill) → lean-chronoscope-mcp is **~2.8× cheaper** on a content-heavy page, because its snapshot is compact and interactive-only vs Playwright's full aria YAML. On a trivial page the ratio holds (~49 vs ~133 tok) but absolute cost is negligible either way.
- **Console/network-only tasks** → both tiny; Playwright slightly cheaper on console, lean-chronoscope-mcp more *complete* on network (Playwright hides static by default and showed nothing for HN's non-static requests).
- **Mount** → Playwright is cheaper (20 vs 57 tools, ~2k vs ~5.3k tok). lean-chronoscope-mcp pays more upfront; `--slim` drops it to 5 tools (~600 tok).
- **Tradeoff, not strictly better:** Playwright's snapshot is *richer* (full page text + DOM structure) — handy if you need to read content; lean-chronoscope-mcp's is *leaner* (just actionable elements) — cheaper for drive-the-UI loops.

Reproduce lean-chronoscope-mcp: `node scripts/bench-tokens.mjs [url]`. Playwright side: drive the native `mcp__playwright__*` tools and size the inline responses. Qualitative format analysis: `/home/runner/research/lean-chronoscope-mcp/COMPARISON.md`.
