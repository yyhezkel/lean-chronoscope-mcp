import { z } from "zod";
import type { InputActionResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

type ToolName =
  | "click"
  | "hover"
  | "type"
  | "fill_form"
  | "key"
  | "scroll"
  | "drag";

function buildResponse(toolName: ToolName, r: InputActionResult): ReturnType<McpResponse["build"]> {
  const lines: string[] = [];
  lines.push(`${toolName} completed in ${r.durationMs}ms`);
  if (r.navigatedTo) lines.push(`Navigated to: ${r.navigatedTo}`);
  return new McpResponse()
    .addSection("Result", lines.join("\n"))
    .addSection("Ran code", r.code.map((l) => "  " + l).join("\n"))
    .setStructured(r as unknown as Record<string, unknown>)
    .build();
}

export const click = defineTool({
  name: "click",
  description: "Click an element by uid (from latest snapshot). Auto-scrolls into view.",
  category: "input",
  inputSchema: z.object({
    uid: z.string().describe("Element uid from snapshot, e.g. e12"),
    pageId: z.string().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.click", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return buildResponse("click", r);
  },
});

export const hover = defineTool({
  name: "hover",
  description: "Hover the mouse over an element by uid.",
  category: "input",
  inputSchema: z.object({
    uid: z.string(),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.hover", { sessionId: ctx.sessionId, ...input });
    return buildResponse("hover", r);
  },
});

export const typeText = defineTool({
  name: "type",
  description: "Click the element by uid, then type text. By default clears the field first.",
  category: "input",
  inputSchema: z.object({
    uid: z.string(),
    text: z.string(),
    delay: z.number().int().nonnegative().optional(),
    clear: z.boolean().optional(),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.type", { sessionId: ctx.sessionId, ...input });
    return buildResponse("type", r);
  },
});

export const fillForm = defineTool({
  name: "fill_form",
  description:
    "Fill multiple form fields in one call (text/select/check). Prefer over multiple `type` calls — reduces turn count.",
  category: "input",
  inputSchema: z.object({
    fields: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("text").optional(), uid: z.string(), value: z.string(), clear: z.boolean().optional() }) as any,
          z.object({ kind: z.literal("select"), uid: z.string(), value: z.string() }),
          z.object({ kind: z.literal("check"), uid: z.string(), value: z.boolean() }),
        ]),
      )
      .min(1),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.fill_form", { sessionId: ctx.sessionId, ...input });
    return buildResponse("fill_form", r);
  },
});

export const key = defineTool({
  name: "key",
  description: "Press a key or chord on the focused element/page. Example: \"Control+Enter\", \"Escape\".",
  category: "input",
  inputSchema: z.object({
    keys: z.string(),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.key", { sessionId: ctx.sessionId, ...input });
    return buildResponse("key", r);
  },
});

export const scroll = defineTool({
  name: "scroll",
  description: "Scroll the page or a specific element by uid.",
  category: "input",
  inputSchema: z.object({
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().positive().optional(),
    uid: z.string().optional(),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.scroll", { sessionId: ctx.sessionId, ...input });
    return buildResponse("scroll", r);
  },
});

export const drag = defineTool({
  name: "drag",
  description: "Drag from one element uid to another.",
  category: "input",
  inputSchema: z.object({
    fromUid: z.string(),
    toUid: z.string(),
    pageId: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InputActionResult>("input.drag", { sessionId: ctx.sessionId, ...input });
    return buildResponse("drag", r);
  },
});
