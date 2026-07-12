import type { Browser } from "puppeteer-core";
import type {
  ClickParams,
  ConsoleGetParams,
  ConsoleGetResult,
  ConsoleListParams,
  ConsoleListResult,
  CookieRow,
  CookiesClearParams,
  CookiesClearResult,
  CookiesListParams,
  CookiesListResult,
  CookiesSetParams,
  CookiesSetResult,
  DaemonMethod,
  IndexedDbClearParams,
  IndexedDbClearResult,
  IndexedDbListDatabasesParams,
  IndexedDbListDatabasesResult,
  IndexedDbQueryParams,
  IndexedDbQueryResult,
  InterceptAddParams,
  InterceptAddResult,
  InterceptListParams,
  InterceptListResult,
  InterceptRemoveParams,
  InterceptRemoveResult,
  EmulateGeolocationParams,
  EmulateGeolocationResult,
  EmulateNetworkParams,
  EmulateNetworkResult,
  EmulateUserAgentParams,
  EmulateUserAgentResult,
  EmulateViewportParams,
  EmulateViewportResult,
  StorageClearParams,
  StorageClearResult,
  StorageGetParams,
  StorageGetResult,
  StorageKind,
  StorageListParams,
  StorageListResult,
  StorageRemoveParams,
  StorageRemoveResult,
  StorageSetParams,
  StorageSetResult,
  DaemonNotificationMethod,
  DragParams,
  FillFormParams,
  HoverParams,
  InputActionResult,
  KeyParams,
  NetworkGetParams,
  NetworkGetResult,
  NetworkListParams,
  NetworkListResult,
  PageEvaluateParams,
  PageEvaluateResult,
  PageNavigateParams,
  PageNavigateResult,
  PageNewParams,
  PageNewResult,
  ResourceDescriptor,
  ResourceUpdatedParams,
  ResourcesListParams,
  ResourcesListResult,
  ResourcesReadParams,
  ResourcesReadResult,
  ResourcesSubscribeParams,
  ResourcesSubscribeResult,
  ResourcesUnsubscribeParams,
  ResourcesUnsubscribeResult,
  ScreenshotTakeParams,
  ScreenshotTakeResult,
  ScrollParams,
  SessionEnsureParams,
  SessionEnsureResult,
  ConsoleSearchParams,
  DaemonStatusResult,
  NetworkSearchParams,
  PageCloseParams,
  PageCloseResult,
  PageHistoryParams,
  PageHistoryResult,
  PageListParams,
  PageListResult,
  PageSelectParams,
  PageSelectResult,
  PerformanceMetricsParams,
  PerformanceMetricsResult,
  SessionCloseParams,
  SessionCloseResult,
  SessionListParams,
  SessionListEntry,
  SessionListResult,
  NetworkWaitForParams,
  NetworkWaitForResult,
  UploadFileParams,
  UploadFileResult,
  WaitForParams,
  WaitForResult,
  SnapshotDiffParams,
  SnapshotDiffResult,
  SnapshotTakeParams,
  SnapshotTakeResult,
  StatusResult,
  TypeParams,
} from "@shared/protocol.js";
import { resolveElement, waitForPotentialNavigation } from "./input.js";
import type { PageState } from "./session-registry.js";
import { formatSnapshot } from "./snapshot/formatter.js";
import { computeSnapshotDiff } from "./snapshot/diff.js";
import { DaemonError } from "@shared/errors.js";
import { getLogger } from "@shared/logger.js";
import { SessionRegistry, type Session } from "./session-registry.js";
import type { RegistryStore } from "./storage/registry.js";
import type { Broadcaster } from "./live/broadcaster.js";
import type { SubscriptionRegistry } from "./live/subscriptions.js";
import { buildUri, parseUri } from "./live/uri.js";

/**
 * Per-connection context handed to `dispatch()`. Lets subscribe/unsubscribe
 * RPCs route notifications back to the originating socket.
 */
export interface ConnectionContext {
  connectionId: string;
  sendNotification: (method: DaemonNotificationMethod, params: unknown) => void;
}

import fs from "node:fs";

const log = getLogger("daemon/rpc");
const VERSION = "1.3.0";

function sizeOfFile(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// `indexedDB` is a browser global — only valid inside `page.evaluate` closures
// (which TS sees as Node code). Declare it ambiently so those closures compile.
declare const indexedDB: any;

export class RpcDispatcher {
  private readonly sessions: SessionRegistry;
  private readonly startedAt = Date.now();

  constructor(
    private readonly browser: Browser,
    private readonly broadcaster: Broadcaster,
    private readonly subscriptions: SubscriptionRegistry,
    private readonly registry?: RegistryStore,
  ) {
    this.sessions = new SessionRegistry(browser, broadcaster, registry);
  }

  async closeAll(): Promise<void> {
    await this.sessions.closeAll();
  }

  /** Run one lifecycle tick (size flush + prune + idle/size eviction). */
  async reapTick(): Promise<void> {
    await this.sessions.reapTick();
  }

  async dispatch(method: DaemonMethod, params: unknown, ctx?: ConnectionContext): Promise<unknown> {
    // Touch last-activity + hold an in-flight guard so the reaper never evicts a
    // session mid-RPC. Two integer writes on a Map hit — no disk, no error
    // swallowing (try/finally, not try/catch).
    const sid = (params as { sessionId?: string } | undefined)?.sessionId;
    const sess = sid ? this.sessions.sessions.get(sid) : undefined;
    if (sess) {
      sess.lastActivity = Date.now();
      sess.inFlight++;
    }
    try {
      return await this.dispatchInner(method, params, ctx);
    } finally {
      if (sess) sess.inFlight--;
    }
  }

  private async dispatchInner(
    method: DaemonMethod,
    params: unknown,
    ctx?: ConnectionContext,
  ): Promise<unknown> {
    switch (method) {
      case "status":
        return this.status();
      case "session.ensure":
        return this.sessionEnsure(params as SessionEnsureParams);
      case "page.new":
        return this.pageNew(params as PageNewParams);
      case "page.navigate":
        return this.pageNavigate(params as PageNavigateParams);
      case "page.list":
        return this.pageList(params as PageListParams);
      case "page.select":
        return this.pageSelect(params as PageSelectParams);
      case "page.close":
        return this.pageClose(params as PageCloseParams);
      case "page.back":
        return this.pageHistory(params as PageHistoryParams, "back");
      case "page.forward":
        return this.pageHistory(params as PageHistoryParams, "forward");
      case "page.reload":
        return this.pageHistory(params as PageHistoryParams, "reload");
      case "session.list":
        return this.sessionList(params as SessionListParams);
      case "session.close":
        return this.sessionClose(params as SessionCloseParams);
      case "wait.for":
        return this.waitFor(params as WaitForParams);
      case "network.wait_for":
        return this.networkWaitFor(params as NetworkWaitForParams);
      case "input.upload_file":
        return this.uploadFile(params as UploadFileParams);
      case "page.evaluate":
        return this.pageEvaluate(params as PageEvaluateParams);
      case "screenshot.take":
        return this.screenshotTake(params as ScreenshotTakeParams);
      case "console.list":
        return this.consoleList(params as ConsoleListParams);
      case "console.get":
        return this.consoleGet(params as ConsoleGetParams);
      case "network.list":
        return this.networkList(params as NetworkListParams);
      case "network.get":
        return this.networkGet(params as NetworkGetParams);
      case "snapshot.take":
        return this.snapshotTake(params as SnapshotTakeParams);
      case "snapshot.diff":
        return this.snapshotDiff(params as SnapshotDiffParams);
      case "performance.metrics":
        return this.performanceMetrics(params as PerformanceMetricsParams);
      case "daemon.status":
        return this.daemonStatus();
      case "console.search": {
        const p = params as ConsoleSearchParams;
        if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
        if (!p?.query) throw DaemonError.invalidParams("query is required");
        const s = this.sessions.get(p.sessionId);
        const limit = Math.min(Math.max(1, p.pageSize ?? 20), 200);
        return s.reader.searchConsole(p.query, limit);
      }
      case "network.search": {
        const p = params as NetworkSearchParams;
        if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
        if (!p?.query) throw DaemonError.invalidParams("query is required");
        const s = this.sessions.get(p.sessionId);
        const limit = Math.min(Math.max(1, p.pageSize ?? 20), 200);
        return s.reader.searchNetwork(p.query, limit);
      }
      case "input.click":
        return this.inputClick(params as ClickParams);
      case "input.hover":
        return this.inputHover(params as HoverParams);
      case "input.type":
        return this.inputType(params as TypeParams);
      case "input.fill_form":
        return this.inputFillForm(params as FillFormParams);
      case "input.key":
        return this.inputKey(params as KeyParams);
      case "input.scroll":
        return this.inputScroll(params as ScrollParams);
      case "input.drag":
        return this.inputDrag(params as DragParams);
      case "resources.list":
        return this.resourcesList(params as ResourcesListParams);
      case "resources.read":
        return this.resourcesRead(params as ResourcesReadParams);
      case "resources.subscribe":
        return this.resourcesSubscribe(params as ResourcesSubscribeParams, ctx);
      case "resources.unsubscribe":
        return this.resourcesUnsubscribe(params as ResourcesUnsubscribeParams, ctx);
      case "cookies.list":
        return this.cookiesList(params as CookiesListParams);
      case "cookies.set":
        return this.cookiesSet(params as CookiesSetParams);
      case "cookies.clear":
        return this.cookiesClear(params as CookiesClearParams);
      case "storage.get":
        return this.storageGet(params as StorageGetParams);
      case "storage.set":
        return this.storageSet(params as StorageSetParams);
      case "storage.remove":
        return this.storageRemove(params as StorageRemoveParams);
      case "storage.clear":
        return this.storageClear(params as StorageClearParams);
      case "storage.list":
        return this.storageList(params as StorageListParams);
      case "indexeddb.list_databases":
        return this.indexedDbListDatabases(params as IndexedDbListDatabasesParams);
      case "indexeddb.query":
        return this.indexedDbQuery(params as IndexedDbQueryParams);
      case "indexeddb.clear":
        return this.indexedDbClear(params as IndexedDbClearParams);
      case "intercept.add":
        return this.interceptAdd(params as InterceptAddParams);
      case "intercept.list":
        return this.interceptList(params as InterceptListParams);
      case "intercept.remove":
        return this.interceptRemove(params as InterceptRemoveParams);
      case "emulate.viewport":
        return this.emulateViewport(params as EmulateViewportParams);
      case "emulate.useragent":
        return this.emulateUserAgent(params as EmulateUserAgentParams);
      case "emulate.network":
        return this.emulateNetwork(params as EmulateNetworkParams);
      case "emulate.geolocation":
        return this.emulateGeolocation(params as EmulateGeolocationParams);
      default:
        throw DaemonError.methodNotFound(method);
    }
  }

  private resolveNavScope(
    session: Session,
    params: { pageId?: string; navId?: number; includePreserved?: boolean },
  ): { pageId?: string; navId?: number } {
    if (params.navId != null) return { pageId: params.pageId, navId: params.navId };
    if (params.includePreserved) return { pageId: params.pageId };
    // Default: latest nav of the selected/specified page only.
    if (!params.pageId && !session.selectedPageId) return {};
    const pid = params.pageId ?? session.selectedPageId!;
    const navs = session.reader.getNavIdsForPage(pid, 1);
    return navs.length ? { pageId: pid, navId: navs[0] } : { pageId: pid };
  }

  // --- handlers ---

  private status(): StatusResult {
    return {
      ok: true,
      version: VERSION,
      startedAt: this.startedAt,
      browserConnected: this.browser.connected,
      sessions: this.sessions.sessions.size,
    };
  }

  private async sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const { session, created } = await this.sessions.ensure(params.sessionId, params.source);
    return {
      sessionId: session.id,
      currentPageId: session.selectedPageId,
      created,
    };
  }

  private async pageNew(params: PageNewParams): Promise<PageNewResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    await this.sessions.ensure(params.sessionId);
    const sp = await this.sessions.newPage(params.sessionId, params.url, params.background ?? false);
    return {
      pageId: sp.pageId,
      url: sp.page.url(),
      title: await sp.page.title(),
    };
  }

  private async pageNavigate(params: PageNavigateParams): Promise<PageNavigateResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!params?.url) throw DaemonError.invalidParams("url is required");
    await this.sessions.ensure(params.sessionId);

    // Auto-create a page if none exists yet.
    let sp;
    try {
      sp = this.sessions.getPage(params.sessionId, params.pageId);
    } catch {
      if (params.pageId) throw DaemonError.pageNotFound(params.pageId);
      sp = await this.sessions.newPage(params.sessionId);
    }

    const start = Date.now();
    const response = await sp.page.goto(params.url, {
      waitUntil: params.waitUntil ?? "load",
      timeout: params.timeoutMs ?? 30_000,
    });
    const durationMs = Date.now() - start;

    return {
      pageId: sp.pageId,
      url: sp.page.url(),
      status: response?.status() ?? null,
      title: await sp.page.title(),
      durationMs,
    };
  }

  private async pageList(params: PageListParams): Promise<PageListResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const pages = await Promise.all(
      Array.from(session.pages.values()).map(async (p) => ({
        pageId: p.pageId,
        url: p.page.url(),
        title: await p.page.title().catch(() => ""),
        selected: session.selectedPageId === p.pageId,
      })),
    );
    return { pages, selectedPageId: session.selectedPageId };
  }

  private pageSelect(params: PageSelectParams): PageSelectResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!params?.pageId) throw DaemonError.invalidParams("pageId is required");
    this.sessions.selectPage(params.sessionId, params.pageId);
    return { pageId: params.pageId };
  }

  private async pageClose(params: PageCloseParams): Promise<PageCloseResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    return this.sessions.closePage(params.sessionId, params.pageId);
  }

  private async pageHistory(
    params: PageHistoryParams,
    op: "back" | "forward" | "reload",
  ): Promise<PageHistoryResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const sp = this.sessions.getPage(params.sessionId, params.pageId);
    let navigated = true;
    if (op === "reload") {
      await sp.page.reload({ waitUntil: "load" });
    } else {
      const prevUrl = sp.page.url();
      const resp = op === "back" ? await sp.page.goBack() : await sp.page.goForward();
      // puppeteer resolves goBack/goForward to null for bfcache navigations even
      // though the page did navigate — so also treat a URL change as navigation.
      navigated = resp != null || sp.page.url() !== prevUrl;
    }
    return {
      pageId: sp.pageId,
      url: sp.page.url(),
      title: await sp.page.title().catch(() => ""),
      navigated,
    };
  }

  private sessionList(params?: SessionListParams): SessionListResult {
    const live: SessionListEntry[] = Array.from(this.sessions.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      pageCount: s.pages.size,
      selectedPageId: s.selectedPageId,
      sizeBytes: s.sizeBytes,
      status: "open" as const,
      source: s.source,
    }));
    if (!params?.includeClosed || !this.registry) return { sessions: live };
    // Union with closed rows from the registry index for discovery.
    const liveIds = new Set(live.map((s) => s.id));
    const closed: SessionListEntry[] = this.registry
      .list("closed")
      .filter((r) => !liveIds.has(r.id))
      .map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        lastActivity: r.lastActivity,
        pageCount: r.pageCount,
        selectedPageId: null,
        sizeBytes: r.sizeBytes,
        status: "closed" as const,
        source: r.source,
      }));
    return { sessions: [...live, ...closed] };
  }

  private async sessionClose(params: SessionCloseParams): Promise<SessionCloseResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const closed = await this.sessions.closeSession(params.sessionId);
    return { sessionId: params.sessionId, closed };
  }

  private async waitFor(p: WaitForParams): Promise<WaitForResult> {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!p.text && !p.textGone) throw DaemonError.invalidParams("text or textGone is required");
    const sp = this.sessions.getPage(p.sessionId, p.pageId);
    const timeoutMs = Math.min(Math.max(100, p.timeoutMs ?? 10_000), 120_000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const body = await sp.page
        .evaluate(() => (globalThis as any).document?.body?.innerText ?? "")
        .catch(() => "");
      const present = p.text ? body.includes(p.text) : true;
      const gone = p.textGone ? !body.includes(p.textGone) : true;
      if (present && gone) {
        return { pageId: sp.pageId, matched: true, waitedMs: Date.now() - start };
      }
      await sleep(150);
    }
    return { pageId: sp.pageId, matched: false, waitedMs: Date.now() - start };
  }

  private async networkWaitFor(p: NetworkWaitForParams): Promise<NetworkWaitForResult> {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!p?.urlContains) throw DaemonError.invalidParams("urlContains is required");
    const session = this.sessions.get(p.sessionId);
    const timeoutMs = Math.min(Math.max(100, p.timeoutMs ?? 10_000), 120_000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { rows } = session.reader.listNetwork({
        pageId: p.pageId,
        urlContains: p.urlContains,
        status: p.status,
        limit: 1,
        offset: 0,
      });
      // Only count requests that have a response (status set) when status filter
      // omitted too — we want "completed" matches, not in-flight.
      const hit = rows.find((r) => r.status != null);
      if (hit) {
        return {
          matched: true,
          waitedMs: Date.now() - start,
          request: { id: hit.id, method: hit.method, url: hit.url, status: hit.status },
        };
      }
      await sleep(150);
    }
    return { matched: false, waitedMs: Date.now() - start, request: null };
  }

  private async uploadFile(p: UploadFileParams): Promise<UploadFileResult> {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!p?.uid) throw DaemonError.invalidParams("uid is required");
    if (!p?.paths?.length) throw DaemonError.invalidParams("paths[] is required");
    const sp = this.sessions.getPage(p.sessionId, p.pageId);
    const ref = sp.snapshot.resolveUid(p.uid);
    if (!ref) throw DaemonError.invalidParams(`uid ${p.uid} not found in latest snapshot`);
    const client = await sp.page.createCDPSession();
    try {
      await client.send("DOM.setFileInputFiles", {
        files: p.paths,
        backendNodeId: ref.backendNodeId,
      } as any);
    } finally {
      try { await client.detach(); } catch { /* ignore */ }
    }
    return { pageId: sp.pageId, uid: p.uid, fileCount: p.paths.length };
  }

  private async pageEvaluate(params: PageEvaluateParams): Promise<PageEvaluateResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (typeof params?.expression !== "string") throw DaemonError.invalidParams("expression is required");
    const sp = this.sessions.getPage(params.sessionId, params.pageId);
    try {
      // Wrap as function body. Caller must use explicit `return` for a value
      // (matches Chrome DevTools console semantics for multi-statement input).
      const expr = params.expression.trim();
      const isBody = /;|\breturn\b/.test(expr);
      const fn = params.awaitPromise
        ? isBody
          ? `(async function () { ${expr} })()`
          : `(async () => (${expr}))()`
        : isBody
          ? `(function () { ${expr} })()`
          : `(() => (${expr}))()`;
      const value = await sp.page.evaluate(fn);
      return { pageId: sp.pageId, value, isError: false };
    } catch (err) {
      return {
        pageId: sp.pageId,
        value: null,
        isError: true,
        errorText: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private consoleList(params: ConsoleListParams): ConsoleListResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const scope = this.resolveNavScope(session, params);
    const pageIdx = Math.max(0, params.pageIdx ?? 0);
    const pageSize = Math.min(Math.max(1, params.pageSize ?? 20), 200);
    const { rows, total } = session.reader.listConsole({
      pageId: scope.pageId,
      navId: scope.navId,
      level: params.level,
      sinceTs: params.sinceTs,
      limit: pageSize,
      offset: pageIdx * pageSize,
    });
    return { total, pageIdx, pageSize, rows };
  }

  private consoleGet(params: ConsoleGetParams): ConsoleGetResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const detail = session.reader.getConsole(params.id);
    if (!detail) throw DaemonError.invalidParams(`console id ${params.id} not found`);
    return {
      id: detail.id,
      pageId: detail.pageId,
      ts: detail.ts,
      level: detail.level,
      text: detail.text,
      source: detail.source,
      url: detail.url,
      line: detail.line,
      col: detail.col,
      stack: detail.stackSha ? session.blobs.getText(detail.stackSha) : null,
      args: detail.argsSha ? session.blobs.getText(detail.argsSha) : null,
    };
  }

  private networkList(params: NetworkListParams): NetworkListResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const scope = this.resolveNavScope(session, params);
    const pageIdx = Math.max(0, params.pageIdx ?? 0);
    const pageSize = Math.min(Math.max(1, params.pageSize ?? 20), 200);
    const { rows, total } = session.reader.listNetwork({
      pageId: scope.pageId,
      navId: scope.navId,
      sinceTs: params.sinceTs,
      hideStatic: params.hideStatic,
      urlContains: params.urlContains,
      status: params.status,
      limit: pageSize,
      offset: pageIdx * pageSize,
    });
    return { total, pageIdx, pageSize, rows };
  }

  private networkGet(params: NetworkGetParams): NetworkGetResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const detail = session.reader.getNetwork(params.id);
    if (!detail) throw DaemonError.invalidParams(`network id ${params.id} not found`);
    const reqBody: { text?: string; blobSha?: string } = {};
    if (detail.reqBodyText) reqBody.text = detail.reqBodyText;
    else if (detail.reqBodyBlob) reqBody.blobSha = detail.reqBodyBlob;
    const resBody: { text?: string; blobSha?: string } = {};
    if (detail.resBodyText) resBody.text = detail.resBodyText;
    else if (detail.resBodyBlob) resBody.blobSha = detail.resBodyBlob;
    return {
      id: detail.id,
      pageId: detail.pageId,
      requestId: detail.requestId,
      method: detail.method,
      url: detail.url,
      status: detail.status,
      statusText: detail.statusText,
      errorText: detail.errorText,
      protocol: detail.protocol,
      remoteIp: detail.remoteIp,
      fromDiskCache: detail.fromDiskCache,
      fromSvcWorker: detail.fromSvcWorker,
      sizeResponse: detail.sizeResponse,
      reqHeaders: detail.reqHeaders ? JSON.parse(detail.reqHeaders) : null,
      resHeaders: detail.resHeaders ? JSON.parse(detail.resHeaders) : null,
      reqBody,
      resBody,
      tsRequest: detail.tsRequest,
      tsResponse: detail.tsResponse,
      tsFinished: detail.tsFinished,
    };
  }

  private async snapshotTake(params: SnapshotTakeParams): Promise<SnapshotTakeResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const sp = this.sessions.getPage(params.sessionId, params.pageId);
    const snap = await sp.snapshot.take();
    const text = formatSnapshot(snap);
    // Persist so snapshot_diff can compare across calls. Tree is JSON because
    // we want exact retrieval; the rendered text is regenerated on diff.
    const snapshotId = session.writer.insertSnapshot({
      pageId: sp.pageId,
      ts: snap.ts,
      url: snap.url,
      loaderId: snap.loaderId,
      treeJson: JSON.stringify(snap.root ?? null),
      uidCount: snap.uidCount,
    });
    this.broadcaster.emit(
      buildUri({ kind: "page.snapshot", sessionId: params.sessionId, pageId: sp.pageId }),
      { kind: "snapshot", lastTs: snap.ts },
    );
    return {
      pageId: sp.pageId,
      url: snap.url,
      title: snap.title,
      loaderId: snap.loaderId,
      ts: snap.ts,
      uidCount: snap.uidCount,
      text,
      snapshotId,
    };
  }

  private snapshotDiff(params: SnapshotDiffParams): SnapshotDiffResult {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    let beforeId = params.beforeId;
    let afterId = params.afterId;
    if (beforeId == null || afterId == null) {
      const pageId =
        params.pageId ?? session.selectedPageId ?? null;
      if (!pageId) throw DaemonError.invalidParams("pageId required when ids omitted");
      const latest = session.reader.getLatestSnapshotIds(pageId, 2);
      if (latest.length < 2) {
        throw DaemonError.invalidParams("need 2 snapshots on this page; take more snapshots first");
      }
      // `latest` is DESC by ts: [newest, second-newest]
      afterId ??= latest[0];
      beforeId ??= latest[1];
    }
    const before = session.reader.getSnapshotById(beforeId!);
    const after = session.reader.getSnapshotById(afterId!);
    if (!before) throw DaemonError.invalidParams(`snapshot id ${beforeId} not found`);
    if (!after) throw DaemonError.invalidParams(`snapshot id ${afterId} not found`);
    return computeSnapshotDiff(before, after);
  }

  // --- Input ---

  private getActiveSp(params: { sessionId: string; pageId?: string }): PageState {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    return this.sessions.getPage(params.sessionId, params.pageId);
  }

  private async runAction(
    sp: PageState,
    action: () => Promise<void>,
    code: string[],
  ): Promise<InputActionResult> {
    const start = Date.now();
    const prevUrl = sp.page.url();
    await action();
    // Best-effort: wait briefly to catch a triggered navigation.
    const navigatedTo = await waitForPotentialNavigation(sp.page, prevUrl, 1500);
    return { pageId: sp.pageId, code, navigatedTo, durationMs: Date.now() - start };
  }

  private async inputClick(p: ClickParams): Promise<InputActionResult> {
    const sp = this.getActiveSp(p);
    const el = await resolveElement(sp, p.uid);
    const button = p.button ?? "left";
    return this.runAction(
      sp,
      async () => {
        await sp.page.mouse.click(el.x, el.y, {
          button,
          clickCount: p.clickCount ?? 1,
        });
      },
      [`await page.mouse.click(${el.x.toFixed(0)}, ${el.y.toFixed(0)}, { button: ${JSON.stringify(button)} });`],
    );
  }

  private async inputHover(p: HoverParams): Promise<InputActionResult> {
    const sp = this.getActiveSp(p);
    const el = await resolveElement(sp, p.uid);
    return this.runAction(
      sp,
      async () => {
        await sp.page.mouse.move(el.x, el.y);
      },
      [`await page.mouse.move(${el.x.toFixed(0)}, ${el.y.toFixed(0)});`],
    );
  }

  private async inputType(p: TypeParams): Promise<InputActionResult> {
    const sp = this.getActiveSp(p);
    const el = await resolveElement(sp, p.uid);
    const code: string[] = [];
    return this.runAction(
      sp,
      async () => {
        await sp.page.mouse.click(el.x, el.y);
        code.push(`await page.mouse.click(${el.x.toFixed(0)}, ${el.y.toFixed(0)});`);
        if (p.clear !== false) {
          await sp.page.keyboard.down("Control");
          await sp.page.keyboard.press("KeyA");
          await sp.page.keyboard.up("Control");
          await sp.page.keyboard.press("Delete");
          code.push(`await page.keyboard.press("Control+A"); await page.keyboard.press("Delete");`);
        }
        await sp.page.keyboard.type(p.text, { delay: p.delay });
        code.push(`await page.keyboard.type(${JSON.stringify(p.text)}${p.delay != null ? `, { delay: ${p.delay} }` : ""});`);
      },
      code,
    );
  }

  private async inputFillForm(p: FillFormParams): Promise<InputActionResult> {
    if (!p?.fields?.length) throw DaemonError.invalidParams("fields[] is required");
    const sp = this.getActiveSp(p);
    const code: string[] = [];
    return this.runAction(
      sp,
      async () => {
        for (const f of p.fields) {
          const el = await resolveElement(sp, f.uid);
          if (f.kind === "check") {
            // Check/uncheck via click. If already in desired state, would re-toggle —
            // safer: evaluate the input.checked, then click if different.
            await sp.page.mouse.click(el.x, el.y);
            code.push(`await page.mouse.click(${el.x.toFixed(0)}, ${el.y.toFixed(0)}); // check ${f.value}`);
          } else if (f.kind === "select") {
            // Use CDP to set input value via DOM.
            const client = await sp.page.createCDPSession();
            try {
              const obj = (await client.send("DOM.resolveNode", { backendNodeId: el.backendNodeId } as any)) as { object: { objectId: string } };
              await client.send("Runtime.callFunctionOn", {
                objectId: obj.object.objectId,
                functionDeclaration: `function(v){ this.value = v; this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true})); }`,
                arguments: [{ value: f.value }],
              } as any);
            } finally {
              try { await client.detach(); } catch { /* ignore */ }
            }
            code.push(`/* set select uid=${f.uid} to ${JSON.stringify(f.value)} */`);
          } else {
            // text
            await sp.page.mouse.click(el.x, el.y);
            if (f.clear !== false) {
              await sp.page.keyboard.down("Control");
              await sp.page.keyboard.press("KeyA");
              await sp.page.keyboard.up("Control");
              await sp.page.keyboard.press("Delete");
            }
            await sp.page.keyboard.type(f.value);
            code.push(`await page.type(/* uid=${f.uid} */ "...", ${JSON.stringify(f.value)});`);
          }
        }
      },
      code,
    );
  }

  private async inputKey(p: KeyParams): Promise<InputActionResult> {
    if (!p?.keys) throw DaemonError.invalidParams("keys is required");
    const sp = this.getActiveSp(p);
    return this.runAction(
      sp,
      async () => {
        // "Control+Enter" → press chord.
        const parts = p.keys.split("+").map((s) => s.trim()).filter(Boolean);
        const mods = parts.slice(0, -1);
        const last = parts[parts.length - 1]!;
        for (const m of mods) await sp.page.keyboard.down(m as any);
        await sp.page.keyboard.press(last as any);
        for (const m of mods.reverse()) await sp.page.keyboard.up(m as any);
      },
      [`/* press ${p.keys} */`],
    );
  }

  private async inputScroll(p: ScrollParams): Promise<InputActionResult> {
    const sp = this.getActiveSp(p);
    const amount = p.amount ?? 400;
    const dx = p.direction === "left" ? -amount : p.direction === "right" ? amount : 0;
    const dy = p.direction === "up" ? -amount : p.direction === "down" ? amount : 0;

    if (p.uid) {
      const el = await resolveElement(sp, p.uid);
      return this.runAction(
        sp,
        async () => {
          await sp.page.mouse.move(el.x, el.y);
          await sp.page.mouse.wheel({ deltaX: dx, deltaY: dy });
        },
        [`await page.mouse.move(${el.x.toFixed(0)}, ${el.y.toFixed(0)}); await page.mouse.wheel({ deltaX: ${dx}, deltaY: ${dy} });`],
      );
    }
    return this.runAction(
      sp,
      async () => {
        await sp.page.evaluate(`window.scrollBy(${dx}, ${dy})`);
      },
      [`await page.evaluate(\`window.scrollBy(${dx}, ${dy})\`);`],
    );
  }

  private async inputDrag(p: DragParams): Promise<InputActionResult> {
    const sp = this.getActiveSp(p);
    const from = await resolveElement(sp, p.fromUid);
    const to = await resolveElement(sp, p.toUid);
    return this.runAction(
      sp,
      async () => {
        await sp.page.mouse.move(from.x, from.y);
        await sp.page.mouse.down();
        // Move in a few steps so drag handlers see it.
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const x = from.x + ((to.x - from.x) * i) / steps;
          const y = from.y + ((to.y - from.y) * i) / steps;
          await sp.page.mouse.move(x, y);
        }
        await sp.page.mouse.up();
      },
      [
        `await page.mouse.move(${from.x.toFixed(0)}, ${from.y.toFixed(0)});`,
        `await page.mouse.down();`,
        `await page.mouse.move(${to.x.toFixed(0)}, ${to.y.toFixed(0)}, { steps: 8 });`,
        `await page.mouse.up();`,
      ],
    );
  }

  private async screenshotTake(params: ScreenshotTakeParams): Promise<ScreenshotTakeResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const sp = this.sessions.getPage(params.sessionId, params.pageId);
    const format = params.format ?? "png";
    const viewport = sp.page.viewport() ?? { width: 0, height: 0 };

    // Decide whether to use CDP directly (for clip.scale) or puppeteer's wrapper.
    const maxLongSide = params.maxLongSide ?? 1568;
    const naturalLong = Math.max(viewport.width || 0, viewport.height || 0);
    const needsScale = maxLongSide > 0 && naturalLong > maxLongSide;

    let dataBase64: string;
    let outW = viewport.width;
    let outH = viewport.height;

    if (needsScale) {
      // CDP path: `clip.scale` rescales the captured pixels server-side. We
      // measure the layout viewport via Page.getLayoutMetrics so the clip box
      // matches what puppeteer's screenshot() would have captured.
      const scale = maxLongSide / naturalLong;
      const client = await sp.page.createCDPSession();
      try {
        const metrics = (await client.send("Page.getLayoutMetrics")) as any;
        const cssVp = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
        const w = cssVp.clientWidth ?? viewport.width;
        const h = cssVp.clientHeight ?? viewport.height;
        const res = (await client.send("Page.captureScreenshot", {
          format,
          quality: format === "jpeg" ? (params.quality ?? 80) : undefined,
          clip: {
            x: 0,
            y: 0,
            width: w,
            height: h,
            scale,
          },
          captureBeyondViewport: params.fullPage === true,
        })) as { data: string };
        dataBase64 = res.data;
        outW = Math.round(w * scale);
        outH = Math.round(h * scale);
      } finally {
        try { await client.detach(); } catch { /* ignore */ }
      }
    } else {
      const buffer = await sp.page.screenshot({
        type: format,
        fullPage: params.fullPage ?? false,
        quality: format === "jpeg" ? (params.quality ?? 80) : undefined,
        encoding: "binary",
      });
      dataBase64 = Buffer.from(buffer).toString("base64");
    }
    const bytes = Math.floor((dataBase64.length * 3) / 4);
    log.debug({ pageId: sp.pageId, bytes, format, scaled: needsScale }, "screenshot taken");
    return {
      pageId: sp.pageId,
      url: sp.page.url(),
      width: outW,
      height: outH,
      format,
      data: dataBase64,
      bytes,
    };
  }

  // --- Resources (M2) ---

  private resourcesList(params: ResourcesListParams): ResourcesListResult {
    const resources: ResourceDescriptor[] = [
      {
        uri: buildUri({ kind: "sessions" }),
        name: "sessions",
        description: "All active sessions on this daemon",
        mimeType: "application/json",
      },
      {
        uri: buildUri({ kind: "docs.tools" }),
        name: "docs.tools",
        description: "MCP tool registry (rendered on the mcp-server side)",
        mimeType: "application/json",
      },
    ];

    for (const session of this.sessions.sessions.values()) {
      if (params?.sessionId && session.id !== params.sessionId) continue;
      resources.push({
        uri: buildUri({ kind: "session.pages", sessionId: session.id }),
        name: `pages [${session.id}]`,
        mimeType: "application/json",
      });
      resources.push({
        uri: buildUri({ kind: "session.intercept", sessionId: session.id }),
        name: `intercept rules [${session.id}]`,
        description: "Active Fetch.enable interception rules (populated in M3.2)",
        mimeType: "application/json",
      });
      for (const pageId of session.pages.keys()) {
        const tails = ["snapshot", "console", "network", "exceptions", "url"] as const;
        const kindByTail = {
          snapshot: "page.snapshot",
          console: "page.console",
          network: "page.network",
          exceptions: "page.exceptions",
          url: "page.url",
        } as const;
        for (const tail of tails) {
          resources.push({
            uri: buildUri({ kind: kindByTail[tail], sessionId: session.id, pageId }),
            name: `${tail} [${session.id}/${pageId}]`,
            mimeType: "application/json",
          });
        }
      }
    }
    return { resources };
  }

  private resourcesRead(params: ResourcesReadParams): ResourcesReadResult {
    if (!params?.uri) throw DaemonError.invalidParams("uri is required");
    const parsed = parseUri(params.uri);
    if (!parsed) throw DaemonError.invalidParams(`invalid resource URI: ${params.uri}`);
    const revision = this.broadcaster.getRevision(params.uri);
    let data: unknown;
    switch (parsed.kind) {
      case "sessions":
        data = Array.from(this.sessions.sessions.values()).map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          pageCount: s.pages.size,
          selectedPageId: s.selectedPageId,
        }));
        break;
      case "session.pages": {
        const s = this.sessions.get(parsed.sessionId);
        data = Array.from(s.pages.values()).map((p) => ({
          pageId: p.pageId,
          url: p.page.url(),
          selected: s.selectedPageId === p.pageId,
        }));
        break;
      }
      case "page.url": {
        const sp = this.sessions.getPage(parsed.sessionId, parsed.pageId);
        data = { url: sp.page.url() };
        break;
      }
      case "page.console": {
        const s = this.sessions.get(parsed.sessionId);
        const last = s.reader.listConsole({ pageId: parsed.pageId, limit: 20, offset: 0 });
        data = { total: last.total, rows: last.rows };
        break;
      }
      case "page.network": {
        const s = this.sessions.get(parsed.sessionId);
        const last = s.reader.listNetwork({ pageId: parsed.pageId, limit: 20, offset: 0 });
        data = { total: last.total, rows: last.rows };
        break;
      }
      case "page.exceptions": {
        const s = this.sessions.get(parsed.sessionId);
        const last = s.reader.listExceptions({ pageId: parsed.pageId, limit: 20, offset: 0 });
        data = { total: last.total, rows: last.rows };
        break;
      }
      case "page.snapshot":
        // Snapshot persistence + diff land in M5. For now expose only what we have on the live page.
        data = { hint: "call snapshot.take to capture; persisted snapshot resource lands in M5" };
        break;
      case "session.intercept": {
        const s = this.sessions.get(parsed.sessionId);
        data = { rules: s.intercept.list() };
        break;
      }
      case "docs.tools":
        data = { hint: "rendered on the mcp-server side (M2.4)" };
        break;
    }
    return { uri: params.uri, revision, data };
  }

  private resourcesSubscribe(
    params: ResourcesSubscribeParams,
    ctx?: ConnectionContext,
  ): ResourcesSubscribeResult {
    if (!ctx) throw DaemonError.invalidParams("subscribe requires a connection context");
    if (!params?.uri) throw DaemonError.invalidParams("uri is required");
    const parsed = parseUri(params.uri);
    if (!parsed) throw DaemonError.invalidParams(`invalid resource URI: ${params.uri}`);

    this.subscriptions.subscribe(ctx.connectionId, params.uri, (uri, payload) => {
      const notif: ResourceUpdatedParams = {
        uri,
        revision: payload.revision,
        preview: {
          kind: payload.kind,
          ...(payload.lastId != null ? { lastId: payload.lastId } : {}),
          ...(payload.lastTs != null ? { lastTs: payload.lastTs } : {}),
        },
      };
      ctx.sendNotification("resource.updated", notif);
    });
    return { uri: params.uri, revision: this.broadcaster.getRevision(params.uri) };
  }

  private resourcesUnsubscribe(
    params: ResourcesUnsubscribeParams,
    ctx?: ConnectionContext,
  ): ResourcesUnsubscribeResult {
    if (!ctx) throw DaemonError.invalidParams("unsubscribe requires a connection context");
    if (!params?.uri) throw DaemonError.invalidParams("uri is required");
    const had = this.subscriptions.listForConnection(ctx.connectionId).includes(params.uri);
    this.subscriptions.unsubscribe(ctx.connectionId, params.uri);
    return { uri: params.uri, removed: had };
  }

  // --- Storage: cookies (M3.1) ---

  private async cookiesList(params: CookiesListParams): Promise<CookiesListResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const all = await session.context.cookies();
    const cookies = (params.urls?.length ? filterCookiesByUrls(all, params.urls) : all).map(
      toCookieRow,
    );
    return { cookies };
  }

  private async cookiesSet(params: CookiesSetParams): Promise<CookiesSetResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!params.cookies?.length) throw DaemonError.invalidParams("cookies[] is required");
    const session = this.sessions.get(params.sessionId);
    for (const c of params.cookies) {
      if (!c.name) throw DaemonError.invalidParams("cookie.name is required");
      if (!c.url && !c.domain) {
        throw DaemonError.invalidParams("cookie must have either url or domain");
      }
    }
    // puppeteer's CookieData uses partitionKey/etc, but the basic fields map 1:1.
    await session.context.setCookie(...(params.cookies as any));
    return { set: params.cookies.length };
  }

  private async cookiesClear(params: CookiesClearParams): Promise<CookiesClearResult> {
    if (!params?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(params.sessionId);
    const before = await session.context.cookies();
    if (!params.name && !params.domain && !params.path) {
      if (before.length > 0) {
        await session.context.deleteCookie(...before);
      }
      return { cleared: before.length };
    }
    const filter: Record<string, string> = {};
    if (params.name) filter.name = params.name;
    if (params.domain) filter.domain = params.domain;
    if (params.path) filter.path = params.path;
    await session.context.deleteMatchingCookies(filter as any);
    const after = await session.context.cookies();
    return { cleared: Math.max(0, before.length - after.length) };
  }

  // --- Storage: localStorage / sessionStorage (M3.2) ---

  private async storageGet(p: StorageGetParams): Promise<StorageGetResult> {
    const sp = this.getActiveSp(p);
    const value = await sp.page.evaluate(
      (kind: StorageKind, key: string) => {
        const store = kind === "local" ? localStorage : sessionStorage;
        return store.getItem(key);
      },
      p.kind,
      p.key,
    );
    return { key: p.key, value };
  }

  private async storageSet(p: StorageSetParams): Promise<StorageSetResult> {
    const sp = this.getActiveSp(p);
    await sp.page.evaluate(
      (kind: StorageKind, key: string, value: string) => {
        const store = kind === "local" ? localStorage : sessionStorage;
        store.setItem(key, value);
      },
      p.kind,
      p.key,
      p.value,
    );
    return { key: p.key };
  }

  private async storageRemove(p: StorageRemoveParams): Promise<StorageRemoveResult> {
    const sp = this.getActiveSp(p);
    const existed = await sp.page.evaluate(
      (kind: StorageKind, key: string) => {
        const store = kind === "local" ? localStorage : sessionStorage;
        const had = store.getItem(key) !== null;
        store.removeItem(key);
        return had;
      },
      p.kind,
      p.key,
    );
    return { key: p.key, existed };
  }

  private async storageClear(p: StorageClearParams): Promise<StorageClearResult> {
    const sp = this.getActiveSp(p);
    const cleared = await sp.page.evaluate((kind: StorageKind) => {
      const store = kind === "local" ? localStorage : sessionStorage;
      const n = store.length;
      store.clear();
      return n;
    }, p.kind);
    return { cleared };
  }

  private async storageList(p: StorageListParams): Promise<StorageListResult> {
    const sp = this.getActiveSp(p);
    const result = (await sp.page.evaluate((kind: StorageKind) => {
      const store = kind === "local" ? localStorage : sessionStorage;
      const total = store.length;
      const max = 200;
      const VALUE_CAP = 256;
      const entries: Array<{ key: string; value: string; truncated: boolean }> = [];
      for (let i = 0; i < Math.min(total, max); i++) {
        const key = store.key(i)!;
        const raw = store.getItem(key) ?? "";
        const truncated = raw.length > VALUE_CAP;
        entries.push({ key, value: truncated ? raw.slice(0, VALUE_CAP) : raw, truncated });
      }
      return { entries, totalKeys: total };
    }, p.kind)) as StorageListResult;
    return result;
  }

  // --- Storage: IndexedDB (M3.3) ---

  private async indexedDbListDatabases(
    p: IndexedDbListDatabasesParams,
  ): Promise<IndexedDbListDatabasesResult> {
    const sp = this.getActiveSp(p);
    const databases = (await sp.page.evaluate(async () => {
      // indexedDB.databases() is supported in Chromium. Older fallback returns [].
      if (typeof (indexedDB as any).databases !== "function") return [];
      const dbs = await (indexedDB as any).databases();
      return dbs.map((d: any) => ({ name: d.name, version: d.version }));
    })) as Array<{ name: string; version: number }>;
    return { databases };
  }

  private async indexedDbQuery(p: IndexedDbQueryParams): Promise<IndexedDbQueryResult> {
    if (!p?.database) throw DaemonError.invalidParams("database is required");
    if (!p?.store) throw DaemonError.invalidParams("store is required");
    const sp = this.getActiveSp(p);
    const limit = Math.min(Math.max(1, p.limit ?? 20), 200);
    const offset = Math.max(0, p.offset ?? 0);
    const result = (await sp.page.evaluate(
      async (database: string, store: string, limit: number, offset: number) => {
        return await new Promise<{
          count: number;
          truncated: boolean;
          rows: Array<{ key: unknown; value: unknown }>;
        }>((resolve, reject) => {
          const open = indexedDB.open(database);
          open.onerror = () => reject(new Error(`open ${database} failed: ${open.error?.message}`));
          open.onupgradeneeded = () => {
            // Caller asked for a db/store that doesn't exist — abort the upgrade.
            open.transaction?.abort();
            reject(new Error(`database ${database} does not exist`));
          };
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(store)) {
              db.close();
              reject(new Error(`store ${store} not in database ${database}`));
              return;
            }
            try {
              const tx = db.transaction(store, "readonly");
              const os = tx.objectStore(store);
              const count = os.count();
              const rows: Array<{ key: unknown; value: unknown }> = [];
              let seen = 0;
              const req = os.openCursor();
              req.onerror = () => {
                db.close();
                reject(new Error(`cursor failed: ${req.error?.message}`));
              };
              req.onsuccess = () => {
                const cursor = req.result;
                if (!cursor) {
                  db.close();
                  resolve({
                    count: count.result ?? rows.length,
                    truncated: rows.length === limit,
                    rows,
                  });
                  return;
                }
                if (seen < offset) {
                  seen++;
                  cursor.continue();
                  return;
                }
                if (rows.length < limit) {
                  rows.push({ key: cursor.key, value: cursor.value });
                  cursor.continue();
                } else {
                  db.close();
                  resolve({
                    count: count.result ?? rows.length + offset,
                    truncated: true,
                    rows,
                  });
                }
              };
            } catch (err) {
              db.close();
              reject(err);
            }
          };
        });
      },
      p.database,
      p.store,
      limit,
      offset,
    )) as Omit<IndexedDbQueryResult, "database" | "store">;
    return { database: p.database, store: p.store, ...result };
  }

  // --- Daemon status (M6.2) ---

  private daemonStatus(): DaemonStatusResult {
    const sessions = Array.from(this.sessions.sessions.values()).map((s) => {
      const counts = s.reader.tableCounts();
      // db + wal + shm — previously only db.sqlite was counted (bug).
      const dbBytes =
        sizeOfFile(s.db.dbPath) +
        sizeOfFile(`${s.db.dbPath}-wal`) +
        sizeOfFile(`${s.db.dbPath}-shm`);
      const blobBytes = s.blobs.totalBytes();
      return {
        id: s.id,
        createdAt: s.createdAt,
        pageCount: s.pages.size,
        selectedPageId: s.selectedPageId,
        consoleRows: counts.console,
        networkRows: counts.network,
        snapshotRows: counts.snapshots,
        exceptionRows: counts.exceptions,
        interceptRules: s.intercept.list().length,
        sizeBytes: dbBytes + blobBytes,
        dbBytes,
        blobBytes,
        lastActivity: s.lastActivity,
        source: s.source,
      };
    });
    return {
      ok: true,
      version: VERSION,
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      browserConnected: this.browser.connected,
      sessions,
      subscriptions: this.subscriptions.totalCount(),
    };
  }

  // --- Performance metrics (M5.3) ---

  private async performanceMetrics(
    p: PerformanceMetricsParams,
  ): Promise<PerformanceMetricsResult> {
    const sp = this.getActiveSp(p);
    const client = await sp.page.createCDPSession();
    let metrics: Record<string, number> = {};
    try {
      await client.send("Performance.enable").catch(() => {});
      const res = (await client.send("Performance.getMetrics")) as {
        metrics: Array<{ name: string; value: number }>;
      };
      for (const m of res.metrics) metrics[m.name] = m.value;
    } finally {
      try { await client.detach(); } catch { /* ignore */ }
    }
    // PerformanceTiming + Paint timings via the page's own JS context. Cast
    // through `any` because the function runs in the browser but TS sees Node.
    const inPage = (await sp.page.evaluate(() => {
      const perf = performance as any;
      const t = perf.timing
        ? Object.fromEntries(
            Object.keys(perf.timing.toJSON())
              .map((k: string) => [k, perf.timing[k] as number])
              .filter(([, v]: any) => typeof v === "number"),
          )
        : null;
      const paints = (perf.getEntriesByType("paint") as Array<{
        name: string;
        startTime: number;
      }>) ?? [];
      const lcpEntries = (perf.getEntriesByType("largest-contentful-paint") as Array<{
        startTime: number;
      }>) ?? [];
      const paint: any = {};
      for (const p of paints) {
        if (p.name === "first-paint") paint.firstPaintMs = Math.round(p.startTime);
        if (p.name === "first-contentful-paint") paint.firstContentfulPaintMs = Math.round(p.startTime);
      }
      if (lcpEntries.length > 0) {
        const last = lcpEntries[lcpEntries.length - 1]!;
        paint.largestContentfulPaintMs = Math.round(last.startTime);
      }
      return { timing: t, paint: Object.keys(paint).length ? paint : null };
    })) as { timing: Record<string, number> | null; paint: PerformanceMetricsResult["paint"] };
    return {
      pageId: sp.pageId,
      url: sp.page.url(),
      metrics,
      timing: inPage.timing,
      paint: inPage.paint,
    };
  }

  // --- Emulation (M3.5) ---

  private async emulateViewport(p: EmulateViewportParams): Promise<EmulateViewportResult> {
    const sp = this.getActiveSp(p);
    if (!Number.isFinite(p.width) || !Number.isFinite(p.height)) {
      throw DaemonError.invalidParams("width and height are required");
    }
    await sp.page.setViewport({
      width: Math.max(1, Math.floor(p.width)),
      height: Math.max(1, Math.floor(p.height)),
      deviceScaleFactor: p.deviceScaleFactor,
      isMobile: p.isMobile,
      hasTouch: p.hasTouch,
      isLandscape: p.isLandscape,
    });
    return { pageId: sp.pageId, width: p.width, height: p.height };
  }

  private async emulateUserAgent(p: EmulateUserAgentParams): Promise<EmulateUserAgentResult> {
    const sp = this.getActiveSp(p);
    if (!p.userAgent) throw DaemonError.invalidParams("userAgent is required");
    // Puppeteer's `setUserAgent(ua, metadata?)` rejects when metadata isn't the
    // full Emulation.UserAgentMetadata shape (brands/platform/mobile/...).
    // The plain-string call is fine; platform goes via the options overload.
    if (p.platform) {
      await sp.page.setUserAgent({ userAgent: p.userAgent, platform: p.platform } as any);
    } else {
      await sp.page.setUserAgent(p.userAgent);
    }
    if (p.acceptLanguage) {
      // Accept-Language isn't exposed via setUserAgent; push it via CDP.
      const client = await sp.page.createCDPSession();
      try {
        await client
          .send("Network.setExtraHTTPHeaders", {
            headers: { "Accept-Language": p.acceptLanguage },
          })
          .catch(() => {});
      } finally {
        try { await client.detach(); } catch { /* ignore */ }
      }
    }
    return { pageId: sp.pageId, userAgent: p.userAgent };
  }

  private async emulateNetwork(p: EmulateNetworkParams): Promise<EmulateNetworkResult> {
    const sp = this.getActiveSp(p);
    const profile = resolveNetworkProfile(p);
    const client = await sp.page.createCDPSession();
    try {
      await client.send("Network.enable").catch(() => {});
      await client.send("Network.emulateNetworkConditions", {
        offline: profile.offline,
        latency: profile.latencyMs,
        downloadThroughput: kbpsToBytesPerSecond(profile.downloadKbps),
        uploadThroughput: kbpsToBytesPerSecond(profile.uploadKbps),
      });
    } finally {
      try { await client.detach(); } catch { /* ignore */ }
    }
    return { pageId: sp.pageId, applied: profile };
  }

  private async emulateGeolocation(
    p: EmulateGeolocationParams,
  ): Promise<EmulateGeolocationResult> {
    const sp = this.getActiveSp(p);
    const cleared = p.latitude == null || p.longitude == null;
    const client = await sp.page.createCDPSession();
    try {
      if (cleared) {
        await client.send("Emulation.clearGeolocationOverride");
      } else {
        await client.send("Emulation.setGeolocationOverride", {
          latitude: p.latitude!,
          longitude: p.longitude!,
          accuracy: p.accuracy ?? 50,
        });
      }
    } finally {
      try { await client.detach(); } catch { /* ignore */ }
    }
    return { pageId: sp.pageId, cleared };
  }

  // --- Interception (M3.4) ---

  private async interceptAdd(p: InterceptAddParams): Promise<InterceptAddResult> {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!p?.urlPattern) throw DaemonError.invalidParams("urlPattern is required");
    if (!p?.action) throw DaemonError.invalidParams("action is required");
    const session = this.sessions.get(p.sessionId);
    const rule = await session.intercept.addRule({
      urlPattern: p.urlPattern,
      method: p.method,
      oneShot: p.oneShot ?? false,
      action: p.action,
    });
    return { rule };
  }

  private interceptList(p: InterceptListParams): InterceptListResult {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    const session = this.sessions.get(p.sessionId);
    return { rules: session.intercept.list() };
  }

  private async interceptRemove(p: InterceptRemoveParams): Promise<InterceptRemoveResult> {
    if (!p?.sessionId) throw DaemonError.invalidParams("sessionId is required");
    if (!p?.id) throw DaemonError.invalidParams("id is required");
    const session = this.sessions.get(p.sessionId);
    const removed = await session.intercept.removeRule(p.id);
    return { id: p.id, removed };
  }

  private async indexedDbClear(p: IndexedDbClearParams): Promise<IndexedDbClearResult> {
    if (!p?.database) throw DaemonError.invalidParams("database is required");
    const sp = this.getActiveSp(p);
    const deletedDatabase = !p.store;
    await sp.page.evaluate(
      async (database: string, store: string | null) => {
        return await new Promise<void>((resolve, reject) => {
          if (store) {
            const open = indexedDB.open(database);
            open.onerror = () => reject(new Error(open.error?.message ?? "open failed"));
            open.onupgradeneeded = () => {
              open.transaction?.abort();
              reject(new Error(`database ${database} does not exist`));
            };
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains(store)) {
                db.close();
                reject(new Error(`store ${store} not in database ${database}`));
                return;
              }
              const tx = db.transaction(store, "readwrite");
              tx.objectStore(store).clear();
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                reject(new Error(tx.error?.message ?? "clear failed"));
              };
            };
          } else {
            const req = indexedDB.deleteDatabase(database);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(new Error(req.error?.message ?? "delete failed"));
            req.onblocked = () => reject(new Error(`delete ${database} blocked by open connections`));
          }
        });
      },
      p.database,
      p.store ?? null,
    );
    return { database: p.database, store: p.store ?? null, deletedDatabase };
  }
}

const NETWORK_PROFILES: Record<
  string,
  { offline: boolean; latencyMs: number; downloadKbps: number; uploadKbps: number }
> = {
  online: { offline: false, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  offline: { offline: true, latencyMs: 0, downloadKbps: 0, uploadKbps: 0 },
  "slow 3g": { offline: false, latencyMs: 400, downloadKbps: 500, uploadKbps: 500 },
  "fast 3g": { offline: false, latencyMs: 150, downloadKbps: 1600, uploadKbps: 750 },
  "4g": { offline: false, latencyMs: 70, downloadKbps: 9000, uploadKbps: 9000 },
  wifi: { offline: false, latencyMs: 2, downloadKbps: 30_000, uploadKbps: 15_000 },
};

function resolveNetworkProfile(p: EmulateNetworkParams): {
  offline: boolean;
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
} {
  if (p.preset) {
    const key = p.preset.toLowerCase();
    const profile = NETWORK_PROFILES[key];
    if (!profile) throw DaemonError.invalidParams(`unknown network preset: ${p.preset}`);
    return profile;
  }
  return {
    offline: p.offline ?? false,
    latencyMs: p.latencyMs ?? 0,
    downloadKbps: p.downloadKbps ?? 0,
    uploadKbps: p.uploadKbps ?? 0,
  };
}

function kbpsToBytesPerSecond(kbps: number): number {
  // CDP expects bytes/sec; 0 means "no throttling".
  return kbps <= 0 ? 0 : Math.floor((kbps * 1000) / 8);
}

function toCookieRow(c: any): CookieRow {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: typeof c.expires === "number" ? c.expires : -1,
    size: c.size ?? c.name.length + (c.value?.length ?? 0),
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    session: !!c.session,
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

function filterCookiesByUrls(cookies: any[], urls: string[]): any[] {
  const parsed = urls.map((u) => new URL(u));
  return cookies.filter((c) => {
    return parsed.some((u) => {
      // Domain match: cookie.domain may start with "."
      const cd = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      if (!(u.hostname === cd || u.hostname.endsWith("." + cd))) return false;
      if (!u.pathname.startsWith(c.path === "" ? "/" : c.path)) return false;
      if (c.secure && u.protocol !== "https:") return false;
      return true;
    });
  });
}
