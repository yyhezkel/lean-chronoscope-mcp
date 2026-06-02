import path from "node:path";

export const DEFAULT_DATA_DIR =
  process.env.BROWSER_MCP_DATA_DIR ?? "/var/lib/browser-mcp";

export const DEFAULT_SOCKET_PATH =
  process.env.BROWSER_MCP_SOCKET ?? "/run/browser-mcp/daemon.sock";

export const DEFAULT_LOG_DIR =
  process.env.BROWSER_MCP_LOG_DIR ?? "/var/log/browser-mcp";

export function getSessionDir(sessionId: string, dataDir = DEFAULT_DATA_DIR): string {
  return path.join(dataDir, "sessions", sessionId);
}

export function getBlobDir(sessionId: string, dataDir = DEFAULT_DATA_DIR): string {
  return path.join(getSessionDir(sessionId, dataDir), "blobs");
}

export function getBlobPath(sessionId: string, sha256: string, dataDir = DEFAULT_DATA_DIR): string {
  return path.join(getBlobDir(sessionId, dataDir), `${sha256}.bin`);
}

export function getRegistryDbPath(dataDir = DEFAULT_DATA_DIR): string {
  return path.join(dataDir, "registry.sqlite");
}
