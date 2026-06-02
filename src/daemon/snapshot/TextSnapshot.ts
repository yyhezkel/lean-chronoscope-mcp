import type { CDPSession, Page } from "puppeteer-core";
import { UidMap, type NodeRef } from "./uid-map.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/snapshot");

export interface SnapshotNode {
  uid: string;
  backendNodeId: number;
  role: string;
  name: string;
  value?: string;
  description?: string;
  children: SnapshotNode[];
  /** Compact boolean flags: focusable, disabled, checked, expanded, selected. */
  flags: string[];
}

export interface SnapshotResult {
  url: string;
  title: string;
  loaderId: string;
  ts: number;
  root: SnapshotNode | null;
  uidCount: number;
}

// Roles we consider non-interesting (skip outright unless they carry text).
const NOISE_ROLES = new Set([
  "presentation",
  "none",
  "generic",
  "RootWebArea",
  "LineBreak",
  "InlineTextBox",
  "StaticText",
]);

/** Per-page snapshot service. Holds the latest UidMap for input-tool resolution. */
export class SnapshotService {
  readonly uids = new UidMap();

  constructor(private readonly page: Page) {}

  async take(): Promise<SnapshotResult> {
    const session: CDPSession = await this.page.createCDPSession();
    try {
      await session.send("Accessibility.enable");
      const { nodes } = (await session.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
      const loaderId = (this.page.mainFrame() as any)._loaderId ?? "loader_unknown";
      this.uids.beginSnapshot(loaderId);

      const byNodeId = new Map<string, AxNode>(nodes.map((n) => [n.nodeId, n]));
      const root = nodes.find((n) => !n.parentId) ?? nodes[0];
      const tree = root ? this.buildTree(root, byNodeId) : null;
      return {
        url: this.page.url(),
        title: await this.page.title(),
        loaderId,
        ts: Date.now(),
        root: tree,
        uidCount: this.uids.size(),
      };
    } finally {
      try {
        await session.detach();
      } catch (err) {
        log.warn({ err }, "snapshot session detach failed");
      }
    }
  }

  resolveUid(uid: string): NodeRef | undefined {
    return this.uids.resolve(uid);
  }

  private buildTree(node: AxNode, byId: Map<string, AxNode>): SnapshotNode | null {
    const children: SnapshotNode[] = [];
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      const built = this.buildTree(child, byId);
      if (built) {
        // If child is "noise" and has no own value, hoist its children into us.
        if (built.role === "" || NOISE_ROLES.has(built.role)) {
          children.push(...built.children);
        } else {
          children.push(built);
        }
      }
    }

    const role = node.role?.value ?? "";
    const name = stringProp(node.name);
    const value = stringProp(node.value);
    const description = stringProp(node.description);
    const flags = flagsFor(node);
    const backendId = node.backendDOMNodeId ?? 0;
    const isInteresting =
      !NOISE_ROLES.has(role) && (role || name || value) && backendId > 0 && !node.ignored;

    let uid = "";
    if (isInteresting) {
      uid = this.uids.upsert(backendId, role, name);
    }

    return {
      uid,
      backendNodeId: backendId,
      role,
      name,
      value: value || undefined,
      description: description || undefined,
      children,
      flags,
    };
  }
}

interface AxNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: any } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

function stringProp(p: { value?: any } | undefined): string {
  if (!p) return "";
  const v = p.value;
  return typeof v === "string" ? v : v != null ? String(v) : "";
}

function flagsFor(node: AxNode): string[] {
  const flags: string[] = [];
  for (const prop of node.properties ?? []) {
    if (prop.value?.value === true) {
      flags.push(prop.name);
    }
  }
  return flags;
}
