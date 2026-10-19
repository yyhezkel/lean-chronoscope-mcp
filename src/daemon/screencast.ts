import type { CDPSession, Page } from "puppeteer-core";
import { getLogger } from "@shared/logger.js";
import type { Broadcaster } from "./live/broadcaster.js";

const log = getLogger("daemon/screencast");

/** Min ms between frames (≈2fps). Each frame's ack is delayed by this much,
 *  and Chrome won't encode the next frame until acked — so Chrome itself
 *  throttles to match instead of us discarding 60fps of JPEGs. */
const FRAME_INTERVAL_MS = 500;
const JPEG_QUALITY = 60;
const MAX_DIM = 1280;

export interface ScreencastFrame {
  /** base64 JPEG */
  data: string;
  ts: number;
  width: number | null;
  height: number | null;
}

interface Cast {
  pageId: string;
  page: Page;
  client: CDPSession | null;
  /** Set by stop(); a start() still awaiting CDP sees it and tears down. */
  stopped: boolean;
  latest: ScreencastFrame | null;
  ackTimer: NodeJS.Timeout | null;
  onPageClose: () => void;
}

interface FramePayload {
  data: string;
  sessionId: number;
  metadata?: { deviceWidth?: number; deviceHeight?: number; timestamp?: number };
}

/**
 * Live JPEG screencast per page, keyed by the screencast resource URI.
 *
 * Driven by subscriber refcounts (SubscriptionRegistry hooks): `start` on the
 * first subscriber, `stop` on the last unsubscribe / connection drop, and on
 * page close. Only the latest frame is kept, in memory — never BlobStore,
 * whose prune-time sweepUnreferenced would GC it (no row references it).
 * Each stored frame pokes the Broadcaster so subscribers get resources/updated.
 */
export class ScreencastManager {
  private readonly casts = new Map<string, Cast>();

  constructor(private readonly broadcaster?: Broadcaster) {}

  isActive(uri: string): boolean {
    return this.casts.has(uri);
  }

  latest(uri: string): ScreencastFrame | null {
    return this.casts.get(uri)?.latest ?? null;
  }

  activeCount(): number {
    return this.casts.size;
  }

  async start(uri: string, page: Page, pageId: string): Promise<void> {
    if (this.casts.has(uri)) return;
    const cast: Cast = {
      pageId,
      page,
      client: null,
      stopped: false,
      latest: null,
      ackTimer: null,
      onPageClose: () => void this.stop(uri),
    };
    this.casts.set(uri, cast);
    page.once("close", cast.onPageClose);
    try {
      const client = await page.createCDPSession();
      cast.client = client;
      if (cast.stopped) {
        await this.teardown(cast);
        return;
      }
      client.on("Page.screencastFrame", (f: FramePayload) => this.onFrame(uri, cast, f));
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: JPEG_QUALITY,
        maxWidth: MAX_DIM,
        maxHeight: MAX_DIM,
        everyNthFrame: 1,
      });
      log.info({ uri, pageId }, "screencast started");
    } catch (err) {
      log.warn({ err, uri, pageId }, "screencast start failed");
      await this.stop(uri);
    }
  }

  async stop(uri: string): Promise<void> {
    const cast = this.casts.get(uri);
    if (!cast) return;
    this.casts.delete(uri);
    cast.stopped = true;
    cast.page.off("close", cast.onPageClose);
    if (cast.ackTimer) clearTimeout(cast.ackTimer);
    cast.ackTimer = null;
    // client === null → start() is still awaiting createCDPSession and will
    // tear down itself once it sees `stopped`.
    if (cast.client) await this.teardown(cast);
    log.info({ uri, pageId: cast.pageId }, "screencast stopped");
  }

  async dispose(): Promise<void> {
    for (const uri of Array.from(this.casts.keys())) await this.stop(uri);
  }

  private onFrame(uri: string, cast: Cast, f: FramePayload): void {
    if (cast.stopped) return;
    const now = Date.now();
    cast.latest = {
      data: f.data,
      ts: now,
      width: f.metadata?.deviceWidth ?? null,
      height: f.metadata?.deviceHeight ?? null,
    };
    this.broadcaster?.emit(uri, { kind: "screencast", lastTs: now });
    // Delayed ack caps the stream at ~2fps (see FRAME_INTERVAL_MS).
    if (cast.ackTimer) clearTimeout(cast.ackTimer);
    cast.ackTimer = setTimeout(() => {
      cast.ackTimer = null;
      if (cast.stopped || !cast.client || cast.client.detached) return;
      cast.client.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    }, FRAME_INTERVAL_MS);
    cast.ackTimer.unref?.();
  }

  private async teardown(cast: Cast): Promise<void> {
    const client = cast.client;
    if (!client) return;
    cast.client = null;
    // Closed page → the target (and this CDP session) is usually already gone.
    if (client.detached || !client.connection()) return;
    try {
      await client.send("Page.stopScreencast").catch(() => {});
      await client.detach();
    } catch (err) {
      if (/Target closed|Session closed|detached/i.test(err instanceof Error ? err.message : String(err))) {
        log.debug({ err, pageId: cast.pageId }, "screencast client already detached");
      } else {
        log.warn({ err, pageId: cast.pageId }, "screencast client detach failed");
      }
    }
  }
}
