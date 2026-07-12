import { z } from "zod";
import type {
  PageNewResult,
  SessionCloseResult,
  SessionEnsureResult,
  SessionListResult,
  SessionResolveResult,
} from "@shared/protocol.js";
import { randomSessionId } from "@shared/ids.js";
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

export const sessionAttach = defineTool({
  name: "session_attach",
  description:
    "Point this connection at an existing session — by id or by human title — so every later tool acts on it. Rehydrates a closed session's captured history from disk. If a title matches no session, starts a new one carrying that title (attach-or-create).",
  category: "session",
  inputSchema: z
    .object({
      sessionId: z.string().min(1).optional(),
      title: z.string().min(1).optional(),
    })
    .refine((v) => Boolean(v.sessionId || v.title), {
      message: "provide sessionId or title",
    }),
  handler: async (input, ctx) => {
    let targetId = input.sessionId;
    if (!targetId && input.title) {
      const resolved = await ctx.daemon.call<SessionResolveResult>("session.resolve", {
        title: input.title,
      });
      targetId = resolved.sessionId ?? undefined;
    }
    const creatingFresh = !targetId; // title matched nothing → attach-or-create
    const id = targetId ?? randomSessionId();

    const r = await ctx.daemon.call<SessionEnsureResult>("session.ensure", {
      sessionId: id,
      title: input.title,
    });

    // Switch the active session for all subsequent tool calls on this connection.
    ctx.sessionId = r.sessionId;

    const verb = !r.created ? "Attached to" : creatingFresh ? "Created" : "Rehydrated";
    const titleNote = input.title ? ` (title: ${input.title})` : "";
    return new McpResponse()
      .addSection(
        "Result",
        `${verb} session ${r.sessionId}${titleNote}; active page ${r.currentPageId ?? "-"}`,
      )
      .setStructured({
        sessionId: r.sessionId,
        title: input.title ?? null,
        created: r.created,
        attached: true,
        currentPageId: r.currentPageId,
      })
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
