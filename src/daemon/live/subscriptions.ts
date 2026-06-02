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
 * Owns (connectionId → uri → unsubscribe) bookkeeping on top of `Broadcaster`.
 *
 * Each connection has its own sink (provided when the connection opens). When
 * the connection closes, `dropConnection` releases every URI it held.
 *
 * Subscriptions are idempotent: subscribing the same (conn, uri) twice is a no-op.
 */
export class SubscriptionRegistry {
  private readonly byConn = new Map<string, Map<string, Entry>>();

  constructor(private readonly broadcaster: Broadcaster) {}

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
  }

  unsubscribe(connectionId: string, uri: string): void {
    const conn = this.byConn.get(connectionId);
    if (!conn) return;
    const entry = conn.get(uri);
    if (!entry) return;
    entry.unsubscribe();
    conn.delete(uri);
    if (conn.size === 0) this.byConn.delete(connectionId);
  }

  /** Release every subscription held by `connectionId`. Called on socket close. */
  dropConnection(connectionId: string): void {
    const conn = this.byConn.get(connectionId);
    if (!conn) return;
    for (const entry of conn.values()) {
      entry.unsubscribe();
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
