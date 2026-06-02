import { z } from "zod";
import type { ConsoleGetResult, ConsoleListResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";
import { groupConsecutive } from "../formatters/ConsoleFormatter.js";
import { paginationMeta } from "../pagination.js";

const ConsoleListInput = z.object({
  pageId: z.string().optional(),
  navId: z.number().int().optional(),
  level: z.enum(["log", "info", "warn", "error", "debug", "trace"]).optional(),
  includePreserved: z.boolean().optional(),
  sinceTs: z.number().int().optional(),
  pageIdx: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
  group: z.boolean().optional().describe("Collapse consecutive identical messages (default true)"),
});

export const consoleList = defineTool({
  name: "console_list",
  description:
    "List captured console messages from the page, paginated. Default scope: current navigation only. Pass `includePreserved:true` for the last 3 navs. Use `console_get` for stack traces / arg details.",
  category: "console",
  inputSchema: ConsoleListInput,
  handler: async (input, ctx) => {
    const result = await ctx.daemon.call<ConsoleListResult>("console.list", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const meta = paginationMeta(result.total, result.pageIdx, result.pageSize);
    const lines = (input.group !== false ? groupConsecutive(result.rows) : result.rows.map((r) => ({ msgid: r.id, text: formatRow(r) })))
      .map((l) => l.text)
      .join("\n");
    const body = result.total === 0 ? "(no messages)" : lines;
    return new McpResponse()
      .addSection("Console", body, { changeKey: `${ctx.sessionId}:console` })
      .addSection("Pagination", `Showing ${meta.showing} (page ${meta.pageIdx + 1} of ${meta.pages})${meta.hasNext ? ` — pass pageIdx:${meta.pageIdx + 1} for next` : ""}`)
      .setStructured({ ...result, pagination: meta })
      .build();
  },
});

const ConsoleGetInput = z.object({
  msgid: z.number().int().positive(),
});

export const consoleGet = defineTool({
  name: "console_get",
  description: "Fetch full detail of one console message (stack trace, args).",
  category: "console",
  inputSchema: ConsoleGetInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<ConsoleGetResult>("console.get", {
      sessionId: ctx.sessionId,
      id: input.msgid,
    });
    const lines: string[] = [];
    lines.push(`#${r.id} [${r.level}] ${new Date(r.ts).toISOString()}`);
    lines.push(r.text);
    if (r.url) lines.push(`At: ${r.url}:${r.line ?? "?"}:${r.col ?? "?"}`);
    if (r.stack) lines.push(`\nStack:\n${r.stack}`);
    if (r.args) lines.push(`\nArgs:\n${r.args}`);
    return new McpResponse()
      .addSection("Message", lines.join("\n"))
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function formatRow(r: { id: number; level: string; ts: number; text: string }): string {
  const ts = new Date(r.ts).toISOString().slice(11, 23);
  return `[${r.level}] ${ts} #${r.id} ${r.text}`;
}
