import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DATA_DIR, DEFAULT_SOCKET_PATH } from "@shared/paths.js";
import { getLogger } from "@shared/logger.js";
import { launchBrowser } from "./browser.js";
import { RpcDispatcher } from "./rpc-handlers.js";
import { startSocketServer } from "./socket-server.js";
import { Broadcaster } from "./live/broadcaster.js";
import { SubscriptionRegistry } from "./live/subscriptions.js";

const log = getLogger("daemon/main");

export interface DaemonConfig {
  socketPath: string;
  dataDir: string;
  chromeBin?: string;
  headless?: boolean;
}

export async function runDaemon(config: DaemonConfig): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  log.info({ config }, "starting daemon");

  runRetentionSweep(config.dataDir);

  const browser = await launchBrowser({
    executablePath: config.chromeBin,
    headless: config.headless ?? true,
  });

  const broadcaster = new Broadcaster();
  const subscriptions = new SubscriptionRegistry(broadcaster);
  const dispatcher = new RpcDispatcher(browser, broadcaster, subscriptions);
  const server = startSocketServer({
    socketPath: config.socketPath,
    dispatcher,
    onConnectionClose: (connectionId) => subscriptions.dropConnection(connectionId),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutdown initiated");
    server.close();
    try {
      await dispatcher.closeAll();
      await browser.close();
    } catch (err) {
      log.error({ err }, "error during shutdown");
    }
    broadcaster.dispose();
    try {
      fs.unlinkSync(config.socketPath);
    } catch {
      /* socket already gone */
    }
    log.info("daemon stopped");
    process.exit(0);
  };

  // Never let a stray rejection/exception silently kill the daemon. Log it so
  // we can diagnose, and only treat it as fatal if it's clearly unrecoverable.
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandledRejection (non-fatal — logged, daemon continues)");
  });
  process.on("uncaughtException", (err) => {
    log.error({ err }, "uncaughtException (non-fatal — logged, daemon continues)");
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  browser.on("disconnected", () => {
    if (!shuttingDown) {
      log.error("Chrome disconnected unexpectedly — exiting for supervisor to restart");
      void shutdown("BROWSER_DISCONNECT");
    }
  });

  // Optional HTTP+SSE bridge — only when explicitly enabled via env. Imports
  // are dynamic so the daemon doesn't pay the SDK transport cost in the common
  // stdio-only case.
  if (process.env.BROWSER_MCP_HTTP_TOKEN) {
    try {
      const [{ startHttpBridge }, { DaemonClient }] = await Promise.all([
        import("../mcp/http-bridge.js"),
        import("../mcp/daemon-client.js"),
      ]);
      const httpDaemon = new DaemonClient(config.socketPath);
      await httpDaemon.connect();
      const port = Number(process.env.BROWSER_MCP_HTTP_PORT ?? 8780);
      const host = process.env.BROWSER_MCP_HTTP_HOST ?? "127.0.0.1";
      const mode =
        process.env.BROWSER_MCP_GATEWAY === "1"
          ? "gateway"
          : process.env.BROWSER_MCP_SLIM === "1"
            ? "slim"
            : "full";
      await startHttpBridge({
        host,
        port,
        bearerToken: process.env.BROWSER_MCP_HTTP_TOKEN,
        daemon: httpDaemon,
        sessionId: () => `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode,
      });
    } catch (err) {
      log.error({ err }, "failed to start HTTP bridge — continuing without it");
    }
  }

  log.info({ socketPath: config.socketPath }, "daemon ready");
}

/**
 * Drop any session directory whose mtime is older than `BROWSER_MCP_RETENTION_DAYS`
 * (default 7). Best-effort; logs and moves on if a delete fails. Runs once at
 * daemon startup — we don't sweep continuously because sessions are typically
 * short-lived and adding more daemon background work isn't worth the complexity.
 */
function runRetentionSweep(dataDir: string): void {
  const days = parseFloat(process.env.BROWSER_MCP_RETENTION_DAYS ?? "7");
  if (!Number.isFinite(days) || days <= 0) {
    log.info({ days }, "retention sweep disabled");
    return;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const sessionsDir = path.join(dataDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;
  let removed = 0;
  let kept = 0;
  for (const name of fs.readdirSync(sessionsDir)) {
    const dir = path.join(sessionsDir, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } else {
        kept++;
      }
    } catch (err) {
      log.warn({ err, dir }, "retention sweep: stat/remove failed");
    }
  }
  log.info({ removed, kept, days }, "retention sweep complete");
}

export function parseDaemonArgs(argv: string[]): DaemonConfig {
  const args = argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  return {
    socketPath: getArg("--socket") ?? DEFAULT_SOCKET_PATH,
    dataDir: getArg("--data-dir") ?? DEFAULT_DATA_DIR,
    chromeBin: getArg("--chrome-bin") ?? process.env.CHROME_BIN,
    headless: !args.includes("--no-headless"),
  };
}
