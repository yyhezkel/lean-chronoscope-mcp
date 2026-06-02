import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../tools/ToolDefinition.js";

/**
 * Renders the content for `browser://docs/tools` — a JSON dump of every
 * registered MCP tool's name/category/description/input schema. Generated on
 * the MCP-server side (not the daemon) because tool schemas live here.
 */
export function renderDocsTools(allTools: ToolDefinition[]): string {
  const tools = allTools.map((t) => ({
    name: t.name,
    category: t.category,
    description: t.description,
    inputSchema: schemaJson(t.inputSchema),
  }));
  return JSON.stringify({ version: 1, count: tools.length, tools }, null, 2);
}

function schemaJson(schema: ToolDefinition["inputSchema"]): unknown {
  const json = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete json.$schema;
  delete (json as { definitions?: unknown }).definitions;
  return json;
}
