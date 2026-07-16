import fs from "node:fs";
import path from "node:path";
import { DEFAULT_DATA_DIR, DEFAULT_SOCKET_PATH } from "@shared/paths.js";
import { env, deprecatedEnvSeen } from "@shared/env.js";
import { getLogger } from "@shared/logger.js";
import { launchBrowser } from "./browser.js";
import { RpcDispatcher } from "./rpc-handlers.js";
import { startSocketServer } from "./socket-server.js";
import { Broadcaster } from "./live/broadcaster.js";
import { SubscriptionRegistry } from "./live/subscriptions.js";
import { RegistryStore } from "./storage/registry.js";

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
  if (deprecatedEnvSeen.size > 0) {
    log.warn(
      { vars: [...deprecatedEnvSeen] },
      "using deprecated BROWSER_MCP_* env vars — rename to LEAN_CHRONOSCOPE_*",
    );
  }

  // Persistent cross-session index. Open + reconcile BEFORE the age sweep so the
  // sweep can drop matching registry rows.
  const registry = new RegistryStore(config.dataDir);
  reconcileRegistry(registry, config.dataDir);
  runRetentionSweep(config.dataDir, registry);

  const browser = await launchBrowser({
    executablePath: config.chromeBin,
    headless: config.headless ?? true,
  });

  const broadcaster = new Broadcaster();
  const subscriptions = new SubscriptionRegistry(broadcaster);
  const dispatcher = new RpcDispatcher(browser, broadcaster, subscriptions, registry);

  // Periodic lifecycle reaper: flush size stats, prune rows, evict idle/oversized
  // sessions (memory/Chrome only — disk is left to the age sweep). Runs the age
  // sweep itself every ~hour so a long-lived daemon reclaims disk without a
  // restart. REAPER_INTERVAL_MS=0 disables the whole thing.
  const reaperMs = Number(env("REAPER_INTERVAL_MS") ?? 60_000);
  let reaper: NodeJS.Timeout | undefined;
  let sweepTicks = 0;
  const sweepEvery = Math.max(1, Math.round((60 * 60_000) / Math.max(reaperMs, 1)));

  // Font-watch: Chrome only scans fonts at launch, so when font files change in
  // the drop-in dir we restart ourselves — Docker's `restart: unless-stopped`
  // revives the container and the entrypoint's fc-cache loads the new fonts.
  // Restart fires only once the dir is STABLE across two consecutive ticks, so
  // we never relaunch mid-copy with a half-written font file.
  // FONT_WATCH=0 disables; piggybacks on the reaper (REAPER_INTERVAL_MS=0 also disables).
  const fontsDir = env("FONTS_DIR") ?? "/home/mcp/.fonts";
  const fontWatch = (env("FONT_WATCH") ?? "1") !== "0";
  const scanFonts = (): string => {
    try {
      return fs
        .readdirSync(fontsDir, { recursive: true })
        .map((f) => {
          const p = path.join(fontsDir, String(f));
          const s = fs.statSync(p);
          return s.isFile() ? `${f}:${s.size}:${s.mtimeMs}` : "";
        })
        .filter(Boolean)
        .sort()
        .join("|");
    } catch {
      return ""; // dir missing/unreadable — treat as empty, never crash the tick
    }
  };
  const fontBaseline = fontWatch ? scanFonts() : "";
  let fontPrev = fontBaseline;

  if (reaperMs > 0) {
    reaper = setInterval(() => {
      void (async () => {
        try {
          if (fontWatch) {
            const cur = scanFonts();
            if (cur !== fontBaseline && cur === fontPrev) {
              log.info({ fontsDir }, "font change detected & settled — restarting to load new fonts");
              void shutdown("FONT_RELOAD");
              return;
            }
            fontPrev = cur;
          }
          await dispatcher.reapTick();
          if (++sweepTicks >= sweepEvery) {
            sweepTicks = 0;
            runRetentionSweep(config.dataDir, registry);
          }
        } catch (err) {
          log.error({ err }, "reaper tick failed");
        }
      })();
    }, reaperMs);
    reaper.unref();
  }
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
    if (reaper) clearInterval(reaper);
    server.close();
    try {
      await dispatcher.closeAll(); // checkpoints each session's WAL on close
      await browser.close();
    } catch (err) {
      log.error({ err }, "error during shutdown");
    }
    registry.close();
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
  const httpToken = env("HTTP_TOKEN");
  if (httpToken) {
    try {
      const [{ startHttpBridge }, { DaemonClient }] = await Promise.all([
        import("../mcp/http-bridge.js"),
        import("../mcp/daemon-client.js"),
      ]);
      const httpDaemon = new DaemonClient(config.socketPath);
      await httpDaemon.connect();
      const port = Number(env("HTTP_PORT") ?? 8780);
      const host = env("HTTP_HOST") ?? "127.0.0.1";
      const mode =
        env("GATEWAY") === "1"
          ? "gateway"
          : env("SLIM") === "1"
            ? "slim"
            : "full";
      await startHttpBridge({
        host,
        port,
        bearerToken: httpToken,
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
 * Drop any session directory whose mtime is older than `LEAN_CHRONOSCOPE_RETENTION_DAYS`
 * (default 7). Best-effort; logs and moves on if a delete fails. Runs once at
 * daemon startup — we don't sweep continuously because sessions are typically
 * short-lived and adding more daemon background work isn't worth the complexity.
 */
function runRetentionSweep(dataDir: string, registry?: RegistryStore): void {
  const days = parseFloat(env("RETENTION_DAYS") ?? "7");
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
        registry?.delete(name); // keep the index in sync with disk
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

/**
 * Heal the registry against reality at boot. The in-memory map is empty here,
 * so (1) any row still 'open' is an orphan from an unclean shutdown → mark it
 * closed, and (2) index any on-disk session dir the registry doesn't know about
 * yet (e.g. sessions created before the registry existed) as a closed entry.
 * Cheap, boot-only; does NOT re-open any BrowserContext or session DB.
 */
function reconcileRegistry(registry: RegistryStore, dataDir: string): void {
  registry.markAllClosed(Date.now());
  const sessionsDir = path.join(dataDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;
  for (const name of fs.readdirSync(sessionsDir)) {
    if (registry.has(name)) continue;
    const dir = path.join(sessionsDir, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const dbPath = path.join(dir, "db.sqlite");
      let size = 0;
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          size += fs.statSync(f).size;
        } catch {
          /* file may not exist */
        }
      }
      registry.insertClosed({
        id: name,
        createdAt: stat.mtimeMs,
        lastActivity: stat.mtimeMs,
        sizeBytes: size, // db files only; blob dir not walked at boot
        dataDir: dbPath,
      });
    } catch (err) {
      log.warn({ err, dir }, "registry reconcile: stat failed");
    }
  }
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
