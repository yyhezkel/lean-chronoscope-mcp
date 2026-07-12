import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getLogger } from "@shared/logger.js";
import type { DaemonClient } from "./daemon-client.js";
import type { ToolContext } from "./tools/ToolDefinition.js";
import { allTools, getTool, selectTools, type ToolMode } from "./tools/tools.js";
import { toJsonSchemaDraft2020 } from "./tools/jsonschema.js";
import { McpResponse } from "./response/McpResponse.js";
import { registerResourceHandlers } from "./resources/handlers.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const log = getLogger("mcp/http");

export interface HttpBridgeOptions {
  /** Bind host. Defaults to 127.0.0.1; never 0.0.0.0 unless behind a proxy. */
  host?: string;
  port: number;
  /** Required: clients must send `Authorization: Bearer <token>`. */
  bearerToken: string;
  /** Function that hands out a fresh `sessionId` per HTTP MCP session. */
  sessionId: () => string;
  daemon: DaemonClient;
  /** Tool surface to advertise. Defaults to "full". */
  mode?: ToolMode;
}

/**
 * Optional HTTP+SSE bridge for clients that can't `docker exec -i` (e.g. a
 * laptop hitting the server directly). Spins up one `Server` instance per
 * HTTP MCP session — the transport's session ID maps 1:1 to the lean-chronoscope
 * `sessionId`. Bearer-token auth is mandatory.
 *
 * Bind to 127.0.0.1 unless a TLS-terminating proxy is in front. There is no
 * built-in TLS here — the threat model assumes the operator either runs over
 * SSH/Wireguard or fronts this with nginx.
 */
export async function startHttpBridge(opts: HttpBridgeOptions): Promise<http.Server> {
  const sessionTransports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    // Health probe — never requires auth.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessionTransports.size }));
      return;
    }
    // Authenticate.
    const auth = req.headers["authorization"];
    if (!auth || auth !== `Bearer ${opts.bearerToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Reuse the transport for the session declared in the header, or create
    // a new one on the first request.
    const sid = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    let transport = sid ? sessionTransports.get(sid) : undefined;

    if (!transport) {
      // Persistence: a client that sends a stable `x-lc-session` header reuses
      // (or rehydrates from disk) the same daemon session across reconnects.
      // Absent the header, mint a fresh random id as before.
      const pinned = (req.headers["x-lc-session"] as string | undefined)?.trim();
      const browserMcpSession = pinned && pinned.length > 0 ? pinned : opts.sessionId();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          sessionTransports.set(newSid, transport!);
          log.info({ sid: newSid, browserMcpSession }, "HTTP MCP session initialized");
        },
      });
      const server = await buildServer(opts.daemon, browserMcpSession, opts.mode ?? "full");
      await server.connect(transport);
      transport.onclose = () => {
        const closeSid = transport!.sessionId;
        if (closeSid) sessionTransports.delete(closeSid);
        // Close the daemon-side browser session too, otherwise the BrowserContext
        // + SQLite + on-disk dir leak until daemon restart or the age sweep.
        // closeSession is idempotent, so racing the reaper is harmless.
        void opts.daemon
          .call("session.close", { sessionId: browserMcpSession })
          .catch((err) =>
            log.warn({ err, browserMcpSession }, "session.close on transport close failed"),
          );
        log.info({ sid: closeSid, browserMcpSession }, "HTTP MCP session closed");
      };
    }

    // Body parsing — SDK accepts pre-parsed JSON or raw stream.
    let body: unknown;
    if (req.method === "POST") {
      body = await readJsonBody(req);
    }
    try {
      await transport.handleRequest(req as any, res as any, body);
    } catch (err) {
      log.error({ err }, "transport.handleRequest failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  log.info(
    { host: opts.host ?? "127.0.0.1", port: opts.port },
    "HTTP+SSE bridge listening",
  );
  return httpServer;
}

async function buildServer(daemon: DaemonClient, sessionId: string, mode: ToolMode): Promise<Server> {
  await daemon.call("session.ensure", { sessionId, source: "http" });
  const advertised = selectTools(mode);
  // One mutable context per connection — `session_attach` reassigns conn.sessionId.
  const conn: ToolContext = { sessionId, daemon };
  const server = new Server(
    { name: "lean-chronoscope-mcp", version: "1.4.0" },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } } },
  );
  registerResourceHandlers({ server, daemon, sessionId, allTools });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertised.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchemaDraft2020(t.inputSchema),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = getTool(name);
    if (!tool) return new McpResponse().setError(`Unknown tool: ${name}`).build() as never;
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return new McpResponse().setError(`Invalid args: ${parsed.error.message}`).build() as never;
    }
    try {
      return (await tool.handler(parsed.data, conn)) as never;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new McpResponse().setError(`${name} failed: ${msg}`).build() as never;
    }
  });
  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
