import type { Page } from "puppeteer-core";
import { getLogger } from "@shared/logger.js";
import type { Broadcaster, EmitInput } from "../live/broadcaster.js";
import { buildUri } from "../live/uri.js";

const log = getLogger("daemon/collectors/page");

type PageResourceKind =
  | "page.console"
  | "page.network"
  | "page.exceptions"
  | "page.snapshot"
  | "page.url";

/**
 * Base collector: tracks the active navigation id for a page, exposes a hook
 * for navigation events, and gives subclasses a place to wire CDP/page listeners.
 *
 * When `sessionId` and `broadcaster` are provided, subclasses may call
 * `emitPage(kind, input)` to announce updates on the corresponding
 * `browser://session/{sid}/page/{pid}/<tail>` resource.
 */
export abstract class PageCollector {
  protected currentNavId: number | null = null;
  protected disposed = false;
  private listeners: Array<() => void> = [];

  constructor(
    protected readonly page: Page,
    protected readonly pageId: string,
    protected readonly sessionId?: string,
    protected readonly broadcaster?: Broadcaster,
  ) {}

  /** Called by the session/page manager when a new nav row is inserted. */
  setCurrentNav(navId: number | null): void {
    this.currentNavId = navId;
  }

  /** Register a teardown callback (e.g. page.off(...)). */
  protected onDispose(fn: () => void): void {
    this.listeners.push(fn);
  }

  /**
   * Fire-and-forget broadcast on a page-scoped resource URI. No-op when this
   * collector was constructed without a sessionId/broadcaster pair (isolation tests).
   */
  protected emitPage(kind: PageResourceKind, input: EmitInput): void {
    if (!this.broadcaster || !this.sessionId) return;
    const uri = buildUri({ kind, sessionId: this.sessionId, pageId: this.pageId });
    this.broadcaster.emit(uri, input);
  }

  abstract start(): Promise<void> | void;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        log.warn({ err }, "collector teardown threw");
      }
    }
    this.listeners = [];
  }
}
