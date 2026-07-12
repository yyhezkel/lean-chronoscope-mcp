// Centralized env-var access with a dual-name fallback. The project was renamed
// browser-mcp → lean-chronoscope; env vars moved from BROWSER_MCP_* to
// LEAN_CHRONOSCOPE_*. We read the new prefix first and fall back to the legacy
// one so existing deployments keep working. Names read via the legacy prefix are
// recorded in `deprecatedEnvSeen` so the daemon/mcp entry points can emit a
// one-time deprecation warning at boot (done there to avoid a logger↔env cycle).

const NEW_PREFIX = "LEAN_CHRONOSCOPE_";
const OLD_PREFIX = "BROWSER_MCP_";

/** Legacy `BROWSER_MCP_*` names that were actually read this process. */
export const deprecatedEnvSeen = new Set<string>();

/**
 * Read an env var by its suffix (e.g. `env("DATA_DIR")`), preferring the new
 * `LEAN_CHRONOSCOPE_` prefix and falling back to the legacy `BROWSER_MCP_` one.
 */
export function env(name: string): string | undefined {
  const next = process.env[NEW_PREFIX + name];
  if (next !== undefined) return next;
  const legacy = process.env[OLD_PREFIX + name];
  if (legacy !== undefined) deprecatedEnvSeen.add(OLD_PREFIX + name);
  return legacy;
}
