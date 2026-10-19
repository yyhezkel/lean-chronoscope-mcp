import { z } from "zod";
import type { SnapshotDiffResult, SnapshotTakeResult } from "@shared/protocol.js";
import { loadRedactConfigFromEnv, redactUrl } from "@shared/redact.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const REDACT_CFG = loadRedactConfigFromEnv();

const SnapshotTakeInput = z.object({
  pageId: z.string().optional(),
});

export const snapshotTake = defineTool({
  name: "snapshot_take",
  description:
    "Take an accessibility snapshot of the page. Returns a compact text tree where each interactive element is prefixed with `[uid]` (e.g. `[e12] button \"Save\"`). Use these UIDs as targets for `click`, `hover`, `type`, etc.",
  category: "snapshot",
  inputSchema: SnapshotTakeInput,
  handler: async (input, ctx) => {
    const raw = await ctx.daemon.call<SnapshotTakeResult>("snapshot.take", {
      sessionId: ctx.sessionId,
      pageId: input.pageId,
    });
    // Header/structured page URL only — link hrefs inside the tree text are not redacted.
    const r: SnapshotTakeResult = { ...raw, url: redactUrl(raw.url, REDACT_CFG) };
    return new McpResponse()
      .addSection(
        "Page",
        `${r.title} — ${r.url}\n${r.uidCount} interactive elements  snapshotId=${r.snapshotId}`,
        { changeKey: `${ctx.sessionId}:snapshot-header:${r.pageId}` },
      )
      .addSection("Snapshot", r.text, {
        changeKey: `${ctx.sessionId}:snapshot:${r.pageId}`,
      })
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const SnapshotDiffInput = z.object({
  beforeId: z.number().int().positive().optional(),
  afterId: z.number().int().positive().optional(),
  pageId: z.string().optional(),
});
export const snapshotDiff = defineTool({
  name: "snapshot_diff",
  description:
    "Diff two persisted snapshots, returning added / removed / changed elements. Pass both snapshot ids (from prior `snapshot_take` calls), or omit them to compare the latest two snapshots of the active page.",
  category: "snapshot",
  inputSchema: SnapshotDiffInput,
  handler: async (input, ctx) => {
    const raw = await ctx.daemon.call<SnapshotDiffResult>("snapshot.diff", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const r: SnapshotDiffResult = {
      ...raw,
      beforeUrl: redactUrl(raw.beforeUrl, REDACT_CFG),
      afterUrl: redactUrl(raw.afterUrl, REDACT_CFG),
    };
    const summary = `Diff #${r.beforeId} → #${r.afterId}\nadded=${r.addedUids} removed=${r.removedUids} changed=${r.changedUids} unchanged=${r.unchangedUids}`;
    return new McpResponse()
      .addSection("Summary", summary)
      .addSection("Patch", r.text)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
