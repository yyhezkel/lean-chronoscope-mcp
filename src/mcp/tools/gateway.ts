import { z } from "zod";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool, type ToolDefinition } from "./ToolDefinition.js";
import { allTools, getTool } from "./tools.js";
import { toJsonSchemaDraft2020 } from "./jsonschema.js";

// Gateway mode: instead of mounting all 56 tool schemas (~5,258 tokens), expose
// a 3-tool base. The model reads the catalog (names + one-liners), loads the
// full schema only for the tools it actually needs, then invokes by name.
// Reproduces client-side tool deferral for MCP clients that don't have it.
// (Claude Code already defers schemas natively, so this is opt-in, not default.)

const GATEWAY_CATEGORY = "gateway";

function oneLiner(desc: string): string {
  const firstSentence = desc.split(/(?<=[.!?])\s/)[0] ?? desc;
  const s = firstSentence.length > 100 ? firstSentence.slice(0, 97) + "…" : firstSentence;
  return s.replace(/\s+/g, " ").trim();
}

export const toolsCatalog = defineTool({
  name: "tools_catalog",
  description:
    "List the available browser tools (name + one-line purpose), grouped by category. Pick the ones you need, fetch their inputs with `tool_schema`, then run them with `tools_invoke`.",
  category: GATEWAY_CATEGORY,
  inputSchema: z.object({
    category: z.string().optional().describe("Filter to a single category, e.g. \"storage\"."),
  }),
  handler: async (input) => {
    const byCat = new Map<string, ToolDefinition<any>[]>();
    for (const t of allTools) {
      if (input.category && t.category !== input.category) continue;
      const arr = byCat.get(t.category) ?? [];
      arr.push(t);
      byCat.set(t.category, arr);
    }
    const lines: string[] = [];
    const structured: Record<string, { name: string }[]> = {};
    for (const [cat, tools] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`## ${cat}`);
      structured[cat] = [];
      for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
        lines.push(`  ${t.name} — ${oneLiner(t.description)}`);
        structured[cat].push({ name: t.name });
      }
    }
    const total = Object.values(structured).reduce((n, a) => n + a.length, 0);
    const body = total === 0 ? `(no tools in category "${input.category}")` : lines.join("\n");
    return new McpResponse()
      .addSection(`Tools (${total})`, body)
      .addSection("Next", "Call `tool_schema {names:[...]}` for inputs, then `tools_invoke {tool, args}`.")
      .setStructured({ total, categories: structured })
      .build();
  },
});

export const toolSchema = defineTool({
  name: "tool_schema",
  description:
    "Get the full input schema(s) for one or more tools (names from `tools_catalog`). Load only the tools you'll actually call.",
  category: GATEWAY_CATEGORY,
  inputSchema: z.object({
    names: z.array(z.string().min(1)).min(1).describe("Tool names to fetch schemas for."),
  }),
  handler: async (input) => {
    const found: Record<string, unknown> = {};
    const missing: string[] = [];
    const blocks: string[] = [];
    for (const name of input.names) {
      const t = getTool(name);
      if (!t || t.category === GATEWAY_CATEGORY) {
        missing.push(name);
        continue;
      }
      const schema = toJsonSchemaDraft2020(t.inputSchema);
      found[name] = { description: t.description, inputSchema: schema };
      blocks.push(`### ${name}\n${t.description}\n\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``);
    }
    const resp = new McpResponse().addSection("Schemas", blocks.length ? blocks.join("\n\n") : "(none found)");
    if (missing.length) resp.addSection("Not found", missing.join(", "));
    return resp.setStructured({ schemas: found, missing }).build();
  },
});

export const toolsInvoke = defineTool({
  name: "tools_invoke",
  description:
    "Run a browser tool by name with its arguments. Discover tools via `tools_catalog` and their inputs via `tool_schema`. Behaves exactly like calling the tool directly.",
  category: GATEWAY_CATEGORY,
  inputSchema: z.object({
    tool: z.string().min(1).describe("Tool name, e.g. \"page_navigate\"."),
    args: z.record(z.any()).optional().describe("Arguments object for that tool (see tool_schema)."),
  }),
  handler: async (input, ctx) => {
    const tool = getTool(input.tool);
    if (!tool || tool.category === GATEWAY_CATEGORY) {
      return new McpResponse().setError(`Unknown tool: ${input.tool}`).build();
    }
    const parsed = tool.inputSchema.safeParse(input.args ?? {});
    if (!parsed.success) {
      return new McpResponse()
        .setError(`Invalid arguments for ${input.tool}: ${parsed.error.message}`)
        .build();
    }
    return tool.handler(parsed.data, ctx);
  },
});

export const gatewayTools: ToolDefinition<any>[] = [toolsCatalog, toolSchema, toolsInvoke];
