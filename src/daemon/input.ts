import type { CDPSession, Page } from "puppeteer-core";
import { DaemonError } from "@shared/errors.js";
import type { PageState } from "./session-registry.js";

/** Resolved DOM element from a snapshot uid. */
export interface ResolvedElement {
  uid: string;
  backendNodeId: number;
  /** Center coordinates in CSS pixels, after scroll-into-view. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Look up an element by snapshot uid: scroll into view, return bbox center. */
export async function resolveElement(state: PageState, uid: string): Promise<ResolvedElement> {
  const ref = state.snapshot.resolveUid(uid);
  if (!ref) throw DaemonError.invalidParams(`uid ${uid} not found — take a fresh snapshot first`);

  const client = await state.page.createCDPSession();
  try {
    // Scroll into view (CDP-native; works even if Puppeteer's JSHandle is unavailable).
    await client.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId } as any).catch(() => {});

    const box = (await client.send("DOM.getBoxModel", { backendNodeId: ref.backendNodeId } as any).catch(() => null)) as
      | { model: { content: number[]; width: number; height: number } }
      | null;
    if (!box?.model) throw DaemonError.invalidParams(`uid ${uid} has no layout box (offscreen/hidden?)`);

    // content quad is [x1,y1,x2,y2,x3,y3,x4,y4] — top-left, top-right, bottom-right, bottom-left.
    const q = box.model.content;
    const x = (q[0]! + q[4]!) / 2;
    const y = (q[1]! + q[5]!) / 2;
    return { uid: ref.uid, backendNodeId: ref.backendNodeId, x, y, width: box.model.width, height: box.model.height };
  } finally {
    try { await client.detach(); } catch { /* ignore */ }
  }
}

/** Wait briefly for any navigation triggered by an action; return the new URL if changed. */
export async function waitForPotentialNavigation(page: Page, prevUrl: string, timeoutMs = 5000): Promise<string | undefined> {
  try {
    await page.waitForNavigation({ waitUntil: "load", timeout: timeoutMs });
    const after = page.url();
    return after !== prevUrl ? after : undefined;
  } catch {
    return undefined;
  }
}
