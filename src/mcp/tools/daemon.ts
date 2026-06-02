import { z } from "zod";
import type { DaemonStatusResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

export const daemonStatus = defineTool({
  name: "daemon_status",
  description:
    "Diagnostic snapshot of the daemon: version, uptime, browser link, per-session row counts and disk usage, subscription count.",
  category: "daemon",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const r = await ctx.daemon.call<DaemonStatusResult>("daemon.status", {});
    const header = `v${r.version}  uptime=${r.uptimeSec}s  browser=${r.browserConnected ? "✓" : "✗"}  subs=${r.subscriptions}  sessions=${r.sessions.length}`;
    const lines: string[] = [];
    for (const s of r.sessions) {
      const sel = s.selectedPageId ?? "-";
      const bytes = `${(s.dbBytes / 1024).toFixed(1)}K db + ${(s.blobBytes / 1024).toFixed(1)}K blobs`;
      lines.push(`  [${s.id}] pages=${s.pageCount} sel=${sel} console=${s.consoleRows} net=${s.networkRows} snap=${s.snapshotRows} exc=${s.exceptionRows} rules=${s.interceptRules}  ${bytes}`);
    }
    return new McpResponse()
      .addSection("Daemon", header)
      .addSection("Sessions", lines.length ? lines.join("\n") : "(none)")
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
