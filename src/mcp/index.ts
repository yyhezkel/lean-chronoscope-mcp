import { DEFAULT_SOCKET_PATH } from "@shared/paths.js";
import { getLogger } from "@shared/logger.js";
import { DaemonClient } from "./daemon-client.js";
import { startMcpServer } from "./server.js";
import type { ToolMode } from "./tools/tools.js";

const log = getLogger("mcp/main");

export interface McpConfig {
  sessionId: string;
  daemonSocket: string;
  mode: ToolMode;
}

export function parseMcpArgs(argv: string[]): McpConfig {
  const args = argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };
  // gateway takes precedence over slim if both are set.
  const mode: ToolMode =
    args.includes("--gateway") || process.env.BROWSER_MCP_GATEWAY === "1"
      ? "gateway"
      : args.includes("--slim") || process.env.BROWSER_MCP_SLIM === "1"
        ? "slim"
        : "full";
  return {
    sessionId: getArg("--session") ?? process.env.BROWSER_MCP_SESSION ?? "default",
    daemonSocket: getArg("--daemon-socket") ?? DEFAULT_SOCKET_PATH,
    mode,
  };
}

export async function runMcp(config: McpConfig): Promise<void> {
  log.info({ config }, "starting mcp-server");

  const daemon = new DaemonClient(config.daemonSocket);
  await daemon.connect();

  // Ensure the session exists on the daemon side.
  await daemon.call("session.ensure", { sessionId: config.sessionId });

  await startMcpServer({ sessionId: config.sessionId, daemon, mode: config.mode });
}
