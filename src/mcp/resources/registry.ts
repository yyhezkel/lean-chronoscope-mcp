/**
 * MCP-side resource registry. The authoritative list of *available* `browser://`
 * URIs lives on the daemon (it knows live sessions and pages); this module
 * holds only the static URIs that are MCP-server-rendered.
 */

export const DOCS_TOOLS_URI = "browser://docs/tools";

/** True when the URI is served entirely from the MCP side without round-tripping to the daemon. */
export function isStaticMcpResource(uri: string): boolean {
  return uri === DOCS_TOOLS_URI;
}

/**
 * MCP-side descriptor for the static `docs/tools` resource. Daemon's
 * `resources.list` already returns it (as a placeholder); we re-declare here
 * so the MCP server can describe it without the daemon being involved.
 */
export const STATIC_RESOURCE_DESCRIPTORS = [
  {
    uri: DOCS_TOOLS_URI,
    name: "docs.tools",
    description: "MCP tool registry (name + schema for every registered tool)",
    mimeType: "application/json",
  },
] as const;
