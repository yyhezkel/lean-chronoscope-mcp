import fs from "node:fs";
import type { BlobStore } from "./blobs.js";

/** File size in bytes, or 0 if the file is missing/unreadable. */
export function statSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * Total on-disk footprint of a session: the main SQLite file plus its WAL and
 * SHM sidecars plus every blob file. This is the number that matters for the
 * size cap and for size visibility — `db.sqlite` alone under-counts badly on a
 * busy session (the WAL can dwarf the main file, and large bodies/stacks live
 * in the blob dir, not in SQLite).
 *
 * Cost: one stat() per SQLite file + a readdir over the blob dir. NEVER call
 * this on the write hot path — only from the reaper tick / status queries.
 */
export function sessionSizeBytes(dbPath: string, blobs: BlobStore): number {
  return (
    statSize(dbPath) +
    statSize(`${dbPath}-wal`) +
    statSize(`${dbPath}-shm`) +
    blobs.totalBytes()
  );
}
