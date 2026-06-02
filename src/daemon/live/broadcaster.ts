import { EventEmitter } from "node:events";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/broadcaster");

/**
 * Payload pushed to subscribers when a resource updates.
 * `revision` is monotonic per URI; survivable counters land in M2.5 via SQLite.
 * `lastId` / `lastTs` are optional previews so a client can decide whether to
 * re-read the resource (e.g. "I already saw lastId=42, skip").
 */
export interface BroadcastPayload {
  kind: string;
  revision: number;
  lastId?: number;
  lastTs?: number;
}

export type EmitInput = Omit<BroadcastPayload, "revision">;

interface PendingEmit {
  timer: NodeJS.Timeout;
  lastInput: EmitInput;
}

/**
 * Per-URI debounced broadcaster.
 *
 * `emit(uri, input)` schedules a flush after `debounceMs`. Subsequent calls
 * within that window reset the timer and overwrite the input (last-write-wins).
 * Subscribers receive at most one notification per debounce window per URI.
 *
 * Hot paths (collectors) call `emit` synchronously — work happens on the timer.
 */
export class Broadcaster {
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<string, PendingEmit>();
  private readonly revisions = new Map<string, number>();

  constructor(private readonly debounceMs = 200) {
    // We may have hundreds of subscribers across sessions; disable the default warning.
    this.emitter.setMaxListeners(0);
  }

  subscribe(uri: string, listener: (payload: BroadcastPayload) => void): () => void {
    this.emitter.on(uri, listener);
    return () => {
      this.emitter.off(uri, listener);
    };
  }

  /**
   * Schedule a debounced broadcast on `uri`. Safe to call from any hot path;
   * never throws — listener errors are caught and logged.
   */
  emit(uri: string, input: EmitInput): void {
    const existing = this.pending.get(uri);
    if (existing) {
      clearTimeout(existing.timer);
      existing.lastInput = input;
    }
    const timer = setTimeout(() => this.flush(uri), this.debounceMs);
    if (typeof timer.unref === "function") timer.unref();
    if (existing) {
      existing.timer = timer;
    } else {
      this.pending.set(uri, { timer, lastInput: input });
    }
  }

  /** Force-flush a URI's pending emit immediately (e.g. on shutdown). No-op if none pending. */
  flush(uri: string): void {
    const entry = this.pending.get(uri);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(uri);
    const revision = (this.revisions.get(uri) ?? 0) + 1;
    this.revisions.set(uri, revision);
    const payload: BroadcastPayload = { ...entry.lastInput, revision };
    try {
      this.emitter.emit(uri, payload);
    } catch (err) {
      log.error({ err, uri }, "broadcaster listener threw");
    }
  }

  getRevision(uri: string): number {
    return this.revisions.get(uri) ?? 0;
  }

  /** Cancel all pending timers and drop listeners. */
  dispose(): void {
    for (const { timer } of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.emitter.removeAllListeners();
  }
}
