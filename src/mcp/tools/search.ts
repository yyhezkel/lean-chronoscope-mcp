import { z } from "zod";
import type { ConsoleSearchResult, NetworkSearchResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const SearchInput = z.object({
  query: z.string().min(1).describe("FTS5 MATCH expression, e.g. `error AND timeout`"),
  pageSize: z.number().int().min(1).max(200).optional(),
});

export const consoleSearch = defineTool({
  name: "console_search",
  description: "Full-text search across captured console messages, BM25-ranked.",
  category: "console",
  inputSchema: SearchInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<ConsoleSearchResult>("console.search", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const body =
      r.rows.length === 0
        ? "(no matches)"
        : r.rows.map((m) => `[${m.level}] #${m.id} ${m.snippet}`).join("\n");
    return new McpResponse()
      .addSection(`Matches (${r.total} total, showing ${r.rows.length})`, body)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const networkSearch = defineTool({
  name: "network_search",
  description: "Full-text search across captured network requests (URL + req/res body), BM25-ranked.",
  category: "network",
  inputSchema: SearchInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<NetworkSearchResult>("network.search", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const body =
      r.rows.length === 0
        ? "(no matches)"
        : r.rows
            .map((m) => `#${m.id} ${m.method} ${m.status ?? "..."} ${m.url}\n        ${m.snippet}`)
            .join("\n");
    return new McpResponse()
      .addSection(`Matches (${r.total} total, showing ${r.rows.length})`, body)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
