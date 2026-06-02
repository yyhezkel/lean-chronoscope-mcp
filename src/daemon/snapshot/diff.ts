/**
 * Compact diff of two persisted snapshots. The trees are JSON blobs of
 * `SnapshotNode` (see TextSnapshot.ts) — we flatten to a `uid → row` map and
 * compute added / removed / changed sets. Uses the stable `uid` (loaderId +
 * backendNodeId-derived) as the identity, so cross-reload diffs work as long
 * as UIDs are stable.
 */

import type { SnapshotDiffResult } from "@shared/protocol.js";

interface PersistedSnapshot {
  id: number;
  pageId: string;
  ts: number;
  url: string;
  loaderId: string | null;
  treeJson: string;
  uidCount: number;
}

interface NodeRow {
  uid: string;
  role: string;
  name: string;
  value: string;
  flags: string[];
}

export function computeSnapshotDiff(
  before: PersistedSnapshot,
  after: PersistedSnapshot,
): SnapshotDiffResult {
  const beforeMap = flatten(before.treeJson);
  const afterMap = flatten(after.treeJson);

  const added: NodeRow[] = [];
  const removed: NodeRow[] = [];
  const changed: Array<{ before: NodeRow; after: NodeRow }> = [];
  let unchanged = 0;

  for (const [uid, row] of afterMap) {
    const prev = beforeMap.get(uid);
    if (!prev) {
      added.push(row);
    } else if (!sameRow(prev, row)) {
      changed.push({ before: prev, after: row });
    } else {
      unchanged++;
    }
  }
  for (const [uid, row] of beforeMap) {
    if (!afterMap.has(uid)) removed.push(row);
  }

  const lines: string[] = [];
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push("(no changes)");
  } else {
    if (added.length) {
      lines.push(`+ Added (${added.length})`);
      for (const r of added.slice(0, 50)) lines.push(`  + ${formatRow(r)}`);
      if (added.length > 50) lines.push(`  …+${added.length - 50} more`);
    }
    if (removed.length) {
      lines.push(`- Removed (${removed.length})`);
      for (const r of removed.slice(0, 50)) lines.push(`  - ${formatRow(r)}`);
      if (removed.length > 50) lines.push(`  …-${removed.length - 50} more`);
    }
    if (changed.length) {
      lines.push(`~ Changed (${changed.length})`);
      for (const c of changed.slice(0, 50)) lines.push(`  ~ ${formatChange(c.before, c.after)}`);
      if (changed.length > 50) lines.push(`  …~${changed.length - 50} more`);
    }
  }

  return {
    beforeId: before.id,
    afterId: after.id,
    beforeUrl: before.url,
    afterUrl: after.url,
    text: lines.join("\n"),
    addedUids: added.length,
    removedUids: removed.length,
    changedUids: changed.length,
    unchangedUids: unchanged,
  };
}

function flatten(treeJson: string): Map<string, NodeRow> {
  const out = new Map<string, NodeRow>();
  let root: any;
  try {
    root = JSON.parse(treeJson);
  } catch {
    return out;
  }
  if (!root) return out;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n?.uid) {
      out.set(n.uid, {
        uid: n.uid,
        role: n.role ?? "",
        name: n.name ?? "",
        value: n.value ?? "",
        flags: n.flags ?? [],
      });
    }
    if (Array.isArray(n?.children)) {
      for (const c of n.children) stack.push(c);
    }
  }
  return out;
}

function sameRow(a: NodeRow, b: NodeRow): boolean {
  if (a.role !== b.role) return false;
  if (a.name !== b.name) return false;
  if ((a.value ?? "") !== (b.value ?? "")) return false;
  if (a.flags.length !== b.flags.length) return false;
  // Order-insensitive flag comparison.
  const aFlags = [...a.flags].sort().join(",");
  const bFlags = [...b.flags].sort().join(",");
  return aFlags === bFlags;
}

function formatRow(r: NodeRow): string {
  const tail = r.value ? ` "${truncate(r.value, 40)}"` : "";
  const flags = r.flags.length ? ` [${r.flags.join(",")}]` : "";
  return `[${r.uid}] ${r.role} "${truncate(r.name, 40)}"${tail}${flags}`;
}

function formatChange(before: NodeRow, after: NodeRow): string {
  const parts: string[] = [`[${after.uid}] ${after.role}`];
  if (before.name !== after.name) {
    parts.push(`name: "${truncate(before.name, 30)}" → "${truncate(after.name, 30)}"`);
  }
  if ((before.value ?? "") !== (after.value ?? "")) {
    parts.push(`value: "${truncate(before.value ?? "", 30)}" → "${truncate(after.value ?? "", 30)}"`);
  }
  const beforeFlags = [...before.flags].sort().join(",");
  const afterFlags = [...after.flags].sort().join(",");
  if (beforeFlags !== afterFlags) {
    parts.push(`flags: [${beforeFlags}] → [${afterFlags}]`);
  }
  return parts.join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
