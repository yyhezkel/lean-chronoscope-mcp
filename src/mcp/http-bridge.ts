import http from "node:http";
import https from "node:https";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getLogger } from "@shared/logger.js";
import { VERSION } from "@shared/version.js";
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
  /** Max POST body size in bytes; larger bodies get 413. Defaults to 4 MiB. */
  maxBodyBytes?: number;
  /** Per-client-IP requests/minute (token bucket, burst = this). 0 disables. Defaults to 600. */
  ratePerMin?: number;
  /** Max concurrent MCP transports; new sessions beyond it get 503. 0 = unlimited. Defaults to 64. */
  maxSessions?: number;
  /** PEM cert + key. When set, the bridge serves HTTPS instead of plain HTTP. */
  tls?: { cert: Buffer; key: Buffer };
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_RATE_PER_MIN = 600;
const DEFAULT_MAX_SESSIONS = 64;
/** Upper bound on tracked client IPs; stale (fully refilled) buckets are evicted first. */
const MAX_RATE_BUCKETS = 10_000;

class BodyTooLargeError extends Error {}

/**
 * Optional HTTP+SSE bridge for clients that can't `docker exec -i` (e.g. a
 * laptop hitting the server directly). Spins up one `Server` instance per
 * HTTP MCP session — the transport's session ID maps 1:1 to the lean-chronoscope
 * `sessionId`. Bearer-token auth is mandatory.
 *
 * Bind to 127.0.0.1 unless TLS is on (`opts.tls`) or a TLS-terminating proxy
 * is in front. Hardening: constant-time bearer compare, a POST body cap (413),
 * a per-client-IP token-bucket rate limit (429, failed auth attempts count too),
 * and a cap on concurrent MCP transports (503 for new sessions beyond it).
 */
export async function startHttpBridge(opts: HttpBridgeOptions): Promise<http.Server> {
  const sessionTransports = new Map<string, StreamableHTTPServerTransport>();
  // Live transports per daemon session. Several clients can pin the same
  // `x-lc-session`; the daemon session is closed only when the last one leaves.
  const sessionRefs = new Map<string, number>();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const limiter = new RateLimiter(opts.ratePerMin ?? DEFAULT_RATE_PER_MIN);
  const expectedAuth = sha256(`Bearer ${opts.bearerToken}`);
  // Transports being built but not yet initialized — counted against maxSessions
  // so a burst of parallel initializes can't overshoot the cap.
  let creating = 0;

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Health probe — never requires auth, never rate limited.
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessionTransports.size }));
      return;
    }
    // Rate limit before auth so token brute force is throttled too. Keyed on
    // the socket peer — behind a reverse proxy every client shares one bucket.
    const retryAfter = limiter.take(req.socket.remoteAddress ?? "unknown");
    if (retryAfter > 0) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    // Authenticate. Compare fixed-length digests in constant time, so neither
    // the token's contents nor its length leak through timing.
    const auth = req.headers["authorization"];
    if (!auth || !timingSafeEqual(sha256(auth), expectedAuth)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Body parsing — SDK accepts pre-parsed JSON or raw stream. Read it before
    // touching transports so an oversized body never allocates a session.
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req, maxBodyBytes);
      } catch (err) {
        if (!(err instanceof BodyTooLargeError)) throw err;
        log.warn({ maxBodyBytes, ip: req.socket.remoteAddress }, "HTTP request body too large");
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "payload_too_large", maxBytes: maxBodyBytes }));
        // Stop buffering: discard whatever the client is still sending so it can
        // read the 413, but drop the socket after a short grace period regardless.
        req.resume();
        const drop = setTimeout(() => req.destroy(), 2000);
        drop.unref();
        req.once("close", () => clearTimeout(drop));
        return;
      }
    }

    // Reuse the transport for the session declared in the header, or create
    // a new one on the first request.
    const sid = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    let transport = sid ? sessionTransports.get(sid) : undefined;

    if (!transport && maxSessions > 0 && sessionTransports.size + creating >= maxSessions) {
      log.warn({ maxSessions, live: sessionTransports.size }, "HTTP MCP session cap reached");
      res.writeHead(503, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: "too_many_sessions", maxSessions }));
      return;
    }

    let isNew = false;
    if (!transport) {
      isNew = true;
      creating++;
      // Persistence: a client that sends a stable `x-lc-session` header reuses
      // (or rehydrates from disk) the same daemon session across reconnects.
      // Absent the header, mint a fresh random id as before.
      const pinned = (req.headers["x-lc-session"] as string | undefined)?.trim();
      const browserMcpSession = pinned && pinned.length > 0 ? pinned : opts.sessionId();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          sessionTransports.set(newSid, transport!);
          if (isNew) { isNew = false; creating--; }
          sessionRefs.set(browserMcpSession, (sessionRefs.get(browserMcpSession) ?? 0) + 1);
          log.info({ sid: newSid, browserMcpSession }, "HTTP MCP session initialized");
        },
      });
      let server: Server;
      try {
        server = await buildServer(opts.daemon, browserMcpSession, opts.mode ?? "full");
        await server.connect(transport);
      } catch (err) {
        if (isNew) { isNew = false; creating--; }
        throw err;
      }
      transport.onclose = () => {
        const closeSid = transport!.sessionId;
        if (!closeSid || !sessionTransports.delete(closeSid)) return; // never initialized / already closed
        const refs = (sessionRefs.get(browserMcpSession) ?? 1) - 1;
        if (refs > 0) {
          sessionRefs.set(browserMcpSession, refs);
          log.info({ sid: closeSid, browserMcpSession, refs }, "HTTP MCP session closed (daemon session still shared)");
          return;
        }
        sessionRefs.delete(browserMcpSession);
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

    try {
      await transport.handleRequest(req as any, res as any, body);
    } catch (err) {
      log.error({ err }, "transport.handleRequest failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    } finally {
      // A request that didn't initialize (e.g. a bad first message) no longer
      // holds a pending slot.
      if (isNew) { isNew = false; creating--; }
    }
  };

  const guarded: http.RequestListener = (req, res) => {
    handler(req, res).catch((err) => {
      log.error({ err }, "HTTP bridge request failed");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });
  };
  const httpServer: http.Server = opts.tls
    ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, guarded)
    : http.createServer(guarded);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  log.info(
    {
      host: opts.host ?? "127.0.0.1",
      port: opts.port,
      tls: !!opts.tls,
      maxBodyBytes,
      ratePerMin: opts.ratePerMin ?? DEFAULT_RATE_PER_MIN,
      maxSessions,
    },
    opts.tls ? "HTTPS+SSE bridge listening (TLS)" : "HTTP+SSE bridge listening (plain HTTP, no TLS)",
  );
  return httpServer;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Per-key token bucket: capacity `perMin` (the burst), refilled continuously at
 * `perMin / 60` tokens/sec. `take()` returns 0 when allowed, else the
 * Retry-After in whole seconds. The map is bounded by MAX_RATE_BUCKETS.
 */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perSec: number;

  constructor(private readonly perMin: number) {
    this.perSec = perMin / 60;
  }

  take(key: string, now = Date.now()): number {
    if (this.perMin <= 0) return 0;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.perMin, b.tokens + ((now - b.at) / 1000) * this.perSec);
      b.at = now;
    } else {
      if (this.buckets.size >= MAX_RATE_BUCKETS) this.evict(now);
      b = { tokens: this.perMin, at: now };
      this.buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.perSec));
  }

  /** Drop buckets that have fully refilled (idle ≥ 1 min); if none, the oldest. */
  private evict(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.perSec >= this.perMin) this.buckets.delete(k);
    }
    if (this.buckets.size >= MAX_RATE_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}

async function buildServer(daemon: DaemonClient, sessionId: string, mode: ToolMode): Promise<Server> {
  await daemon.call("session.ensure", { sessionId, source: "http" });
  const advertised = selectTools(mode);
  // One mutable context per connection — `session_attach` reassigns conn.sessionId.
  const conn: ToolContext = { sessionId, daemon };
  const server = new Server(
    { name: "lean-chronoscope-mcp", version: VERSION },
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

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  // Fast reject on a declared length; otherwise count as we stream. Events, not
  // `for await`: breaking out of the async iterator destroys the socket before
  // the caller can send its 413.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.off("data", onData);
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
