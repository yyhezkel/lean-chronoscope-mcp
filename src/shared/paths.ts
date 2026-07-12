import path from "node:path";
import { env } from "./env.js";

export const DEFAULT_DATA_DIR = env("DATA_DIR") ?? "/var/lib/lean-chronoscope";

export const DEFAULT_SOCKET_PATH =
  env("SOCKET") ?? "/run/lean-chronoscope/daemon.sock";

export const DEFAULT_LOG_DIR = env("LOG_DIR") ?? "/var/log/lean-chronoscope";

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
