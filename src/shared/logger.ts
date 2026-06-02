import pino, { type Logger } from "pino";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOG_DIR } from "./paths.js";

// Logs MUST go to a file, never stdout — stdout is reserved for MCP framing.
// stderr is used as fallback if the log dir isn't writable.

let _logger: Logger | null = null;

export function getLogger(component: string): Logger {
  if (!_logger) {
    _logger = createBaseLogger();
  }
  return _logger.child({ component });
}

function createBaseLogger(): Logger {
  const logDir = DEFAULT_LOG_DIR;
  const logFile = path.join(logDir, "browser-mcp.log");
  try {
    fs.mkdirSync(logDir, { recursive: true });
    rotateIfLarge(logFile);
    const dest = pino.destination({ dest: logFile, sync: false, append: true });
    return pino(
      {
        level: process.env.BROWSER_MCP_LOG_LEVEL ?? "info",
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      dest,
    );
  } catch {
    // Fallback to stderr — never stdout.
    return pino(
      { level: process.env.BROWSER_MCP_LOG_LEVEL ?? "info" },
      pino.destination(2),
    );
  }
}

/**
 * Rotate-on-start: if the current log is over MAX_LOG_BYTES, rename it to .1,
 * shifting older numbered logs down (.1 → .2, etc.). Keeps the last KEEP_LOGS
 * archives; anything older is deleted. No background rotation — the daemon and
 * the per-session mcp-server processes are short-lived enough that checking
 * on startup is sufficient.
 */
function rotateIfLarge(logFile: string): void {
  const MAX_LOG_BYTES = Number(process.env.BROWSER_MCP_LOG_MAX_BYTES ?? 10 * 1024 * 1024);
  const KEEP_LOGS = Number(process.env.BROWSER_MCP_LOG_KEEP ?? 5);
  if (!Number.isFinite(MAX_LOG_BYTES) || MAX_LOG_BYTES <= 0) return;
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < MAX_LOG_BYTES) return;
    // Shift archives down. fs.renameSync is overwrite-safe on same filesystem.
    for (let i = KEEP_LOGS; i >= 1; i--) {
      const src = `${logFile}.${i}`;
      const dst = `${logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i === KEEP_LOGS) fs.rmSync(src, { force: true });
        else fs.renameSync(src, dst);
      }
    }
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* file doesn't exist yet or another process is rotating — ignore */
  }
}
