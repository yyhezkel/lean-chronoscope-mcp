import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "@shared/logger.js";
import type { DaemonClient } from "./daemon-client.js";
import { McpResponse } from "./response/McpResponse.js";
import { registerResourceHandlers } from "./resources/handlers.js";
import { allTools, getTool, selectTools, type ToolMode } from "./tools/tools.js";
import { toJsonSchemaDraft2020 } from "./tools/jsonschema.js";

const log = getLogger("mcp/server");

export interface McpServerOptions {
  sessionId: string;
  daemon: DaemonClient;
  serverName?: string;
  serverVersion?: string;
  /** Which tool surface to advertise: "full" (default), "slim", or "gateway". */
  mode?: ToolMode;
}

export async function startMcpServer(opts: McpServerOptions): Promise<void> {
  const tools = selectTools(opts.mode ?? "full");
  const server = new Server(
    {
      name: opts.serverName ?? "lean-chronoscope-mcp",
      version: opts.serverVersion ?? "1.3.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
      },
    },
  );

  registerResourceHandlers({
    server,
    daemon: opts.daemon,
    sessionId: opts.sessionId,
    allTools,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: toJsonSchemaDraft2020(t.inputSchema),
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    // Slim mode hides tools from `tools/list`, but if a client still calls a
    // hidden tool we use the full registry to resolve it. This lets advanced
    // clients (or tests) call non-slim tools by name without listing.
    const tool = getTool(name);
    if (!tool) {
      return new McpResponse().setError(`Unknown tool: ${name}`).build() as never;
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return new McpResponse()
        .setError(`Invalid arguments for ${name}: ${parsed.error.message}`)
        .build() as never;
    }
    try {
      const result = await tool.handler(parsed.data, {
        sessionId: opts.sessionId,
        daemon: opts.daemon,
      });
      return result as never;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, tool: name }, "tool handler threw");
      return new McpResponse().setError(`${name} failed: ${msg}`).build() as never;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(
    { sessionId: opts.sessionId, mode: opts.mode ?? "full", advertised: tools.length },
    "mcp server ready",
  );
}
