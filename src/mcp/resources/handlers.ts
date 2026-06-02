import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "@shared/logger.js";
import type {
  ResourcesListResult,
  ResourcesReadResult,
} from "@shared/protocol.js";
import type { DaemonClient } from "../daemon-client.js";
import type { ToolDefinition } from "../tools/ToolDefinition.js";
import { renderDocsTools } from "./docs-tools.js";
import { DOCS_TOOLS_URI, isStaticMcpResource } from "./registry.js";

const log = getLogger("mcp/resources");

export interface ResourceHandlersOptions {
  server: Server;
  daemon: DaemonClient;
  sessionId: string;
  allTools: ToolDefinition[];
}

/**
 * Wires the MCP-server resource surface:
 *   resources/list, resources/read, resources/subscribe, resources/unsubscribe
 * + translates daemon `resource.updated` notifications into MCP
 *   `notifications/resources/updated`.
 *
 * Static URIs (currently just `browser://docs/tools`) are rendered locally
 * from the MCP tool registry; everything else round-trips to the daemon.
 */
export function registerResourceHandlers(opts: ResourceHandlersOptions): void {
  const { server, daemon, sessionId, allTools } = opts;

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await daemon.call<ResourcesListResult>("resources.list", { sessionId });
    return { resources: result.resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;

    if (uri === DOCS_TOOLS_URI) {
      return {
        contents: [
          { uri, mimeType: "application/json", text: renderDocsTools(allTools) },
        ],
      };
    }

    const result = await daemon.call<ResourcesReadResult>("resources.read", { uri });
    return {
      contents: [
        {
          uri: result.uri,
          mimeType: "application/json",
          text: JSON.stringify({ revision: result.revision, data: result.data }, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (isStaticMcpResource(uri)) {
      // docs/tools is static — accept subscribe but never push.
      return {};
    }
    await daemon.call("resources.subscribe", { uri });
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (isStaticMcpResource(uri)) return {};
    await daemon.call("resources.unsubscribe", { uri });
    return {};
  });

  // Daemon → MCP notification translation.
  daemon.onNotification((notif) => {
    if (notif.method !== "resource.updated") return;
    const params = notif.params as { uri?: string } | undefined;
    const uri = params?.uri;
    if (!uri) return;
    server
      .sendResourceUpdated({ uri })
      .catch((err) => log.warn({ err, uri }, "sendResourceUpdated failed"));
    // Updates on `browser://sessions` or any `browser://session/{sid}/pages`
    // also change which resource URIs exist (each page adds 5 page-scoped URIs).
    // Spec requires us to tell the client to re-list when that happens.
    if (uri === "browser://sessions" || /^browser:\/\/session\/[^/]+\/pages$/.test(uri)) {
      server
        .sendResourceListChanged()
        .catch((err) => log.warn({ err, uri }, "sendResourceListChanged failed"));
    }
  });
}
