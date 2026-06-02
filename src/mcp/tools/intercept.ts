import { z } from "zod";
import type {
  InterceptAddResult,
  InterceptListResult,
  InterceptRemoveResult,
  InterceptRuleWire,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const ActionAbort = z.object({
  kind: z.literal("abort"),
  reason: z.string().optional().describe("CDP error reason: Aborted, Failed, AddressUnreachable, etc."),
});
const ActionContinue = z.object({
  kind: z.literal("continue"),
  url: z.string().url().optional(),
  method: z.string().optional(),
  postData: z.string().optional(),
  headers: z.record(z.string()).optional(),
});
const ActionRespond = z.object({
  kind: z.literal("respond"),
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  mimeType: z.string().optional(),
});
const Action = z.discriminatedUnion("kind", [ActionAbort, ActionContinue, ActionRespond]);

const InterceptAddInput = z.object({
  urlPattern: z.string().min(1).describe("CDP-style glob, e.g. `https://api.example.com/*`"),
  method: z.string().optional().describe("Optional case-insensitive method filter (GET, POST, ...)"),
  oneShot: z.boolean().optional().describe("Remove rule after first match. Default false."),
  action: Action,
});

export const interceptAdd = defineTool({
  name: "intercept_add",
  description:
    "Add a network interception rule. Action variants: `abort` (network failure), `continue` (with optional header/method/URL/body overrides), `respond` (synthesize a response without contacting the server). Rules apply to every page in the session, including pages opened later.",
  category: "intercept",
  inputSchema: InterceptAddInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InterceptAddResult>("intercept.add", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", `Added rule ${r.rule.id}\n${formatRule(r.rule)}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

export const interceptList = defineTool({
  name: "intercept_list",
  description: "List active interception rules for this session.",
  category: "intercept",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const r = await ctx.daemon.call<InterceptListResult>("intercept.list", {
      sessionId: ctx.sessionId,
    });
    const body = r.rules.length === 0 ? "(no rules)" : r.rules.map(formatRule).join("\n");
    return new McpResponse()
      .addSection("Rules", body, { changeKey: `${ctx.sessionId}:intercept` })
      .setStructured({ count: r.rules.length, rules: r.rules })
      .build();
  },
});

const InterceptRemoveInput = z.object({ id: z.string().min(1) });
export const interceptRemove = defineTool({
  name: "intercept_remove",
  description: "Remove an interception rule by id.",
  category: "intercept",
  inputSchema: InterceptRemoveInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<InterceptRemoveResult>("intercept.remove", {
      sessionId: ctx.sessionId,
      id: input.id,
    });
    return new McpResponse()
      .addSection("Result", r.removed ? `Removed ${r.id}` : `Rule ${r.id} not found`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function formatRule(r: InterceptRuleWire): string {
  const flags: string[] = [];
  if (r.oneShot) flags.push("oneShot");
  if (r.method) flags.push(`method=${r.method.toUpperCase()}`);
  const tag = flags.length ? ` (${flags.join(", ")})` : "";
  const action =
    r.action.kind === "abort"
      ? `abort${r.action.reason ? `:${r.action.reason}` : ""}`
      : r.action.kind === "continue"
        ? "continue" +
          [
            r.action.url && `url=${r.action.url}`,
            r.action.method && `method=${r.action.method}`,
            r.action.headers && `headers=${Object.keys(r.action.headers).length}`,
          ]
            .filter(Boolean)
            .reduce((acc, p) => `${acc} ${p}`, "")
        : `respond ${r.action.status}${r.action.mimeType ? ` (${r.action.mimeType})` : ""}`;
  return `[${r.id}] ${r.urlPattern}${tag}\n        → ${action}  hits=${r.hits}`;
}
