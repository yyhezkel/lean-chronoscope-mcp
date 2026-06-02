import type { Browser, BrowserContext, Frame, Page } from "puppeteer-core";
import { nextPageId } from "@shared/ids.js";
import { DaemonError } from "@shared/errors.js";
import { getLogger } from "@shared/logger.js";
import { openSessionDb, type SessionDb } from "./storage/db.js";
import { BlobStore } from "./storage/blobs.js";
import { SessionWriter } from "./storage/writer.js";
import { SessionReader } from "./storage/reader.js";
import { ConsoleCollector } from "./collectors/ConsoleCollector.js";
import { NetworkCollector } from "./collectors/NetworkCollector.js";
import type { PageCollector } from "./collectors/PageCollector.js";
import { SnapshotService } from "./snapshot/TextSnapshot.js";
import type { Broadcaster } from "./live/broadcaster.js";
import { buildUri } from "./live/uri.js";
import { InterceptionEngine } from "./intercept/engine.js";

const log = getLogger("daemon/sessions");

export interface PageState {
  pageId: string;
  page: Page;
  collectors: PageCollector[];
  snapshot: SnapshotService;
  /** SQLite id of the currently-active navigation (null until first nav). */
  currentNavId: number | null;
  cleanupListeners: Array<() => void>;
}

export interface Session {
  id: string;
  context: BrowserContext;
  pages: Map<string, PageState>;
  selectedPageId: string | null;
  createdAt: number;
  db: SessionDb;
  blobs: BlobStore;
  writer: SessionWriter;
  reader: SessionReader;
  intercept: InterceptionEngine;
}

export class SessionRegistry {
  readonly sessions = new Map<string, Session>();

  constructor(
    private readonly browser: Browser,
    private readonly broadcaster?: Broadcaster,
  ) {}

  /** Fire-and-forget emit to broadcaster; no-op when no broadcaster is wired. */
  private broadcast(uri: string, kind: string): void {
    this.broadcaster?.emit(uri, { kind });
  }

  async ensure(sessionId: string, dataDir?: string): Promise<{ session: Session; created: boolean }> {
    const existing = this.sessions.get(sessionId);
    if (existing) return { session: existing, created: false };

    const context = await this.browser.createBrowserContext();
    const db = openSessionDb(sessionId, dataDir);
    const blobs = new BlobStore(sessionId, dataDir);
    const writer = new SessionWriter(db.db, blobs);
    const reader = new SessionReader(db.db);

    const session: Session = {
      id: sessionId,
      context,
      pages: new Map(),
      selectedPageId: null,
      createdAt: Date.now(),
      db,
      blobs,
      writer,
      reader,
      intercept: new InterceptionEngine(sessionId, this.broadcaster),
    };
    this.sessions.set(sessionId, session);
    log.info({ sessionId }, "session created");
    this.broadcast(buildUri({ kind: "sessions" }), "sessions");
    return { session, created: true };
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw DaemonError.sessionNotFound(sessionId);
    return session;
  }

  async newPage(sessionId: string, url?: string, background = false): Promise<PageState> {
    const session = this.get(sessionId);
    const page = await session.context.newPage();
    const pageId = nextPageId();
    const targetId = (page.target() as any)?._targetId ?? page.target().url();

    session.writer.insertPage({ id: pageId, targetId, url: page.url(), title: "" });

    const state: PageState = {
      pageId,
      page,
      collectors: [],
      snapshot: new SnapshotService(page),
      currentNavId: null,
      cleanupListeners: [],
    };

    await this.attachCollectorsAndNavTracking(session, state);
    session.pages.set(pageId, state);
    if (!background || session.selectedPageId == null) {
      session.selectedPageId = pageId;
    }
    if (url) {
      await page.goto(url, { waitUntil: "load" });
    }
    log.info({ sessionId, pageId, url }, "page created");
    this.broadcast(buildUri({ kind: "session.pages", sessionId }), "pages");
    return state;
  }

  getPage(sessionId: string, pageId?: string): PageState {
    const session = this.get(sessionId);
    const id = pageId ?? session.selectedPageId;
    if (!id) throw DaemonError.pageNotFound("(no selected page)");
    const sp = session.pages.get(id);
    if (!sp) throw DaemonError.pageNotFound(id);
    return sp;
  }

  selectPage(sessionId: string, pageId: string): void {
    const session = this.get(sessionId);
    if (!session.pages.has(pageId)) throw DaemonError.pageNotFound(pageId);
    session.selectedPageId = pageId;
    this.broadcast(buildUri({ kind: "session.pages", sessionId }), "pages");
  }

  /** Close one page. Returns the new selected page id (or null). */
  async closePage(sessionId: string, pageId?: string): Promise<{ closedPageId: string; selectedPageId: string | null }> {
    const sp = this.getPage(sessionId, pageId);
    // page.close() fires the 'close' handler wired in attachCollectorsAndNavTracking,
    // which disposes collectors, marks the row closed, and re-selects.
    await sp.page.close();
    const session = this.get(sessionId);
    return { closedPageId: sp.pageId, selectedPageId: session.selectedPageId };
  }

  /** Close an entire session: dispose intercept, pages, context, db. */
  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    await session.intercept.dispose();
    for (const ps of session.pages.values()) this.disposePage(ps);
    try {
      await session.context.close();
    } catch (err) {
      log.warn({ err, sessionId }, "error closing session context");
    }
    session.db.close();
    this.sessions.delete(sessionId);
    this.broadcast(buildUri({ kind: "sessions" }), "sessions");
    return true;
  }

  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.intercept.dispose();
      for (const ps of session.pages.values()) {
        this.disposePage(ps);
      }
      try {
        await session.context.close();
      } catch (err) {
        log.warn({ err, sessionId: session.id }, "error closing session context");
      }
      session.db.close();
    }
    this.sessions.clear();
  }

  private async attachCollectorsAndNavTracking(
    session: Session,
    state: PageState,
  ): Promise<void> {
    const consoleCollector = new ConsoleCollector(
      state.page,
      state.pageId,
      session.writer,
      session.id,
      this.broadcaster,
    );
    await consoleCollector.start();
    const networkCollector = new NetworkCollector(
      state.page,
      state.pageId,
      session.writer,
      session.id,
      this.broadcaster,
      { captureBodies: true },
    );
    await networkCollector.start();
    state.collectors.push(consoleCollector, networkCollector);

    // Attach the session-level interception engine to this page. It's a no-op
    // CDP-wise until the user adds a rule, but the CDP session must be live so
    // we can wire `Fetch.requestPaused`.
    try {
      await session.intercept.attach(state.page, state.pageId);
    } catch (err) {
      log.warn({ err, pageId: state.pageId }, "intercept attach failed");
    }

    // Track main-frame navigations → write nav rows + propagate to collectors.
    const onFrameNav = (frame: Frame) => {
      if (frame !== state.page.mainFrame()) return;
      const loaderId = (frame as any)._loaderId ?? `loader_${Date.now()}`;
      try {
        const navId = session.writer.insertNavigation({
          pageId: state.pageId,
          loaderId,
          url: frame.url(),
        });
        state.currentNavId = navId;
        for (const c of state.collectors) c.setCurrentNav(navId);
      } catch (err) {
        log.warn({ err }, "insert navigation row failed");
      }
      this.broadcast(
        buildUri({ kind: "page.url", sessionId: session.id, pageId: state.pageId }),
        "url",
      );
    };
    state.page.on("framenavigated", onFrameNav);
    state.cleanupListeners.push(() => state.page.off("framenavigated", onFrameNav));

    // Mark navigation finished on load.
    const onLoad = () => {
      if (state.currentNavId != null) {
        try {
          session.writer.finishNavigation(state.currentNavId, "success");
        } catch (err) {
          log.warn({ err }, "finish navigation row failed");
        }
      }
    };
    state.page.on("load", onLoad);
    state.cleanupListeners.push(() => state.page.off("load", onLoad));

    const onClose = () => {
      void session.intercept.detach(state.pageId);
      this.disposePage(state);
      session.writer.markPageClosed(state.pageId);
      session.pages.delete(state.pageId);
      if (session.selectedPageId === state.pageId) {
        const next = session.pages.keys().next();
        session.selectedPageId = next.done ? null : (next.value as string);
      }
      this.broadcast(buildUri({ kind: "session.pages", sessionId: session.id }), "pages");
    };
    state.page.on("close", onClose);
    state.cleanupListeners.push(() => state.page.off("close", onClose));
  }

  private disposePage(state: PageState): void {
    for (const c of state.collectors) c.dispose();
    state.collectors = [];
    for (const fn of state.cleanupListeners) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    state.cleanupListeners = [];
  }
}
