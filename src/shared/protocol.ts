// Daemon ↔ MCP wire protocol — JSON-RPC 2.0 over Unix socket (NDJSON framing).
// M0 surface: status, page.new, page.navigate, screenshot.take. Will grow over M1+.

export type DaemonMethod =
  | "status"
  | "session.ensure"
  | "page.new"
  | "page.navigate"
  | "page.evaluate"
  | "screenshot.take"
  | "console.list"
  | "console.get"
  | "network.list"
  | "network.get"
  | "exception.list"
  | "snapshot.take"
  | "input.click"
  | "input.hover"
  | "input.type"
  | "input.fill_form"
  | "input.key"
  | "input.scroll"
  | "input.drag"
  | "snapshot.diff"
  | "performance.metrics"
  | "page.list"
  | "page.select"
  | "page.close"
  | "page.back"
  | "page.forward"
  | "page.reload"
  | "session.list"
  | "session.close"
  | "session.resolve"
  | "wait.for"
  | "network.wait_for"
  | "input.upload_file"
  | "console.search"
  | "network.search"
  | "daemon.status"
  // M2 — resource subscription wire (browser:// scheme).
  | "resources.list"
  | "resources.read"
  | "resources.subscribe"
  | "resources.unsubscribe"
  // M3 — storage / interception / emulation.
  | "cookies.list"
  | "cookies.set"
  | "cookies.clear"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "storage.clear"
  | "storage.list"
  | "indexeddb.list_databases"
  | "indexeddb.query"
  | "indexeddb.clear"
  | "intercept.add"
  | "intercept.list"
  | "intercept.remove"
  | "emulate.viewport"
  | "emulate.useragent"
  | "emulate.network"
  | "emulate.geolocation";

export type DaemonNotificationMethod =
  | "resource.updated"
  | "resource.unsubscribed";

export interface DaemonRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: DaemonMethod;
  params: P;
}

export interface DaemonResponseOk<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: R;
}

export interface DaemonResponseErr {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type DaemonResponse<R = unknown> = DaemonResponseOk<R> | DaemonResponseErr;

export interface DaemonNotification<P = unknown> {
  jsonrpc: "2.0";
  method: DaemonNotificationMethod;
  params: P;
}

export type DaemonMessage =
  | DaemonRequest
  | DaemonResponse
  | DaemonNotification;

// --- Params/Result types per method (M0) ---

export interface StatusParams {}
export interface StatusResult {
  ok: true;
  version: string;
  startedAt: number;
  browserConnected: boolean;
  sessions: number;
}

/** Where a session was created from — recorded in the registry index. */
export type SessionSource = "stdio" | "http";

/** Lifecycle status in the registry index. */
export type SessionStatus = "open" | "closed";

export interface SessionEnsureParams {
  sessionId: string;
  title?: string;
  source?: SessionSource;
}
export interface SessionEnsureResult {
  sessionId: string;
  currentPageId: string | null;
  created: boolean;
}

export interface PageNewParams {
  sessionId: string;
  url?: string;
  background?: boolean;
}
export interface PageNewResult {
  pageId: string;
  url: string;
  title: string;
}

export interface PageListParams { sessionId: string; }
export interface PageInfo {
  pageId: string;
  url: string;
  title: string;
  selected: boolean;
}
export interface PageListResult {
  pages: PageInfo[];
  selectedPageId: string | null;
}

export interface PageSelectParams { sessionId: string; pageId: string; }
export interface PageSelectResult { pageId: string; }

export interface PageCloseParams { sessionId: string; pageId?: string; }
export interface PageCloseResult { closedPageId: string; selectedPageId: string | null; }

export interface PageHistoryParams { sessionId: string; pageId?: string; }
export interface PageHistoryResult {
  pageId: string;
  url: string;
  title: string;
  /** False when there was nothing to go back/forward to. */
  navigated: boolean;
}

export interface SessionListParams {
  /** Also include closed sessions from the registry index (default: live only). */
  includeClosed?: boolean;
}
export interface SessionListEntry {
  id: string;
  title: string | null;
  createdAt: number;
  lastActivity: number;
  pageCount: number;
  selectedPageId: string | null;
  /** Total on-disk footprint: db + wal + shm + blobs. */
  sizeBytes: number;
  status: SessionStatus;
  source: SessionSource | null;
}
export interface SessionListResult {
  sessions: SessionListEntry[];
}
export interface SessionCloseParams { sessionId: string; }
export interface SessionCloseResult { sessionId: string; closed: boolean; }

export interface SessionResolveParams { title: string; }
export interface SessionResolveResult { sessionId: string | null; }

export interface PageNavigateParams {
  sessionId: string;
  pageId?: string;
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  timeoutMs?: number;
}
export interface PageNavigateResult {
  pageId: string;
  url: string;
  status: number | null;
  title: string;
  durationMs: number;
}

export interface PageEvaluateParams {
  sessionId: string;
  pageId?: string;
  expression: string;
  awaitPromise?: boolean;
  returnByValue?: boolean;
}
export interface PageEvaluateResult {
  pageId: string;
  value: unknown;
  isError: boolean;
  errorText?: string;
}

export interface ScreenshotTakeParams {
  sessionId: string;
  pageId?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  /** Cap the long side of the output image. Daemon rescales via CDP clip.scale.
   *  Default 1568px (Claude vision-friendly). Pass 0 to disable. */
  maxLongSide?: number;
}
export interface ScreenshotTakeResult {
  pageId: string;
  url: string;
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  // base64-encoded image data. M0: inline. M1: spill to blob if >2MB.
  data: string;
  bytes: number;
}

// --- Capture list/get types ---

export interface ListParams {
  sessionId: string;
  pageId?: string;
  navId?: number;
  /** Only events since this epoch ms. */
  sinceTs?: number;
  /** If true, include events from preserved navs (last 3) — not just the current/latest. */
  includePreserved?: boolean;
  pageIdx?: number;
  pageSize?: number;
}

export interface ConsoleListParams extends ListParams {
  level?: string;
}
export interface ConsoleListResult {
  total: number;
  pageIdx: number;
  pageSize: number;
  rows: Array<{
    id: number;
    pageId: string;
    navId: number | null;
    ts: number;
    level: string;
    text: string;
    source: string | null;
    url: string | null;
    line: number | null;
    col: number | null;
    hasStack: boolean;
    hasArgs: boolean;
  }>;
}
export interface ConsoleGetParams { sessionId: string; id: number; }
export interface ConsoleGetResult {
  id: number;
  pageId: string;
  ts: number;
  level: string;
  text: string;
  source: string | null;
  url: string | null;
  line: number | null;
  col: number | null;
  stack: string | null;
  args: string | null;
}

export interface NetworkListParams extends ListParams {
  resourceTypes?: string[];
  urlContains?: string;
  status?: number;
  hideStatic?: boolean;
}
export interface NetworkListResult {
  total: number;
  pageIdx: number;
  pageSize: number;
  rows: Array<{
    id: number;
    pageId: string;
    navId: number | null;
    requestId: string;
    tsRequest: number;
    tsResponse: number | null;
    tsFinished: number | null;
    method: string;
    url: string;
    resourceType: string | null;
    status: number | null;
    errorText: string | null;
    sizeResponse: number | null;
  }>;
}
export interface NetworkGetParams {
  sessionId: string;
  id: number;
  part?: "meta" | "request-body" | "response-body" | "all";
}
export interface NetworkGetResult {
  id: number;
  pageId: string;
  requestId: string;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  errorText: string | null;
  protocol: string | null;
  remoteIp: string | null;
  fromDiskCache: boolean;
  fromSvcWorker: boolean;
  sizeResponse: number | null;
  reqHeaders: Record<string, string> | null;
  resHeaders: Record<string, string> | null;
  reqBody: { text?: string; blobSha?: string };
  resBody: { text?: string; blobSha?: string };
  tsRequest: number;
  tsResponse: number | null;
  tsFinished: number | null;
}

// --- Snapshot ---

export interface SnapshotTakeParams {
  sessionId: string;
  pageId?: string;
}
export interface SnapshotTakeResult {
  pageId: string;
  url: string;
  title: string;
  loaderId: string;
  ts: number;
  uidCount: number;
  /** Pre-rendered text (cheaper than re-rendering on the MCP side). */
  text: string;
  /** Persisted snapshot row id — pass to `snapshot.diff`. */
  snapshotId: number;
}

export interface SnapshotDiffParams {
  sessionId: string;
  /** Either snapshot row ids, OR omit both to compare the latest two snapshots of the page. */
  beforeId?: number;
  afterId?: number;
  pageId?: string;
}
export interface SnapshotDiffResult {
  beforeId: number;
  afterId: number;
  beforeUrl: string;
  afterUrl: string;
  /** Pre-rendered patch text. */
  text: string;
  addedUids: number;
  removedUids: number;
  changedUids: number;
  unchangedUids: number;
}

// --- Input ---

export interface InputBase {
  sessionId: string;
  pageId?: string;
}

export interface InputActionResult {
  pageId: string;
  /** Equivalent puppeteer/JS line(s) for the action. */
  code: string[];
  navigatedTo?: string;
  durationMs: number;
}

export interface ClickParams extends InputBase {
  uid: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}
export interface HoverParams extends InputBase { uid: string; }
export interface TypeParams extends InputBase {
  uid: string;
  text: string;
  /** Per-key delay in ms. */
  delay?: number;
  /** If true, clear existing value first. Default true for text inputs. */
  clear?: boolean;
}
export interface FillFormParams extends InputBase {
  fields: Array<
    | { uid: string; kind?: "text"; value: string; clear?: boolean }
    | { uid: string; kind: "select"; value: string }
    | { uid: string; kind: "check"; value: boolean }
  >;
}
export interface KeyParams extends InputBase {
  keys: string;
}
export interface ScrollParams extends InputBase {
  uid?: string;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}
export interface DragParams extends InputBase {
  fromUid: string;
  toUid: string;
}

// --- Resources (M2) ---

export interface ResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourcesListParams {
  /** Filter to URIs belonging to this session. Global URIs are always included. */
  sessionId?: string;
}
export interface ResourcesListResult {
  resources: ResourceDescriptor[];
}

export interface ResourcesReadParams {
  uri: string;
}
export interface ResourcesReadResult {
  uri: string;
  revision: number;
  /** Resource-specific JSON payload. May be null when the resource exists but has no data yet. */
  data: unknown;
}

export interface ResourcesSubscribeParams {
  uri: string;
}
export interface ResourcesSubscribeResult {
  uri: string;
  /** Current revision at subscribe time — clients can use it to detect missed updates after resubscribe. */
  revision: number;
}

export interface ResourcesUnsubscribeParams {
  uri: string;
}
export interface ResourcesUnsubscribeResult {
  uri: string;
  removed: boolean;
}

// --- Notification payloads ---

export interface ResourceUpdatedParams {
  uri: string;
  revision: number;
  /** Optional summary so subscribers can skip a re-read when not interesting. */
  preview?: {
    kind: string;
    lastId?: number;
    lastTs?: number;
  };
}

export interface ResourceUnsubscribedParams {
  uri: string;
  reason: string;
}

// --- Storage: cookies (M3.1) ---

/**
 * Cookies live at the BrowserContext (session) level. `urls` narrows the list
 * to cookies the browser would send to those URLs (matches Page.cookies semantics).
 * Without `urls`, returns *every* cookie in the session context.
 */
export interface CookiesListParams {
  sessionId: string;
  urls?: string[];
}
export interface CookieRow {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch seconds; -1 for session cookies. */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
export interface CookiesListResult {
  cookies: CookieRow[];
}

export interface CookiesSetParams {
  sessionId: string;
  cookies: Array<{
    name: string;
    value: string;
    /** Either url OR domain+path must be set. */
    url?: string;
    domain?: string;
    path?: string;
    /** Epoch seconds. Omit for session cookie. */
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
}
export interface CookiesSetResult {
  set: number;
}

export interface CookiesClearParams {
  sessionId: string;
  /** No filters → clears every cookie in the context. */
  name?: string;
  domain?: string;
  path?: string;
}
export interface CookiesClearResult {
  cleared: number;
}

// --- Storage: localStorage/sessionStorage (M3.2) ---

export type StorageKind = "local" | "session";

export interface StorageOpBase {
  sessionId: string;
  pageId?: string;
  kind: StorageKind;
}

export interface StorageGetParams extends StorageOpBase {
  key: string;
}
export interface StorageGetResult {
  key: string;
  value: string | null;
}

export interface StorageSetParams extends StorageOpBase {
  key: string;
  value: string;
}
export interface StorageSetResult {
  key: string;
}

export interface StorageRemoveParams extends StorageOpBase {
  key: string;
}
export interface StorageRemoveResult {
  key: string;
  existed: boolean;
}

export interface StorageClearParams extends StorageOpBase {}
export interface StorageClearResult {
  cleared: number;
}

export interface StorageListParams extends StorageOpBase {}
export interface StorageListResult {
  /** Up to 200 entries; values truncated to 256 chars. Use storage_get for full values. */
  entries: Array<{ key: string; value: string; truncated: boolean }>;
  totalKeys: number;
}

// --- Storage: IndexedDB (M3.3) ---

export interface IndexedDbListDatabasesParams {
  sessionId: string;
  pageId?: string;
}
export interface IndexedDbListDatabasesResult {
  databases: Array<{ name: string; version: number }>;
}

export interface IndexedDbQueryParams {
  sessionId: string;
  pageId?: string;
  database: string;
  store: string;
  /** Default 20, max 200. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}
export interface IndexedDbQueryResult {
  database: string;
  store: string;
  count: number;
  truncated: boolean;
  rows: Array<{ key: unknown; value: unknown }>;
}

export interface IndexedDbClearParams {
  sessionId: string;
  pageId?: string;
  database: string;
  /** Omit to delete the whole database. */
  store?: string;
}
export interface IndexedDbClearResult {
  database: string;
  store: string | null;
  deletedDatabase: boolean;
}

// --- Interception (M3.4) ---

export type InterceptActionWire =
  | { kind: "abort"; reason?: string }
  | { kind: "continue"; method?: string; postData?: string; headers?: Record<string, string>; url?: string }
  | { kind: "respond"; status: number; headers?: Record<string, string>; body?: string; mimeType?: string };

export interface InterceptRuleWire {
  id: string;
  urlPattern: string;
  method?: string;
  oneShot: boolean;
  action: InterceptActionWire;
  addedAt: number;
  hits: number;
}

export interface InterceptAddParams {
  sessionId: string;
  urlPattern: string;
  /** Optional method filter (case-insensitive). */
  method?: string;
  /** Remove after first match. Defaults to false. */
  oneShot?: boolean;
  action: InterceptActionWire;
}
export interface InterceptAddResult {
  rule: InterceptRuleWire;
}

export interface InterceptListParams { sessionId: string; }
export interface InterceptListResult {
  rules: InterceptRuleWire[];
}

export interface InterceptRemoveParams {
  sessionId: string;
  id: string;
}
export interface InterceptRemoveResult {
  id: string;
  removed: boolean;
}

// --- Daemon status (M6.2) ---

export interface DaemonStatusParams {}
export interface DaemonStatusResult {
  ok: true;
  version: string;
  startedAt: number;
  uptimeSec: number;
  browserConnected: boolean;
  sessions: Array<{
    id: string;
    createdAt: number;
    pageCount: number;
    selectedPageId: string | null;
    consoleRows: number;
    networkRows: number;
    snapshotRows: number;
    exceptionRows: number;
    interceptRules: number;
    /** Total on-disk footprint: db + wal + shm + blobs. */
    sizeBytes: number;
    /** Breakdown: SQLite files (db+wal+shm) only. */
    dbBytes: number;
    /** Breakdown: content-addressed blob files only. */
    blobBytes: number;
    lastActivity: number;
    source: SessionSource | null;
  }>;
  subscriptions: number;
}

// --- FTS5 search (M5.4) ---

export interface ConsoleSearchParams {
  sessionId: string;
  query: string;
  pageSize?: number;
}
export interface ConsoleSearchResult {
  total: number;
  rows: Array<{ id: number; pageId: string; ts: number; level: string; text: string; snippet: string }>;
}

export interface NetworkSearchParams {
  sessionId: string;
  query: string;
  pageSize?: number;
}
export interface NetworkSearchResult {
  total: number;
  rows: Array<{ id: number; pageId: string; ts: number; method: string; url: string; status: number | null; snippet: string }>;
}

// --- Waits + upload (v1.1) ---

export interface WaitForParams {
  sessionId: string;
  pageId?: string;
  /** Wait until this substring appears in the page's text/snapshot. */
  text?: string;
  /** Wait until this substring disappears. */
  textGone?: string;
  /** Max wait. Default 10000. */
  timeoutMs?: number;
}
export interface WaitForResult {
  pageId: string;
  matched: boolean;
  waitedMs: number;
}

export interface NetworkWaitForParams {
  sessionId: string;
  pageId?: string;
  urlContains: string;
  /** Optional: also require this response status. */
  status?: number;
  timeoutMs?: number;
}
export interface NetworkWaitForResult {
  matched: boolean;
  waitedMs: number;
  request: { id: number; method: string; url: string; status: number | null } | null;
}

export interface UploadFileParams {
  sessionId: string;
  pageId?: string;
  uid: string;
  paths: string[];
}
export interface UploadFileResult {
  pageId: string;
  uid: string;
  fileCount: number;
}

// --- Performance metrics (M5.3) ---

export interface PerformanceMetricsParams {
  sessionId: string;
  pageId?: string;
}
export interface PerformanceMetricsResult {
  pageId: string;
  url: string;
  /** Raw CDP `Performance.getMetrics` payload as { name → value }. */
  metrics: Record<string, number>;
  /** PerformanceTiming snapshot (DOM/load/TTFB). */
  timing: Record<string, number> | null;
  /** Latest paint timings via PerformanceObserver (FP / FCP / LCP). */
  paint: { firstPaintMs?: number; firstContentfulPaintMs?: number; largestContentfulPaintMs?: number } | null;
}

// --- Emulation (M3.5) ---

export interface EmulateBase {
  sessionId: string;
  pageId?: string;
}

export interface EmulateViewportParams extends EmulateBase {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  isLandscape?: boolean;
}
export interface EmulateViewportResult {
  pageId: string;
  width: number;
  height: number;
}

export interface EmulateUserAgentParams extends EmulateBase {
  userAgent: string;
  acceptLanguage?: string;
  platform?: string;
}
export interface EmulateUserAgentResult {
  pageId: string;
  userAgent: string;
}

export interface EmulateNetworkParams extends EmulateBase {
  /**
   * Preset name OR custom values:
   *   "online" / "offline" / "Slow 3G" / "Fast 3G" / "4G" / "WiFi"
   * Or specify all three of latency/downloadKbps/uploadKbps for a custom profile.
   */
  preset?: string;
  offline?: boolean;
  latencyMs?: number;
  downloadKbps?: number;
  uploadKbps?: number;
}
export interface EmulateNetworkResult {
  pageId: string;
  applied: { offline: boolean; latencyMs: number; downloadKbps: number; uploadKbps: number };
}

export interface EmulateGeolocationParams extends EmulateBase {
  /** Pass null to clear the override. */
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number;
}
export interface EmulateGeolocationResult {
  pageId: string;
  cleared: boolean;
}

// --- Error codes (mirror JSON-RPC reserved range + custom) ---

export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // lean-chronoscope-mcp custom (-32000 to -32099 reserved per JSON-RPC spec)
  BROWSER_DISCONNECTED: -32001,
  SESSION_NOT_FOUND: -32002,
  PAGE_NOT_FOUND: -32003,
  NAVIGATION_FAILED: -32004,
  TIMEOUT: -32005,
} as const;
