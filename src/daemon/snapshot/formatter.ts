import type { SnapshotNode, SnapshotResult } from "./TextSnapshot.js";

/** Render aria tree as indented text with [uid] role "name" markers. */
export function formatSnapshot(snap: SnapshotResult): string {
  if (!snap.root) return "(empty snapshot)";
  const lines: string[] = [];
  walk(snap.root, 0, lines);
  return lines.join("\n");
}

function walk(node: SnapshotNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const isInteresting = node.uid.length > 0;
  if (isInteresting) {
    const parts: string[] = [];
    parts.push(`[${node.uid}]`);
    if (node.role) parts.push(node.role);
    if (node.name) parts.push(JSON.stringify(node.name));
    if (node.value) parts.push(`= ${JSON.stringify(node.value)}`);
    if (node.flags.length) parts.push(`(${node.flags.join(",")})`);
    out.push(indent + parts.join(" "));
    for (const c of node.children) walk(c, depth + 1, out);
  } else {
    // Skip the noise wrapper but render its children at same depth.
    for (const c of node.children) walk(c, depth, out);
  }
}

/** Count interesting (uid-bearing) nodes for the structuredContent header. */
export function countInteresting(node: SnapshotNode): number {
  let n = node.uid ? 1 : 0;
  for (const c of node.children) n += countInteresting(c);
  return n;
}
