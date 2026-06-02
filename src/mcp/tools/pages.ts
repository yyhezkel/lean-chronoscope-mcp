import { z } from "zod";
import type {
  DaemonMethod,
  PageCloseResult,
  PageHistoryResult,
  PageListResult,
  PageNavigateResult,
  PageNewResult,
  PageSelectResult,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const PageNavigateInput = z.object({
  url: z.string().url(),
  pageId: z.string().optional(),
  waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const pageNavigate = defineTool({
  name: "page_navigate",
  description: "Navigate the current (or specified) page to a URL. Auto-creates a page if none exists in this session.",
  category: "pages",
  inputSchema: PageNavigateInput,
  handler: async (input, ctx) => {
    const result = await ctx.daemon.call<PageNavigateResult>("page.navigate", {
      sessionId: ctx.sessionId,
      pageId: input.pageId,
      url: input.url,
      waitUntil: input.waitUntil,
      timeoutMs: input.timeoutMs,
    });
    return new McpResponse()
      .addSection(
        "Result",
        `Navigated to ${result.url}\nStatus: ${result.status ?? "(no response)"}\nTitle: ${result.title}\nTook: ${result.durationMs}ms\npageId: ${result.pageId}`,
      )
      .setStructured(result as unknown as Record<string, unknown>)
      .build();
  },
});

export const pageList = defineTool({
  name: "page_list",
  description: "List open pages (tabs) in this session with their URLs and which is selected.",
  category: "pages",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const r = await ctx.daemon.call<PageListResult>("page.list", { sessionId: ctx.sessionId });
    const body =
      r.pages.length === 0
        ? "(no pages)"
        : r.pages
            .map((p) => `${p.selected ? "*" : " "} [${p.pageId}] ${p.title || "(untitled)"} — ${p.url}`)
            .join("\n");
    return new McpResponse()
      .addSection("Pages", body, { changeKey: `${ctx.sessionId}:pages` })
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const pageNew = defineTool({
  name: "page_new",
  description: "Open a new page (tab). Optionally navigate to a URL and/or open in the background (don't switch to it).",
  category: "pages",
  inputSchema: z.object({
    url: z.string().url().optional(),
    background: z.boolean().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<PageNewResult>("page.new", {
      sessionId: ctx.sessionId,
      url: input.url,
      background: input.background,
    });
    return new McpResponse()
      .addSection("Result", `Opened ${r.pageId}\n${r.title || "(untitled)"} — ${r.url}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const pageSelect = defineTool({
  name: "page_select",
  description: "Make a page (tab) the active target for subsequent tools.",
  category: "pages",
  inputSchema: z.object({ pageId: z.string().min(1) }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<PageSelectResult>("page.select", {
      sessionId: ctx.sessionId,
      pageId: input.pageId,
    });
    return new McpResponse()
      .addSection("Result", `Selected ${r.pageId}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const pageClose = defineTool({
  name: "page_close",
  description: "Close a page (tab). Defaults to the active page. Re-selects another page if the closed one was active.",
  category: "pages",
  inputSchema: z.object({ pageId: z.string().optional() }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<PageCloseResult>("page.close", {
      sessionId: ctx.sessionId,
      pageId: input.pageId,
    });
    return new McpResponse()
      .addSection("Result", `Closed ${r.closedPageId}; selected now: ${r.selectedPageId ?? "(none)"}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function historyTool(name: string, method: DaemonMethod, verb: string) {
  return defineTool({
    name,
    description: `${verb} the active (or specified) page.`,
    category: "pages",
    inputSchema: z.object({ pageId: z.string().optional() }),
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<PageHistoryResult>(method, {
        sessionId: ctx.sessionId,
        pageId: input.pageId,
      });
      const msg = r.navigated ? `${verb} → ${r.url}` : `Nothing to ${verb.toLowerCase()}`;
      return new McpResponse()
        .addSection("Result", msg)
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

export const pageBack = historyTool("page_back", "page.back", "Go back");
export const pageForward = historyTool("page_forward", "page.forward", "Go forward");
export const pageReload = historyTool("page_reload", "page.reload", "Reload");
