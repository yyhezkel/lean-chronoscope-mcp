# lean-chronoscope-mcp — Implementation Plan

> **State: v1.3.0** — M0–M6 shipped plus the session-lifecycle layer (persistent
> `registry.sqlite`, correct size accounting, and the background reaper for
> idle/size eviction + row pruning + hourly age-retention). Sections below that
> were originally written as "planned" for the registry and retention are now
> **implemented** — see the notes inline.

## Context

A long-running headless-Chrome MCP server in Docker for **live debugging of web applications**: full user simulation (click/type/mouse/scroll) + capture of console/network/exceptions + IndexedDB/localStorage/cookies + JS evaluate + screenshots + network mocking. Designed to be shared across multiple MCP clients on the same host.

**הבעיה:** Playwright MCP ו-Chrome DevTools MCP הקיימים שורפים טוקנים (114K לעומת 27K לאותה משימה דרך CLI), חסרים IndexedDB tools, חסרים Network interception, וחסר Live event subscriptions אמיתי. השניהם מסננים בזמן capture - גישה שמאבדת היסטוריה.

**הגישה החדשה:**
1. **Capture-all-query-on-read**: ה-daemon לוכד firehose של CDP events ל-SQLite, ה-tools הם queries מעל ה-store.
2. **stdio + daemon split**: MCP server קצר חיים פר-Claude-session, daemon ארוך חיים שיש לו Chrome ו-SQLite. הדפדפן שורד בין שיחות.
3. **3-mode secret redaction**: `all` / `external` (מסתיר רק third-party, מציג localhost/server/trusted) / `none`.
4. **Consecutive grouping בשכבת ההצגה**, לא ב-capture - תמיד אפשר לקבל הכל.
5. **List → Get pattern**, ring buffer של 3 navigations, save-to-disk לbloבים, UID-based element targeting - patterns מוכחים מהריפוז הקיימים.
6. **Live MCP resources** עם push notifications (`resources/updated`) - חור אמיתי בשני הריפוז הקיימים.

---

## Architecture

```
                      ┌──────────────────────────────────────────────────────┐
                      │  Docker container: lean-chronoscope-mcp              │
   Claude Code        │   ┌────────────────┐   Unix socket    ┌──────────┐  │
   (server/SSH'd)  ───┼──►│  mcp-server    │  NDJSON JSON-RPC │ daemon   │  │
   stdio MCP          │   │  (per session) │ ◄───────────────►│ (single) │  │
                      │   │  - tools       │                  │ - Chrome │  │
                      │   │  - resources   │                  │ - CDP    │  │
                      │   │  - response    │                  │ - SQLite │  │
                      │   │    builder     │                  │   writer │  │
                      │   │  - redaction   │                  │ - inter- │  │
                      │   └────────────────┘                  │   ceptor │  │
                      │           │                           └──────────┘  │
                      │           ▼                                 │       │
                      │   /var/lib/lean-chronoscope/sessions/<id>/db.sqlite │
                      │                                  /blobs/<sha256>   │
                      └──────────────────────────────────────────────────────┘
```

**Stack:**
- **Language:** TypeScript (Node 22, ES2022, strict).
- **Driver:** `puppeteer-core` over CDP pipe (`pipe: true`).
- **SDK:** `@modelcontextprotocol/sdk` ^1.29.
- **DB:** `better-sqlite3` (sync, fast, no await in hot paths).
- **Schema:** zod.
- **Logging:** pino → `/var/log/lean-chronoscope/lean-chronoscope.log`.

**Why daemon split:** הדפדפן הוא ה-long-lived asset, לא ה-MCP. session ארוך-חיים שורד restart של Claude, מסך כחול של קלינט, חיבור מחדש למחר. Mirrors `chrome-devtools-mcp/src/daemon/` אבל הופך את הכיוון: שם ה-daemon מפעיל child stdio MCP; אצלנו ה-MCP server הוא לקוח של ה-daemon.

---

## Repository structure

חדש ב-`/home/runner/browser-mcp/`:

```
lean-chronoscope-mcp/
├── package.json                      # pnpm, Node 22, puppeteer-core, mcp sdk, better-sqlite3
├── tsconfig.json                     # strict, NodeNext, paths: @shared @daemon @mcp
├── docker/
│   ├── Dockerfile                    # multi-stage; installs google-chrome-stable
│   ├── docker-compose.yml            # one service, named volumes, 127.0.0.1 only
│   ├── entrypoint.sh                 # exec node daemon (PID 1)
│   └── healthcheck.sh
├── src/
│   ├── shared/
│   │   ├── protocol.ts               # DaemonRequest/Response/Notification types
│   │   ├── ids.ts                    # uid/sessionId/pageId generators
│   │   ├── paths.ts                  # getSessionDir, getBlobPath, getSocketPath
│   │   ├── logger.ts                 # pino, never stdout
│   │   ├── errors.ts
│   │   └── redact.ts                 # 3-mode redaction + trusted domains
│   ├── daemon/
│   │   ├── index.ts                  # entrypoint
│   │   ├── socket-server.ts          # node:net NDJSON server
│   │   ├── rpc-handlers.ts           # one fn per DaemonMethod
│   │   ├── session-registry.ts
│   │   ├── browser.ts                # puppeteer launch/connect, pipe
│   │   ├── page-manager.ts
│   │   ├── collectors/
│   │   │   ├── PageCollector.ts      # ring buffer last 3 navs, stable IDs
│   │   │   ├── ConsoleCollector.ts   # page.on('console') + Runtime.exceptionThrown
│   │   │   ├── NetworkCollector.ts
│   │   │   └── StorageCollector.ts
│   │   ├── snapshot/
│   │   │   ├── TextSnapshot.ts       # aria tree + UID map (loaderId_backendNodeId)
│   │   │   ├── uid-map.ts            # + semantic-anchor fallback
│   │   │   └── diff.ts               # compact patch format
│   │   ├── intercept/
│   │   │   ├── manager.ts            # Fetch.enable, rule store, dispatcher
│   │   │   └── rules.ts
│   │   ├── storage/
│   │   │   ├── db.ts                 # better-sqlite3 bootstrap, WAL, migrations
│   │   │   ├── writer.ts             # insertEvent/Network/Console (sync, no await)
│   │   │   ├── reader.ts             # paginated queries
│   │   │   ├── blobs.ts              # content-addressed sha256 store
│   │   │   ├── registry.ts           # /var/lib/lean-chronoscope/registry.sqlite (implemented)
│   │   │   └── migrations/001_initial.sql
│   │   ├── live/
│   │   │   ├── broadcaster.ts        # per-session EventEmitter
│   │   │   └── subscriptions.ts
│   │   ├── cdp/
│   │   │   ├── exceptions.ts         # session.on('Runtime.exceptionThrown')
│   │   │   ├── indexeddb.ts          # IndexedDB.* wrappers
│   │   │   └── storage-keys.ts       # Storage.* wrappers
│   │   └── supervisor.ts             # Chrome crash recovery w/ backoff
│   ├── mcp/
│   │   ├── index.ts                  # entrypoint (CLI: --session, --slim, --redact)
│   │   ├── server.ts                 # MCP SDK Server, tool registration
│   │   ├── daemon-client.ts          # unix socket NDJSON client + reconnect
│   │   ├── mutex.ts                  # serializes tool calls per session
│   │   ├── response/
│   │   │   ├── McpResponse.ts        # sectioned text + structuredContent
│   │   │   ├── SlimMcpResponse.ts    # responseLines.join('\n')
│   │   │   ├── sections.ts
│   │   │   └── change-detect.ts      # skip headers if unchanged
│   │   ├── formatters/
│   │   │   ├── NetworkFormatter.ts   # 10KB cap + blob spill
│   │   │   ├── ConsoleFormatter.ts   # groupConsecutive (display layer)
│   │   │   ├── SnapshotFormatter.ts
│   │   │   └── DiffFormatter.ts
│   │   ├── tools/                    # see "Tools" section
│   │   ├── resources/                # MCP resources/* handlers
│   │   ├── redaction.ts              # applies shared/redact.ts policy
│   │   └── pagination.ts             # paginate<T>({pageSize:20, pageIdx:0})
│   └── bin/
│       ├── daemon.ts
│       └── mcp.ts
├── tests/                            # vitest: unit + integration + e2e
└── docs/
    ├── ONBOARDING.md
    ├── tools.md                      # generated
    └── resources.md
```

---

## Daemon ↔ MCP wire protocol

**Choice: Unix domain socket + NDJSON + JSON-RPC 2.0** ב-`/run/lean-chronoscope/daemon.sock`.

נדחו: HTTP+SSE (overkill, buffering hurts latency), TCP (Unix sockets זול יותר), gRPC (protoc/codegen ללא יתרון בשפה אחת בקונטיינר), binary custom (premature).

**שורה אחת JSON לכל הודעה.** הוצאות:
1. Sync RPCs מקבוצת `DaemonMethod` (request/response עם `id` תואם).
2. Push notifications (`event.console`, `event.network.request`, `event.exception`, ...) - ה-mcp-server מתרגם ל-`notifications/resources/updated`.

החיבור **נשאר פתוח** (chrome-devtools-mcp סוגר אחרי כל message - אנחנו לא, כדי לאפשר multiplex + async notifications).

```ts
// src/shared/protocol.ts
export interface DaemonRequest { jsonrpc: "2.0"; id: number; method: DaemonMethod; params: any }
export interface DaemonResponse { jsonrpc: "2.0"; id: number; result?: any; error?: {code,message,data?} }
export interface DaemonNotification { jsonrpc: "2.0"; method: DaemonNotificationMethod; params: any }
```

---

## SQLite schema (per session)

`/var/lib/lean-chronoscope/sessions/<id>/db.sqlite`, WAL mode.

Tables: `meta`, `pages`, `navigations`, `console_messages`, `network_requests`, `snapshots`, `snapshot_nodes`, `exceptions`, `storage_events`, `intercept_rules`, `evaluations`.

מפתחות חשובים:
- כל אירוע מאוחסן עם `page_id`, `nav_id`, `ts` (epoch ms).
- Bodies <10KB inline (`req_body_text`/`res_body_text`); >10KB נשמרים ב-`blobs/<sha256>.bin` והעמודה מחזיקה את ה-sha256.
- Indexes: `(page_id, ts DESC)` בכל טבלת events. `request_id`, `url`, `status` ל-network.
- Snapshots עם `parent_id` לdiff base.
- `intercept_rules` עם `pattern`, `action`, `hits`, `active`.

**Global registry (implemented, v1.3.0):** a persistent cross-session index at
`/var/lib/lean-chronoscope/registry.sqlite` with a `sessions` table:
`id, created_at, last_activity, status (open/closed), source (stdio/http),
page_count, size_bytes, closed_at, data_dir`. It survives daemon restarts and is
reconciled at boot — orphaned `open` rows flip to `closed`, and on-disk session
dirs are re-indexed. `session_list` reads it (with an `includeClosed` param to
surface closed sessions) and reports per-session `lastActivity`, `sizeBytes`
(db+wal+shm+blobs), `status`, and `source`; `daemon_status` reports the same
accounting plus a `dbBytes`/`blobBytes` breakdown. (The `sizeBytes` fix was a bug
correction — previously only `db.sqlite` was counted; the old `totalRevisions`
field was removed.)

**Retention & reaper (implemented, v1.3.0):** a background reaper runs on a timer
(`setInterval`, `LEAN_CHRONOSCOPE_REAPER_INTERVAL_MS`, default 60000, `0` disables)
and each tick:
- flushes size stats to the registry and prunes old registry rows;
- **evicts** sessions idle past `LEAN_CHRONOSCOPE_IDLE_MS` (default 30min) or over
  `LEAN_CHRONOSCOPE_SIZE_CAP_BYTES` (default 500MB, `0` disables) — eviction frees
  the `BrowserContext` + memory but leaves the on-disk dir for the age sweep;
- **prunes rows** (count-based, bounds in-session growth): keeps the newest
  `LEAN_CHRONOSCOPE_MAX_CONSOLE` (50k) console rows, `LEAN_CHRONOSCOPE_MAX_NETWORK`
  (50k) network rows, and `LEAN_CHRONOSCOPE_MAX_SNAPSHOTS_PER_PAGE` (10) snapshots
  per page; FTS stays in sync via triggers and freed pages are reclaimed with
  `incremental_vacuum` (session DBs open with `auto_vacuum=INCREMENTAL`);
- runs the **age-retention sweep** (`LEAN_CHRONOSCOPE_RETENTION_DAYS`, default 7)
  ~hourly — not only at daemon boot — removing old session dirs and keeping the
  registry in sync.

Clean close: sessions run `PRAGMA wal_checkpoint(TRUNCATE)` before closing so the
persisted `db.sqlite` is complete/compact; DBs also set `wal_autocheckpoint=1000`
and `journal_size_limit=64MB`. docker-compose sets `stop_grace_period: 30s` so
in-flight sessions checkpoint before SIGKILL.

Migration: `src/daemon/storage/migrations/001_initial.sql`.

---

## Tools (v1, ~47 tools)

קטגוריות + הטולים העיקריים. כולם מקבלים `sessionId` מ-CLI args; page-scoped מקבלים `pageId?` (ברירת מחדל: selected). Response: `{content:[{type:"text",text}], structuredContent?}`.

| Category | Tools |
|---|---|
| **session** (4) | `session_list`, `session_new`, `session_attach`, `session_close` |
| **pages** (8) | `page_list`, `page_new`, `page_select`, `page_close`, `page_navigate`, `page_back`, `page_forward`, `page_reload` |
| **input** (8) | `click(uid)`, `hover(uid)`, `type(uid,text)`, `fill_form(fields[])`, `drag(from,to)`, `key("Ctrl+Enter")`, `scroll`, `upload_file(uid,paths)` |
| **snapshot** (3) | `snapshot_take`, `snapshot_diff`, `wait_for` |
| **screenshot** (1) | `screenshot_take` (auto-saves to blob if >2MB, rescales to 1568px/1.15MP) |
| **console** (2) | `console_list`, `console_get` |
| **network** (3) | `network_list`, `network_get(part)`, `network_wait_for` |
| **intercept** (3) | `intercept_add`, `intercept_list`, `intercept_remove` |
| **storage** (10) | cookies_*, localStorage_*, sessionStorage_*, indexeddb_list_databases, indexeddb_query, indexeddb_clear |
| **script** (1) | `script_evaluate` |
| **emulation** (4) | `emulate_viewport`, `emulate_useragent`, `emulate_network`, `emulate_geolocation` |

**Slim mode** (`--slim`): מצמצם ל-5 כלים בלבד: `page_navigate`, `snapshot_take`, `screenshot_take`, `click`, `script_evaluate`. Response class מינימלי.

כל פעולת input מחזירה `addCode` channel - שורת ה-Puppeteer המקבילה - כדי שה-LLM יוכל להרכיב סקריפט בסוף.

---

## Live MCP resources

URI scheme: `browser://`. ה-mcp-server מצהיר עליהם, subscriptions עוברות דרך ה-socket של ה-daemon. Debounce 200ms פר משאב.

| URI | Update trigger |
|---|---|
| `browser://sessions` | session create/close |
| `browser://session/{sid}/pages` | page open/close/navigate |
| `browser://session/{sid}/page/{pid}/snapshot/latest` | new snapshot taken |
| `browser://session/{sid}/page/{pid}/console/live` | new console message (debounced) |
| `browser://session/{sid}/page/{pid}/network/live` | request completed (debounced) |
| `browser://session/{sid}/page/{pid}/url` | `Page.frameNavigated` |
| `browser://session/{sid}/page/{pid}/exceptions/live` | `Runtime.exceptionThrown` |
| `browser://session/{sid}/intercept/rules` | rule add/remove |
| `browser://docs/tools` | static (auto-generated from schemas) |

---

## Docker deployment

**Dockerfile** (multi-stage, `node:22-bookworm-slim` build + runtime, מתקין `google-chrome-stable` עם apt). Non-root user `mcp:1500`. Env vars: `CHROME_BIN`, `LEAN_CHRONOSCOPE_DATA_DIR`, `LEAN_CHRONOSCOPE_SOCKET` (legacy `BROWSER_MCP_*` names still honored).

**docker-compose.yml**: service אחד, `shm_size: 2g`, named volumes ל-data/run/log, port 8780 על `127.0.0.1` בלבד (לא רלוונטי ל-v1 - שמור ל-HTTP bridge ב-M4).

**איך Claude מתחבר (v1):**
```json
// ~/.claude/mcp.json
{
  "mcpServers": {
    "lean-chronoscope": {
      "command": "docker",
      "args": ["exec", "-i", "lean-chronoscope-mcp",
               "node", "/app/dist/bin/mcp.js",
               "--session", "${CLAUDE_SESSION_ID:-default}",
               "--daemon-socket", "/run/lean-chronoscope/daemon.sock"]
    }
  }
}
```

`docker exec -i` נותן stdio pipe לתוך mcp-server חדש בקונטיינר, שמתחבר ל-daemon. **בלי host ports, בלי auth** (יש כבר SSH על השרת). מ-laptop של המשתמש - אותו דבר דרך `ssh user@<your-server-ip> docker exec -i ...`.

HTTP+SSE bridge עם bearer token - אופציונלי ב-M4.

---

## Phasing

| M | Duration | Deliverables |
|---|---|---|
| **M0 — Walking skeleton** | ½w | Repo, Dockerfile builds, daemon launches Chrome, socket alive, one E2E RPC (`status`), one tool (`page_navigate`+`screenshot_take`) without SQLite. Smoke from Claude. |
| **M1 — Storage + collectors + capture** | 1w | SQLite schema, ConsoleCollector + NetworkCollector + ExceptionCollector write-through, `console_list/get`, `network_list/get`, pagination, 10KB cap + blob spill, ring buffer last 3 navs, snapshot+UID, all input tools, `addCode`. |
| **M2 — Live MCP resources** | 1w | Daemon broadcaster, mcp-server resource handlers, push `resources/updated`, debouncing, consecutive grouping at display, tab-header diff. |
| **M3 — Storage + interception + emulation** | 1w | Cookies/localStorage/sessionStorage/IndexedDB tools, Fetch.enable interception (abort/continue/respond, one-shot/persistent), emulation tools, full 3-mode redaction + trusted domains. |
| **M4 — Multi-session + polish** | 1w | Multiple concurrent Claude sessions on different browser contexts, session resume on container restart, optional HTTP+SSE bridge w/ bearer token, slim mode, image rescaling, log rotation, retention sweep, onboarding docs for flow/club/chatbot/FOR. |
| **M5 — Diff + screencast + perf** | 1w | Real `snapshot_diff` (compact patch), `screencast` as MCP resource (2fps JPEGs), `Performance.metrics` exposed, FTS5 search on console/network. |
| **M6 — Hardening** | ½–1w | Chrome crash recovery, SQLite backpressure, metrics endpoint, full e2e tests, security audit, v1.0 stamp. |

---

## Open risks (validate during M1)

1. **Chrome headless בdocker stability** - `--no-sandbox` + `shm_size: 2g`. בדיקה תחת עומס (2+ pages, 30+ דקות).
2. **puppeteer-core pipe reliability long-running** - supervisor חייב לתפוס "Connection closed" ו-restart בלי לאבד collectors.
3. **`Fetch.enable` × `Network.enable`** - שניהם פעילים בו-זמנית - לאמת שעדיין מקבלים `responseReceived` מלא.
4. **UID stability across reload** - `loaderId_backendNodeId` מאבד תוקף ב-reload. fallback של semantic anchor (role+name+ancestry hash) - לאמת 80%+ success.
5. **SQLite write throughput** - SPA כבד יכול לשלוח 2k events/s ב-first paint. better-sqlite3 sync יעמוד? לאמת עם stress fixture.
6. **Multiple sessions × Chrome process** - `browser.createBrowserContext()` פר session ל-cookie isolation, או user-data-dir פר session? להחליט ב-M0.
7. **docker exec -i stdio** - pino logs חייבים ל-file בלבד, אסור לזהם stdout (פורמט MCP).
8. **Blob path leakage** - tool שמחזיר path של `/var/lib/...` - להוסיף `--blob-host-prefix` שמתרגם ל-host path אם Claude רץ host-side.
9. **Re-attach across Claude sessions** - האם Claude שולח אותו session ID בהמשך שיחה? אם לא - `session_attach` לפי title (M4).
10. **Secret redaction false negatives ב-`external`** - URL host vs JSON body שמכיל URLs - לבדוק עם fixture של תגובות אמיתיות.

---

## Critical files

קבצים שייכתבו (סדר M0→M2):

| File | Purpose |
|---|---|
| `src/shared/protocol.ts` | DaemonRequest/Response/Notification types - הבסיס לכל wire |
| `src/shared/redact.ts` | 3-mode policy implementation |
| `src/daemon/index.ts` | daemon entrypoint, socket bind, supervisor |
| `src/daemon/browser.ts` | puppeteer launch with pipe + flags |
| `src/daemon/session-registry.ts` | sessions map, browserContext per session |
| `src/daemon/socket-server.ts` | node:net NDJSON server, dispatch |
| `src/daemon/storage/db.ts` | better-sqlite3, schema bootstrap |
| `src/daemon/storage/migrations/001_initial.sql` | full schema |
| `src/daemon/storage/blobs.ts` | content-addressed sha256 store |
| `src/daemon/collectors/PageCollector.ts` | ring buffer of last 3 navs (port pattern) |
| `src/daemon/collectors/ConsoleCollector.ts` | + `Runtime.exceptionThrown` direct CDP |
| `src/daemon/collectors/NetworkCollector.ts` | request/response/failed + body capture |
| `src/daemon/snapshot/TextSnapshot.ts` | aria + uid map |
| `src/mcp/index.ts` | mcp-server entrypoint |
| `src/mcp/server.ts` | MCP SDK bootstrap + tool registration |
| `src/mcp/daemon-client.ts` | NDJSON client + reconnect |
| `src/mcp/tools/ToolDefinition.ts` | `defineTool`, `definePageTool`, zod schema |
| `src/mcp/response/McpResponse.ts` | sectioned text + structuredContent |
| `src/mcp/formatters/ConsoleFormatter.ts` | groupConsecutive |
| `src/mcp/formatters/NetworkFormatter.ts` | 10KB cap + blob spill |
| `docker/Dockerfile` | build + runtime stages |
| `docker/docker-compose.yml` | service definition |
| `docker/entrypoint.sh` | exec daemon as PID 1 |

קבצי reference לקריאה לפני implementation:

| Reference | Pattern to port |
|---|---|
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/daemon/daemon.ts` | daemon process model |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/daemon/client.ts` | socket client w/ reconnect |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/PageCollector.ts` | ring buffer + stable IDs + `_client()` subscription |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/McpPage.ts` | per-page state, uid map |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/McpContext.ts` | context model |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/Mutex.ts` | per-session mutex |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/TextSnapshot.ts` | aria + loaderId_backendNodeId UID |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/SlimMcpResponse.ts` | minimal response class |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/ToolHandler.ts` | mutex wrap + schema validation |
| `/home/runner/research/browser-mcp/chrome-devtools-mcp/src/tools/ToolDefinition.ts` | defineTool / definePageTool shape |
| `/home/runner/research/browser-mcp/playwright-monorepo/packages/playwright-core/src/tools/backend/response.ts` | section builder + change detection + secret redaction |
| `/home/runner/research/browser-mcp/playwright-monorepo/packages/playwright-core/src/tools/backend/snapshot.ts` | snapshot redirect-to-file pattern |
| `/home/runner/research/browser-mcp/playwright-monorepo/packages/playwright-core/src/tools/backend/screenshot.ts:75` | `scaleImageToFitMessage` (Claude vision envelope) |
| `/home/runner/research/browser-mcp/COMPARISON.md` | full architectural comparison |

---

## Verification

איך לבדוק end-to-end לאחר כל milestone:

**M0 (Walking skeleton):**
- `cd /home/runner/browser-mcp && docker compose up --build -d`
- `docker compose ps` → `lean-chronoscope-mcp` healthy
- `docker exec lean-chronoscope-mcp ls /run/lean-chronoscope/daemon.sock` → קיים
- `docker exec -i lean-chronoscope-mcp node /app/dist/bin/mcp.js --session test < <(echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}')` → תגובה תקינה
- ב-Claude Code (קונפיג mcp.json מעודכן): `Use the browser MCP to navigate to https://example.com and screenshot` → תמונה חוזרת

**M1 (Storage + capture):**
- Navigate to a local dev server, perform 5 UI actions, then:
- `docker exec lean-chronoscope-mcp sqlite3 /var/lib/lean-chronoscope/sessions/test/db.sqlite 'SELECT count(*) FROM console_messages'` → >0
- `Use console_list` ב-Claude → מחזיר עם reqid+pagination
- `Use console_get` עם reqid → stack מלא
- בלאסטית: navigate ל-page heavy (gmail/youtube) ל-30 שניות → אין SQLite contention/crash
- `snapshot_take` → UIDs יציבים. עוד `click` עם uid → עובד.
- `snapshot_diff` בין שני snapshots → diff קומפקטי

**M2 (Live resources):**
- ב-Claude: `Subscribe to browser://session/test/page/p_1/console/live`
- בvolume אחר: `docker exec lean-chronoscope-mcp node -e 'fetch("...")'` שמדפיס ל-console
- Claude מקבל `notifications/resources/updated` מיד (debounced 200ms)

**M3 (Interception + storage):**
- `intercept_add` עם pattern `/api/users` action=respond status=500 → navigate → ראה שהאפליקציה מטפלת ב-500
- `indexeddb_list_databases` באפליקציה שמשתמשת ב-IndexedDB → מחזיר schema
- `indexeddb_query` → records מ-store
- Redaction: `--redact-secrets external --trusted-domains <your-server-ip>` → קריאה ל-localhost מציגה Authorization, קריאה ל-Stripe מסתירה

**M4 (Multi-session):**
- שני terminals של Claude Code עם `CLAUDE_SESSION_ID=a` ו-`=b`
- כל אחד מנווט לפרויקט אחר → לא משפיעים זה על זה (cookie/storage isolation דרך `createBrowserContext`)
- `docker compose restart lean-chronoscope-mcp` → `session_attach a` → דף עדיין שם, history של console נשמרת

**M5+:**
- `snapshot_diff` חוזר על form-fill ארוך → טוקנים פר call יורדים ב-≥10x מול snapshot_take מלא
- FTS: `console_search "error"` → תוצאות תוך <100ms גם על session עם 50k messages

**Stress test (M6):**
- Script שפותח 10 sessions במקביל, כל אחד מנווט לאפליקציות שונות וצובר 5min של פעילות → daemon נשאר חי, SQLite לא נופל, Chrome processes לא דולפים זיכרון

**Smoke לפני v1.0:**
- חיבור MCP מ-Claude Code, ביצוע flow מלא של דיבוג: navigate → snapshot → click → fill_form → console_list → network_get (request body של ה-API שנשלח) → intercept_add (mock response) → reload → verify → screenshot. אם זה עובד חלק וצורך <30K טוקנים סה"כ - v1.
