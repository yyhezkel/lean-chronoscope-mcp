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
  /**
   * Opens a dedicated daemon connection. Called once per HTTP MCP session and
   * closed with it: daemon-side resource subscriptions (incl. the CDP
   * screencast) are keyed per connection and released when it closes.
   */
  connectDaemon: () => Promise<DaemonClient>;
  /** Tool surface to advertise. Defaults to "full". */
  mode?: ToolMode;
  /** Max POST body size in bytes; larger bodies get 413. Defaults to 4 MiB. */
  maxBodyBytes?: number;
  /** Failed-auth attempts/minute per client IP (token bucket, burst = this). 0 disables. Defaults to 60. */
  ratePerMin?: number;
  /** Authenticated requests/minute per MCP session (`mcp-session-id`). 0 disables. Defaults to 600. */
  sessionRatePerMin?: number;
  /** Authenticated requests/minute per client IP that carry no live session (initialize). 0 disables. Defaults to 120. */
  initRatePerMin?: number;
  /** Max concurrent MCP transports; new sessions beyond it get 503. 0 = unlimited. Defaults to 64. */
  maxSessions?: number;
  /** PEM cert + key. When set, the bridge serves HTTPS instead of plain HTTP. */
  tls?: { cert: Buffer; key: Buffer };
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_RATE_PER_MIN = 60;
const DEFAULT_SESSION_RATE_PER_MIN = 600;
const DEFAULT_INIT_RATE_PER_MIN = 120;
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
 * token-bucket rate limits (429) in three separate buckets — failed auth per
 * client IP, authenticated requests per MCP session, and session-less
 * (initialize) requests per client IP — and a cap on concurrent MCP transports
 * (503 for new sessions beyond it). Behind docker-proxy every host client
 * shares the gateway IP, so per-session buckets keep parallel agents from
 * starving each other, and a bad-token flood can't lock out live sessions.
 */
export async function startHttpBridge(opts: HttpBridgeOptions): Promise<http.Server> {
  const sessionTransports = new Map<string, StreamableHTTPServerTransport>();
  // Live transports per daemon session. Several clients can pin the same
  // `x-lc-session`; the daemon session is closed only when the last one leaves.
  const sessionRefs = new Map<string, number>();
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const authFailLimiter = new RateLimiter(opts.ratePerMin ?? DEFAULT_RATE_PER_MIN);
  const sessionLimiter = new RateLimiter(opts.sessionRatePerMin ?? DEFAULT_SESSION_RATE_PER_MIN);
  const initLimiter = new RateLimiter(opts.initRatePerMin ?? DEFAULT_INIT_RATE_PER_MIN);
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
    // Keyed on the socket peer; X-Forwarded-For is client-controlled and ignored.
    const ip = req.socket.remoteAddress ?? "unknown";
    const sid = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;
    const live = !!sid && sessionTransports.has(sid);
    // Once an IP has used up its failed-auth allowance, refuse before comparing
    // the token, so brute force stays throttled. Requests on a live session skip
    // this pre-check: the session id is an unguessable UUID only handed to an
    // authenticated client, so a bad-token flood from a shared (docker-proxy)
    // IP can't lock out clients that are already connected.
    if (!live) {
      const retryAfter = authFailLimiter.peek(ip);
      if (retryAfter > 0) return rateLimited(res, retryAfter);
    }
    // Authenticate. Compare fixed-length digests in constant time, so neither
    // the token's contents nor its length leak through timing.
    const auth = req.headers["authorization"];
    if (!auth || !timingSafeEqual(sha256(auth), expectedAuth)) {
      authFailLimiter.take(ip);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    // Authenticated: one bucket per MCP session, so parallel agents behind the
    // same IP don't share an allowance; session-less requests (initialize, or a
    // stale session id) draw from a separate per-IP bucket. DELETE on a live
    // session is exempt — a throttled client must still be able to let go.
    const retryAfter = live
      ? req.method === "DELETE" ? 0 : sessionLimiter.take(sid!)
      : initLimiter.take(ip);
    if (retryAfter > 0) return rateLimited(res, retryAfter);

    // Body parsing — SDK accepts pre-parsed JSON or raw stream. Read it before
    // touching transports so an oversized body never allocates a session.
    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req, maxBodyBytes);
      } catch (err) {
        if (!(err instanceof BodyTooLargeError)) throw err;
        log.warn({ maxBodyBytes, ip: req.socket.remoteAddress }, "HTTP request body too large");
        rejectTooLarge(req, res, maxBodyBytes);
        return;
      }
    }

    // Reuse the transport for the session declared in the header (re-looked up:
    // it may have closed while the body was read), or create a new one.
    let transport = sid ? sessionTransports.get(sid) : undefined;

    if (!transport && maxSessions > 0 && sessionTransports.size + creating >= maxSessions) {
      log.warn({ maxSessions, live: sessionTransports.size }, "HTTP MCP session cap reached");
      res.writeHead(503, { "content-type": "application/json", "retry-after": "30" });
      res.end(JSON.stringify({ error: "too_many_sessions", maxSessions }));
      return;
    }

    let isNew = false;
    // Set when this request created the transport; run after handleRequest so a
    // transport whose first request never initialized doesn't leak its daemon
    // connection.
    let abandonIfUninitialized: (() => void) | undefined;
    if (!transport) {
      isNew = true;
      creating++;
      // Persistence: a client that sends a stable `x-lc-session` header reuses
      // (or rehydrates from disk) the same daemon session across reconnects.
      // Absent the header, mint a fresh random id as before.
      const pinned = (req.headers["x-lc-session"] as string | undefined)?.trim();
      const browserMcpSession = pinned && pinned.length > 0 ? pinned : opts.sessionId();
      let initialized = false;
      let daemon: DaemonClient | undefined;
      let server: Server | undefined;
      let dispose = (): void => {};
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSid) => {
          initialized = true;
          sessionTransports.set(newSid, transport!);
          if (isNew) { isNew = false; creating--; }
          sessionRefs.set(browserMcpSession, (sessionRefs.get(browserMcpSession) ?? 0) + 1);
          log.info({ sid: newSid, browserMcpSession }, "HTTP MCP session initialized");
        },
      });
      // Set before server.connect() so the SDK chains its own onclose after ours.
      transport.onclose = () => {
        const closeSid = transport!.sessionId;
        if (!closeSid || !sessionTransports.delete(closeSid)) return; // never initialized / already closed
        sessionLimiter.delete(closeSid);
        dispose();
        const client = daemon!;
        const refs = (sessionRefs.get(browserMcpSession) ?? 1) - 1;
        let closing: Promise<unknown> = Promise.resolve();
        if (refs > 0) {
          sessionRefs.set(browserMcpSession, refs);
          log.info({ sid: closeSid, browserMcpSession, refs }, "HTTP MCP session closed (daemon session still shared)");
        } else {
          sessionRefs.delete(browserMcpSession);
          // Close the daemon-side browser session too, otherwise the BrowserContext
          // + SQLite + on-disk dir leak until daemon restart or the age sweep.
          // closeSession is idempotent, so racing the reaper is harmless.
          closing = client
            .call("session.close", { sessionId: browserMcpSession })
            .catch((err) =>
              log.warn({ err, browserMcpSession }, "session.close on transport close failed"),
            );
          log.info({ sid: closeSid, browserMcpSession }, "HTTP MCP session closed");
        }
        // Drop the dedicated connection once session.close is answered; the
        // daemon then releases every subscription it held (stopping screencasts
        // nobody else watches).
        void closing.finally(() => client.close());
      };
      try {
        daemon = await opts.connectDaemon();
        ({ server, dispose } = await buildServer(daemon, browserMcpSession, opts.mode ?? "full"));
        await server.connect(transport);
      } catch (err) {
        if (isNew) { isNew = false; creating--; }
        dispose();
        daemon?.close();
        throw err;
      }
      abandonIfUninitialized = () => {
        if (initialized) return;
        dispose();
        void server!.close().catch(() => {});
        // A fresh random id is known to nobody else — close the session that
        // buildServer ensured. A pinned id may be shared, so leave it to the reaper.
        const client = daemon!;
        const closing = pinned
          ? Promise.resolve()
          : client.call("session.close", { sessionId: browserMcpSession }).catch(() => {});
        void closing.finally(() => client.close());
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
      // holds a pending slot, and its transport is unreachable — release it.
      if (isNew) { isNew = false; creating--; }
      abandonIfUninitialized?.();
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
      sessionRatePerMin: opts.sessionRatePerMin ?? DEFAULT_SESSION_RATE_PER_MIN,
      initRatePerMin: opts.initRatePerMin ?? DEFAULT_INIT_RATE_PER_MIN,
      maxSessions,
    },
    opts.tls ? "HTTPS+SSE bridge listening (TLS)" : "HTTP+SSE bridge listening (plain HTTP, no TLS)",
  );
  return httpServer;
}

/** Extra bytes / time we'll discard after a 413 before giving up on the client. */
const DRAIN_MAX_BYTES = 16 * 1024 * 1024;
const DRAIN_MAX_MS = 5000;

/**
 * Send 413 without the client hitting EPIPE/ECONNRESET. Node destroys the
 * socket as soon as a `Connection: close` response is flushed, so answering
 * while the client is still uploading resets the connection before it reads
 * the status. Instead: discard (never buffer) the rest of the body, and send
 * the 413 once it has fully arrived. A slow/huge upload is bounded by
 * DRAIN_MAX_BYTES / DRAIN_MAX_MS — past either, we send the 413 anyway and
 * drop the socket once it's flushed.
 */
function rejectTooLarge(req: http.IncomingMessage, res: http.ServerResponse, maxBytes: number): void {
  let drained = 0;
  let done = false;
  const respond = (abort: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    req.off("data", onData);
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "payload_too_large", maxBytes }));
    }
    if (abort) {
      if (res.writableFinished) req.destroy();
      else res.once("finish", () => req.destroy());
    }
  };
  const onData = (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > DRAIN_MAX_BYTES) respond(true);
  };
  const timer = setTimeout(() => respond(true), DRAIN_MAX_MS);
  timer.unref();
  if (req.readableEnded) return respond(false);
  req.on("data", onData);
  req.once("end", () => respond(false));
  req.once("close", () => respond(true));
  req.resume();
}

function rateLimited(res: http.ServerResponse, retryAfter: number): void {
  res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) });
  res.end(JSON.stringify({ error: "rate_limited" }));
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Per-key token bucket: capacity `perMin` (the burst), refilled continuously at
 * `perMin / 60` tokens/sec. `take()` returns 0 when allowed, else the
 * Retry-After in whole seconds; `peek()` answers the same without consuming.
 * The map is bounded by MAX_RATE_BUCKETS.
 */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perSec: number;

  constructor(private readonly perMin: number) {
    this.perSec = perMin / 60;
  }

  take(key: string, now = Date.now()): number {
    return this.check(key, now, true);
  }

  peek(key: string, now = Date.now()): number {
    return this.check(key, now, false);
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }

  private check(key: string, now: number, consume: boolean): number {
    if (this.perMin <= 0) return 0;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.perMin, b.tokens + ((now - b.at) / 1000) * this.perSec);
      b.at = now;
    } else {
      if (!consume) return 0; // unknown key = full bucket; don't track it just for a peek
      if (this.buckets.size >= MAX_RATE_BUCKETS) this.evict(now);
      b = { tokens: this.perMin, at: now };
      this.buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      if (consume) b.tokens -= 1;
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

async function buildServer(
  daemon: DaemonClient,
  sessionId: string,
  mode: ToolMode,
): Promise<{ server: Server; dispose: () => void }> {
  await daemon.call("session.ensure", { sessionId, source: "http" });
  const advertised = selectTools(mode);
  // One mutable context per connection — `session_attach` reassigns conn.sessionId.
  const conn: ToolContext = { sessionId, daemon };
  const server = new Server(
    { name: "lean-chronoscope-mcp", version: VERSION },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } } },
  );
  const dispose = registerResourceHandlers({ server, daemon, sessionId, allTools });
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
  return { server, dispose };
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
