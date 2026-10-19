// Minimal promise-chain mutex (FIFO). Each `run()` chains onto the tail of the
// previous holder, so callers execute strictly one at a time in arrival order.
// A holder that throws still releases (the chain swallows its rejection; the
// caller still sees it). No timeout here: callers bound their own work (e.g.
// navigate's goto timeout) so a hung holder can't wedge the queue forever.

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  /** True while a holder is running or callers are queued. */
  get isLocked(): boolean {
    return this.depth > 0;
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.depth++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      await prev;
      return await fn();
    } finally {
      this.depth--;
      release();
    }
  }
}
