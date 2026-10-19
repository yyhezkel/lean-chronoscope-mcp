import type { Browser, BrowserContext, Frame, Page } from "puppeteer-core";
import { nextPageId, assertSafeSessionId } from "@shared/ids.js";
import { DaemonError } from "@shared/errors.js";
import { env } from "@shared/env.js";
import { getLogger } from "@shared/logger.js";
import { Mutex } from "@shared/mutex.js";
import type { SessionSource } from "@shared/protocol.js";
import { openSessionDb, type SessionDb } from "./storage/db.js";
import { sessionSizeBytes } from "./storage/size.js";
import type { RegistryStore } from "./storage/registry.js";
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
  /** CDP loaderId of `currentNavId` (null until first nav, or if the loader id
   *  was unavailable) — used to spot same-document navigations. */
  currentLoaderId: string | null;
  cleanupListeners: Array<() => void>;
  /** ms of the last non-passive RPC targeting this page; drives page reaping. */
  lastActivity: number;
  /** Count of currently-executing RPCs targeting this page — never reaped when >0. */
  inFlight: number;
}

export interface Session {
  id: string;
  context: BrowserContext;
  pages: Map<string, PageState>;
  selectedPageId: string | null;
  createdAt: number;
  /** ms of the last RPC touching this session; drives idle eviction. */
  lastActivity: number;
  /** Count of currently-executing RPCs — the reaper never evicts when >0. */
  inFlight: number;
  /** Cached total on-disk size (db+wal+shm+blobs); refreshed by the reaper tick. */
  sizeBytes: number;
  sizeComputedAt: number;
  source: SessionSource | null;
  /** Optional human-friendly name for attach-by-title. */
  title: string | null;
  db: SessionDb;
  blobs: BlobStore;
  writer: SessionWriter;
  reader: SessionReader;
  intercept: InterceptionEngine;
  /** Serializes RPCs that mutate browser/page state (see LOCKED_METHODS in
   *  rpc-handlers.ts); the page reaper also closes pages under it. */
  lock: Mutex;
}

export class SessionRegistry {
  readonly sessions = new Map<string, Session>();
  /** True while a page is watched passively (live screencast subscribers).
   *  Passive resource reads/subscriptions don't bump lastActivity, so the
   *  reaper consults this to keep watched pages (and their session) alive. */
  isPageWatched?: (sessionId: string, pageId: string) => boolean;
  /** Fired after newPage registers a page (lets a pending screencast start). */
  onPageCreated?: (sessionId: string, pageId: string) => void;

  private hasWatchedPage(s: Session): boolean {
    if (!this.isPageWatched) return false;
    for (const pageId of s.pages.keys()) if (this.isPageWatched(s.id, pageId)) return true;
    return false;
  }

  /** In-flight `ensure()` creations, keyed by session id (see ensure). */
  private readonly creating = new Map<string, Promise<Session>>();

  constructor(
    private browser: Browser,
    private readonly broadcaster?: Broadcaster,
    private readonly registry?: RegistryStore,
  ) {}

  /** Fire-and-forget emit to broadcaster; no-op when no broadcaster is wired. */
  private broadcast(uri: string, kind: string): void {
    this.broadcaster?.emit(uri, { kind });
  }

  async ensure(
    sessionId: string,
    source?: SessionSource,
    title?: string,
    dataDir?: string,
  ): Promise<{ session: Session; created: boolean }> {
    try {
      assertSafeSessionId(sessionId);
    } catch (err) {
      throw DaemonError.invalidParams((err as Error).message);
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      // Late-supplied title (e.g. attach names an already-live session).
      if (title && !existing.title) {
        existing.title = title;
        this.registry?.upsertOpen({
          id: existing.id,
          createdAt: existing.createdAt,
          lastActivity: existing.lastActivity,
          source: existing.source,
          dataDir: existing.db.dbPath,
          title,
        });
      }
      return { session: existing, created: false };
    }

    // Dedupe concurrent creates of the same id: without this, two callers that
    // both miss the map (e.g. concurrent page.navigate on a brand-new id, or two
    // HTTP initializes with the same x-lc-session) each build a Session across
    // the `await createBrowserContext()` — the second overwrites the first,
    // leaking a BrowserContext + a second SQLite handle on the same db file and
    // splitting the lock. Late joiners get created:false (and their title, if
    // the first caller supplied none).
    const pending = this.creating.get(sessionId);
    if (pending) {
      const session = await pending;
      if (title && !session.title) return this.ensure(sessionId, source, title, dataDir);
      return { session, created: false };
    }
    const creation = this.create(sessionId, source, title, dataDir);
    this.creating.set(sessionId, creation);
    try {
      return { session: await creation, created: true };
    } finally {
      this.creating.delete(sessionId);
    }
  }

  private async create(
    sessionId: string,
    source?: SessionSource,
    title?: string,
    dataDir?: string,
  ): Promise<Session> {
    const context = await this.browser.createBrowserContext();
    const db = openSessionDb(sessionId, dataDir);
    const blobs = new BlobStore(sessionId, dataDir);
    const writer = new SessionWriter(db.db, blobs);
    const reader = new SessionReader(db.db);

    const now = Date.now();
    const session: Session = {
      id: sessionId,
      context,
      pages: new Map(),
      selectedPageId: null,
      createdAt: now,
      lastActivity: now,
      inFlight: 0,
      sizeBytes: 0,
      sizeComputedAt: 0,
      source: source ?? null,
      title: title ?? null,
      db,
      blobs,
      writer,
      reader,
      intercept: new InterceptionEngine(sessionId, this.broadcaster),
      lock: new Mutex(),
    };
    this.sessions.set(sessionId, session);
    this.registry?.upsertOpen({
      id: sessionId,
      createdAt: now,
      lastActivity: now,
      source: source ?? null,
      dataDir: db.dbPath,
      title: title ?? null,
    });
    log.info({ sessionId, source }, "session created");
    this.broadcast(buildUri({ kind: "sessions" }), "sessions");
    return session;
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw DaemonError.sessionNotFound(sessionId);
    return session;
  }

  async newPage(sessionId: string, url?: string, background = false): Promise<PageState> {
    const session = this.get(sessionId);
    // Selection at start: a page.new abandoned by the locked-op timeout can
    // finish late, after the client already page_select-ed another page — it
    // must not steal the selection back. (Closing the old selection doesn't
    // count as an explicit choice, so the new page still takes over then.)
    const selectedBefore = session.selectedPageId;
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
      currentLoaderId: null,
      cleanupListeners: [],
      lastActivity: Date.now(),
      inFlight: 0,
    };

    await this.attachCollectorsAndNavTracking(session, state);
    session.pages.set(pageId, state);
    const reselected =
      session.selectedPageId !== selectedBefore &&
      (selectedBefore == null || session.pages.has(selectedBefore));
    if (session.selectedPageId == null || (!background && !reselected)) {
      session.selectedPageId = pageId;
    }
    if (url) {
      await page.goto(url, { waitUntil: "load" });
    }
    log.info({ sessionId, pageId, url }, "page created");
    this.broadcast(buildUri({ kind: "session.pages", sessionId }), "pages");
    this.onPageCreated?.(sessionId, pageId);
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
    session.db.close(); // checkpoints + truncates the WAL, so measure size after
    let sizeBytes = session.sizeBytes;
    try {
      sizeBytes = sessionSizeBytes(session.db.dbPath, session.blobs);
    } catch {
      /* stat race — fall back to the cached value */
    }
    this.registry?.markClosed(sessionId, {
      closedAt: Date.now(),
      lastActivity: session.lastActivity,
      sizeBytes,
      pageCount: session.pages.size,
    });
    this.sessions.delete(sessionId);
    this.broadcast(buildUri({ kind: "sessions" }), "sessions");
    return true;
  }

  /**
   * Re-point every live session at a freshly relaunched Chrome (see index.ts).
   * The old browser is gone, so all browser-bound state is dropped: pages are
   * disposed (listeners first, so a late 'close' from the dead target can't
   * touch the map) and their rows marked closed; the intercept engine forgets
   * its dead CDP sessions but keeps its rules; a new BrowserContext is created.
   * Everything on disk (db/blobs/writer/reader/registry row) is untouched, so
   * captured history stays readable. Per-page emulation is lost. A session that
   * fails to rebind is closed rather than left pointing at a dead context.
   */
  async rebind(browser: Browser): Promise<void> {
    this.browser = browser;
    for (const s of Array.from(this.sessions.values())) {
      if (this.sessions.get(s.id) !== s) continue; // closed while an earlier one rebound
      try {
        for (const ps of s.pages.values()) {
          this.disposePage(ps);
          try {
            s.writer.markPageClosed(ps.pageId);
          } catch (err) {
            log.warn({ err, sessionId: s.id, pageId: ps.pageId }, "rebind: markPageClosed failed");
          }
        }
        s.pages.clear();
        s.selectedPageId = null;
        s.intercept.resetPages();
        const context = await browser.createBrowserContext();
        // session.close / the reaper may have closed this session while we
        // awaited; adopting the context then would leak it.
        if (this.sessions.get(s.id) !== s) {
          await context.close().catch((e) => log.warn({ err: e, sessionId: s.id }, "rebind: close orphan context"));
          continue;
        }
        s.context = context;
        log.info({ sessionId: s.id, rules: s.intercept.list().length }, "session rebound to relaunched Chrome");
        this.broadcast(buildUri({ kind: "session.pages", sessionId: s.id }), "pages");
      } catch (err) {
        log.error({ err, sessionId: s.id }, "rebind failed — closing session");
        await this.closeSession(s.id).catch((e) => log.warn({ err: e, sessionId: s.id }, "close after failed rebind"));
      }
    }
    this.broadcast(buildUri({ kind: "sessions" }), "sessions");
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
      this.registry?.markClosed(session.id, {
        closedAt: Date.now(),
        lastActivity: session.lastActivity,
        sizeBytes: session.sizeBytes,
        pageCount: session.pages.size,
      });
    }
    this.sessions.clear();
  }

  /**
   * Periodic lifecycle tick (called by the daemon's reaper interval):
   *   1. refresh each live session's cached size + flush stats to the registry,
   *   2. prune old rows to bound in-session growth (only when idle of RPCs),
   *   3. evict sessions that are idle past IDLE_MS or over SIZE_CAP_BYTES,
   *   4. in surviving sessions, close pages idle past PAGE_IDLE_MS and enforce
   *      MAX_PAGES_PER_SESSION (see reapPages).
   * Evict == free the BrowserContext + memory (closeSession); the on-disk dir is
   * left for the age sweep. All per-session work is wrapped so one bad session
   * never stalls the sweep.
   */
  async reapTick(): Promise<void> {
    const idleMs = Number(env("IDLE_MS") ?? 30 * 60_000);
    const sizeCap = Number(env("SIZE_CAP_BYTES") ?? 500 * 1024 * 1024);
    const now = Date.now();
    const candidates: Session[] = [];

    for (const s of this.sessions.values()) {
      let size = s.sizeBytes;
      try {
        size = sessionSizeBytes(s.db.dbPath, s.blobs);
      } catch {
        /* stat race — keep the cached value */
      }
      s.sizeBytes = size;
      s.sizeComputedAt = now;
      this.registry?.updateStats(s.id, {
        lastActivity: s.lastActivity,
        sizeBytes: size,
        pageCount: s.pages.size,
      });
      // Prune only when no RPC is in flight (a concurrent DELETE + a long
      // read could contend / surprise a caller).
      if (s.inFlight === 0) {
        try {
          s.writer.prune();
        } catch (err) {
          log.warn({ err, sessionId: s.id }, "prune failed");
        }
      }
      // A watched session (live screencast) is active even without RPCs.
      const idle = now - s.lastActivity >= idleMs && !this.hasWatchedPage(s);
      const tooBig = sizeCap > 0 && size >= sizeCap;
      if (idle || tooBig) candidates.push(s);
    }

    for (const s of candidates) {
      try {
        await this.maybeEvict(s, idleMs, sizeCap);
      } catch (err) {
        log.warn({ err, sessionId: s.id }, "reaper evict failed");
      }
    }

    // Evicted sessions are gone from the map by now, so this only visits survivors.
    const pageIdleMs = Number(env("PAGE_IDLE_MS") ?? 15 * 60_000);
    const maxPages = Number(env("MAX_PAGES_PER_SESSION") ?? 20);
    if (pageIdleMs <= 0 && maxPages <= 0) return;
    for (const s of Array.from(this.sessions.values())) {
      try {
        await this.reapPages(s, pageIdleMs, maxPages);
      } catch (err) {
        log.warn({ err, sessionId: s.id }, "reaper page sweep failed");
      }
    }
  }

  /**
   * Close a session's idle pages (idle >= pageIdleMs) and, beyond that, the
   * oldest-idle pages over the maxPages cap. Never closes the selected page,
   * one with an RPC in flight, or one being watched (live screencast) — the
   * cap closes other pages instead. Skips the session entirely while its lock is
   * held/queued; otherwise runs under the lock so no mutating RPC can start on
   * a page mid-close. Guards are re-checked inside the lock.
   */
  private async reapPages(s: Session, pageIdleMs: number, maxPages: number): Promise<void> {
    if (s.lock.isLocked) return;
    const pick = (): Array<{ ps: PageState; reason: string }> => {
      const now = Date.now();
      const closable = Array.from(s.pages.values())
        .filter(
          (ps) =>
            ps.pageId !== s.selectedPageId &&
            ps.inFlight === 0 &&
            !this.isPageWatched?.(s.id, ps.pageId),
        )
        .sort((a, b) => a.lastActivity - b.lastActivity);
      const out: Array<{ ps: PageState; reason: string }> = [];
      const picked = new Set<string>();
      if (pageIdleMs > 0) {
        for (const ps of closable) {
          if (now - ps.lastActivity >= pageIdleMs) {
            out.push({ ps, reason: "idle" });
            picked.add(ps.pageId);
          }
        }
      }
      if (maxPages > 0) {
        let excess = s.pages.size - out.length - maxPages;
        for (const ps of closable) {
          if (excess <= 0) break;
          if (picked.has(ps.pageId)) continue;
          out.push({ ps, reason: "over-cap" });
          excess--;
        }
      }
      return out;
    };
    if (pick().length === 0) return;
    await s.lock.run(async () => {
      if (this.sessions.get(s.id) !== s) return; // closed while we waited
      for (const { ps, reason } of pick()) {
        log.info(
          { sessionId: s.id, pageId: ps.pageId, reason, idleMs: Date.now() - ps.lastActivity },
          "reaper closing idle page",
        );
        try {
          await ps.page.close(); // 'close' handler disposes + marks the row closed
        } catch (err) {
          log.warn({ err, sessionId: s.id, pageId: ps.pageId }, "reaper page close failed");
        }
      }
    });
  }

  /** Re-check the guards under fresh state, then evict. */
  private async maybeEvict(s: Session, idleMs: number, sizeCap: number): Promise<void> {
    if (s.inFlight > 0) return; // an RPC (e.g. a 120s wait.for) is mid-flight
    const now = Date.now();
    const idle = now - s.lastActivity >= idleMs && !this.hasWatchedPage(s);
    const tooBig = sizeCap > 0 && s.sizeBytes >= sizeCap;
    if (!idle && !tooBig) return; // activity arrived during the size walk
    log.info(
      { sessionId: s.id, idle, tooBig, sizeBytes: s.sizeBytes, source: s.source },
      "reaper evicting session",
    );
    await this.closeSession(s.id); // also writes registry.markClosed
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
      const realLoaderId = (frame as any)._loaderId as string | undefined;
      // Same-document navigations (pushState / hash change) re-fire
      // framenavigated with the *same* loaderId: it's still the same document,
      // so keep the current nav (and its request attribution) and just track
      // the url. Only dedupe on a real loader id — the synthetic fallback below
      // is unique per call and must never match.
      if (realLoaderId && state.currentNavId != null && realLoaderId === state.currentLoaderId) {
        try {
          session.writer.updateNavigationUrl(state.currentNavId, frame.url());
        } catch (err) {
          log.warn({ err }, "update navigation url failed");
        }
        this.broadcast(
          buildUri({ kind: "page.url", sessionId: session.id, pageId: state.pageId }),
          "url",
        );
        return;
      }
      const loaderId = realLoaderId ?? `loader_${Date.now()}`;
      try {
        const navId = session.writer.insertNavigation({
          pageId: state.pageId,
          loaderId,
          url: frame.url(),
        });
        state.currentNavId = navId;
        state.currentLoaderId = realLoaderId ?? null;
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
