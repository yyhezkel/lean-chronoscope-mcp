import { getLogger } from "@shared/logger.js";
import type { Broadcaster, BroadcastPayload } from "./broadcaster.js";

const log = getLogger("daemon/subscriptions");

/**
 * Sink the socket layer injects to push a notification back to one connection.
 * Returning Promise<void> is allowed but never awaited — fire-and-forget.
 */
export type NotificationSink = (uri: string, payload: BroadcastPayload) => void;

interface Entry {
  unsubscribe: () => void;
}

/**
 * Per-URI lifecycle hooks: `onFirst` when a URI goes 0→1 subscribers (across
 * all connections), `onLast` when it goes back to 0. Lets producers that cost
 * something to run (the CDP screencast) run only while someone is listening.
 */
export interface UriHooks {
  onFirst(uri: string): void;
  onLast(uri: string): void;
}

/**
 * Owns (connectionId → uri → unsubscribe) bookkeeping on top of `Broadcaster`.
 *
 * Each connection has its own sink (provided when the connection opens). When
 * the connection closes, `dropConnection` releases every URI it held.
 *
 * Subscriptions are idempotent: subscribing the same (conn, uri) twice is a no-op.
 */
export class SubscriptionRegistry {
  private readonly byConn = new Map<string, Map<string, Entry>>();
  private readonly uriCounts = new Map<string, number>();
  private hooks: UriHooks | null = null;

  constructor(private readonly broadcaster: Broadcaster) {}

  setUriHooks(hooks: UriHooks): void {
    this.hooks = hooks;
  }

  subscriberCount(uri: string): number {
    return this.uriCounts.get(uri) ?? 0;
  }

  private retain(uri: string): void {
    const n = (this.uriCounts.get(uri) ?? 0) + 1;
    this.uriCounts.set(uri, n);
    if (n === 1) this.runHook("onFirst", uri);
  }

  private release(uri: string): void {
    const n = (this.uriCounts.get(uri) ?? 0) - 1;
    if (n > 0) {
      this.uriCounts.set(uri, n);
      return;
    }
    this.uriCounts.delete(uri);
    this.runHook("onLast", uri);
  }

  private runHook(which: keyof UriHooks, uri: string): void {
    try {
      this.hooks?.[which](uri);
    } catch (err) {
      log.warn({ err, uri, hook: which }, "subscription hook threw");
    }
  }

  subscribe(connectionId: string, uri: string, sink: NotificationSink): void {
    let conn = this.byConn.get(connectionId);
    if (!conn) {
      conn = new Map();
      this.byConn.set(connectionId, conn);
    }
    if (conn.has(uri)) return;

    const unsubscribe = this.broadcaster.subscribe(uri, (payload) => {
      try {
        sink(uri, payload);
      } catch (err) {
        log.warn({ err, connectionId, uri }, "notification sink threw");
      }
    });
    conn.set(uri, { unsubscribe });
    this.retain(uri);
  }

  unsubscribe(connectionId: string, uri: string): void {
    const conn = this.byConn.get(connectionId);
    if (!conn) return;
    const entry = conn.get(uri);
    if (!entry) return;
    entry.unsubscribe();
    conn.delete(uri);
    this.release(uri);
    if (conn.size === 0) this.byConn.delete(connectionId);
  }

  /** Release every subscription held by `connectionId`. Called on socket close. */
  dropConnection(connectionId: string): void {
    const conn = this.byConn.get(connectionId);
    if (!conn) return;
    for (const [uri, entry] of conn) {
      entry.unsubscribe();
      this.release(uri);
    }
    this.byConn.delete(connectionId);
    log.debug({ connectionId }, "dropped subscriptions for connection");
  }

  listForConnection(connectionId: string): string[] {
    return Array.from(this.byConn.get(connectionId)?.keys() ?? []);
  }

  /** Total open subscriptions across all connections — useful for /metrics in M6. */
  totalCount(): number {
    let n = 0;
    for (const conn of this.byConn.values()) n += conn.size;
    return n;
  }
}
