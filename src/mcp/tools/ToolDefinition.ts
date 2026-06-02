import type { z } from "zod";
import type { DaemonClient } from "../daemon-client.js";
import type { McpToolResponse } from "../response/McpResponse.js";

export interface ToolContext {
  sessionId: string;
  daemon: DaemonClient;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  category: string;
  inputSchema: z.ZodType<Input>;
  /** Pre-validated input. */
  handler: (input: Input, ctx: ToolContext) => Promise<McpToolResponse>;
}

export function defineTool<Input>(def: ToolDefinition<Input>): ToolDefinition<Input> {
  return def;
}
