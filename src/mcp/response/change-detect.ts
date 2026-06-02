import { createHash } from "node:crypto";

/**
 * Per-process memo of `(changeKey → contentHash)` so a tool can elide repeated
 * identical sections across successive calls. Lifetime is the MCP-server process
 * (one per Claude session) — when Claude restarts, the memo resets, which is
 * correct: the new context hasn't seen anything yet.
 *
 * Used by `McpResponse.addSection(title, body, { changeKey })`. When the body
 * hashes to the same value as the previous call with the same key, the section
 * collapses to a 1-line `### {title} (unchanged since rev N)` marker.
 */

interface MemoEntry {
  hash: string;
  rev: number;
}

const memo = new Map<string, MemoEntry>();

export interface ChangeDecision {
  changed: boolean;
  /** Monotonic per-key counter — bumps when content differs from last call. */
  rev: number;
}

/** Inspect-and-update. Returns whether `body` differs from the last seen for `key`. */
export function noteChange(key: string, body: string): ChangeDecision {
  const hash = createHash("sha1").update(body).digest("hex");
  const prev = memo.get(key);
  if (prev && prev.hash === hash) {
    return { changed: false, rev: prev.rev };
  }
  const rev = (prev?.rev ?? 0) + 1;
  memo.set(key, { hash, rev });
  return { changed: true, rev };
}

/** Drop memos whose key starts with `prefix` (e.g. on session close). Empty prefix clears all. */
export function resetChangeMemo(prefix = ""): void {
  if (!prefix) {
    memo.clear();
    return;
  }
  for (const k of memo.keys()) {
    if (k.startsWith(prefix)) memo.delete(k);
  }
}

/** Test helper — current memo size. */
export function memoSize(): number {
  return memo.size;
}
