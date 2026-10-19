import { z } from "zod";
import type { ConsoleSearchResult, NetworkSearchResult } from "@shared/protocol.js";
import { loadRedactConfigFromEnv, redactBody, redactUrl } from "@shared/redact.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const REDACT_CFG = loadRedactConfigFromEnv();

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
    const raw = await ctx.daemon.call<ConsoleSearchResult>("console.search", {
      sessionId: ctx.sessionId,
      ...input,
    });
    // Search rows carry no source url → gated as external (see shouldRedact).
    const r: ConsoleSearchResult = {
      ...raw,
      rows: raw.rows.map((m) => ({
        ...m,
        text: redactBody(m.text, null, REDACT_CFG)!,
        snippet: redactBody(m.snippet, null, REDACT_CFG)!,
      })),
    };
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
    const raw = await ctx.daemon.call<NetworkSearchResult>("network.search", {
      sessionId: ctx.sessionId,
      ...input,
    });
    // The snippet is currently the URL itself (reader.ts) but may become body text,
    // so run both URL and body redaction over it, gated on the request's url.
    const r: NetworkSearchResult = {
      ...raw,
      rows: raw.rows.map((m) => ({
        ...m,
        url: redactUrl(m.url, REDACT_CFG),
        snippet: redactBody(redactUrl(m.snippet, REDACT_CFG), m.url, REDACT_CFG)!,
      })),
    };
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
