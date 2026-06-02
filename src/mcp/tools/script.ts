import { z } from "zod";
import type { PageEvaluateResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const Input = z.object({
  expression: z
    .string()
    .min(1)
    .describe("JS to run in the page. Use explicit `return` for a value when passing multiple statements."),
  awaitPromise: z.boolean().optional().describe("Await the expression if it returns a Promise."),
  pageId: z.string().optional(),
});

export const scriptEvaluate = defineTool({
  name: "script_evaluate",
  description:
    "Evaluate JavaScript in the active (or specified) page and return the result. Single expressions are auto-returned; multi-statement bodies need an explicit `return`.",
  category: "script",
  inputSchema: Input,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<PageEvaluateResult>("page.evaluate", {
      sessionId: ctx.sessionId,
      ...input,
    });
    if (r.isError) {
      return new McpResponse().setError(r.errorText ?? "evaluation failed").build();
    }
    let rendered: string;
    try {
      rendered = typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
    } catch {
      rendered = String(r.value);
    }
    if (rendered != null && rendered.length > 10_000) rendered = rendered.slice(0, 10_000) + "…[truncated]";
    return new McpResponse()
      .addSection("Result", rendered ?? "undefined")
      .setStructured({ pageId: r.pageId, value: r.value })
      .build();
  },
});
