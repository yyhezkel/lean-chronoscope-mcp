import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getBlobDir, getBlobPath } from "@shared/paths.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/blobs");

/** Content-addressed blob store: file path = sha256(content). Auto-dedups. */
export class BlobStore {
  constructor(
    private readonly sessionId: string,
    private readonly dataDir?: string,
  ) {
    fs.mkdirSync(getBlobDir(sessionId, dataDir), { recursive: true });
  }

  /** Returns the sha256 (hex) used as the storage key. */
  put(content: Buffer | string): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    const blobPath = getBlobPath(this.sessionId, sha, this.dataDir);
    if (!fs.existsSync(blobPath)) {
      fs.writeFileSync(blobPath, buf);
    }
    return sha;
  }

  /** Read by sha. Returns null if missing. */
  get(sha: string): Buffer | null {
    const blobPath = getBlobPath(this.sessionId, sha, this.dataDir);
    try {
      return fs.readFileSync(blobPath);
    } catch {
      return null;
    }
  }

  getText(sha: string, encoding: BufferEncoding = "utf8"): string | null {
    const b = this.get(sha);
    return b ? b.toString(encoding) : null;
  }

  pathFor(sha: string): string {
    return getBlobPath(this.sessionId, sha, this.dataDir);
  }

  /** Returns null if too small to need spilling — caller should inline. */
  putIfLarge(content: string | Buffer, threshold = 10_000): { sha: string; bytes: number } | null {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    if (buf.length < threshold) return null;
    const sha = this.put(buf);
    return { sha, bytes: buf.length };
  }

  /** Sum of all blob file sizes in this session's blob dir. */
  totalBytes(): number {
    const dir = getBlobDir(this.sessionId, this.dataDir);
    let total = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          total += fs.statSync(path.join(dir, name)).size;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* dir gone */
    }
    return total;
  }
}
