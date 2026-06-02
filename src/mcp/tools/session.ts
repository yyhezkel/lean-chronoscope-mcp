import { z } from "zod";
import type {
  PageNewResult,
  SessionCloseResult,
  SessionListResult,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

export const sessionList = defineTool({
  name: "session_list",
  description: "List all browser sessions on the daemon (each is an isolated BrowserContext).",
  category: "session",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const r = await ctx.daemon.call<SessionListResult>("session.list", {});
    const body =
      r.sessions.length === 0
        ? "(no sessions)"
        : r.sessions
            .map((s) => `${s.id === ctx.sessionId ? "*" : " "} ${s.id}  pages=${s.pageCount} selected=${s.selectedPageId ?? "-"}`)
            .join("\n");
    return new McpResponse()
      .addSection("Sessions", body)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const sessionNew = defineTool({
  name: "session_new",
  description:
    "Ensure a session exists and open its first page. Note: this MCP connection is bound to its own session id; `session_new` is mainly for pre-creating other sessions. Returns the new page.",
  category: "session",
  inputSchema: z.object({
    url: z.string().url().optional(),
  }),
  handler: async (input, ctx) => {
    // The daemon auto-ensures ctx.sessionId; opening a page is the observable effect.
    const r = await ctx.daemon.call<PageNewResult>("page.new", {
      sessionId: ctx.sessionId,
      url: input.url,
    });
    return new McpResponse()
      .addSection("Result", `Session ${ctx.sessionId} ready; page ${r.pageId} — ${r.url}`)
      .setStructured({ sessionId: ctx.sessionId, ...r })
      .build();
  },
});

export const sessionClose = defineTool({
  name: "session_close",
  description: "Close a session: dispose its browser context, pages, and database. Defaults to this connection's own session.",
  category: "session",
  inputSchema: z.object({ sessionId: z.string().optional() }),
  handler: async (input, ctx) => {
    const target = input.sessionId ?? ctx.sessionId;
    const r = await ctx.daemon.call<SessionCloseResult>("session.close", { sessionId: target });
    return new McpResponse()
      .addSection("Result", r.closed ? `Closed session ${r.sessionId}` : `Session ${r.sessionId} not found`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
