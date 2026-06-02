/**
 * Per-page UID map. UID format: "e<counter>" generated per snapshot.
 * Stores both the latest map for lookup, and the previous snapshot's map
 * keyed by `loaderId_backendNodeId` for stability checks across snapshots
 * within the same navigation (M5 will diff this properly).
 */

export interface NodeRef {
  uid: string;
  backendNodeId: number;
  role: string;
  name: string;
}

export class UidMap {
  /** Current snapshot — uid → ref. */
  private currentByUid = new Map<string, NodeRef>();
  /** Stability map for the *previous* snapshot in same loader, keyed by backendNodeId. */
  private prevByBackend = new Map<number, string>();
  private prevLoaderId: string | null = null;
  private counter = 0;

  /** Begin populating a new snapshot. Call once before adding nodes. */
  beginSnapshot(loaderId: string): void {
    // If loader didn't change, carry prev uid mapping for reuse.
    if (this.prevLoaderId !== loaderId) {
      this.prevByBackend = new Map();
    } else {
      this.prevByBackend = new Map(
        Array.from(this.currentByUid.entries()).map(([uid, ref]) => [ref.backendNodeId, uid]),
      );
    }
    this.prevLoaderId = loaderId;
    this.currentByUid = new Map();
    this.counter = this.counter; // keep counter monotonic for unique uids across reuse
  }

  /** Generate or reuse uid for a node. Returns the uid. */
  upsert(backendNodeId: number, role: string, name: string): string {
    const existing = this.prevByBackend.get(backendNodeId);
    const uid = existing ?? this.nextUid();
    this.currentByUid.set(uid, { uid, backendNodeId, role, name });
    return uid;
  }

  resolve(uid: string): NodeRef | undefined {
    return this.currentByUid.get(uid);
  }

  size(): number {
    return this.currentByUid.size;
  }

  entries(): IterableIterator<[string, NodeRef]> {
    return this.currentByUid.entries();
  }

  private nextUid(): string {
    this.counter += 1;
    return `e${this.counter}`;
  }
}
