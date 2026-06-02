// Pure parser/builder for the `browser://` resource URI scheme.
// Schemes:
//   browser://sessions
//   browser://session/{sid}/pages
//   browser://session/{sid}/page/{pid}/snapshot/latest
//   browser://session/{sid}/page/{pid}/console/live
//   browser://session/{sid}/page/{pid}/network/live
//   browser://session/{sid}/page/{pid}/exceptions/live
//   browser://session/{sid}/page/{pid}/url
//   browser://session/{sid}/intercept/rules
//   browser://docs/tools

export type ResourceUri =
  | { kind: "sessions" }
  | { kind: "session.pages"; sessionId: string }
  | { kind: "page.snapshot"; sessionId: string; pageId: string }
  | { kind: "page.console"; sessionId: string; pageId: string }
  | { kind: "page.network"; sessionId: string; pageId: string }
  | { kind: "page.exceptions"; sessionId: string; pageId: string }
  | { kind: "page.url"; sessionId: string; pageId: string }
  | { kind: "session.intercept"; sessionId: string }
  | { kind: "docs.tools" };

export type ResourceKind = ResourceUri["kind"];

const SCHEME = "browser://";

export function parseUri(uri: string): ResourceUri | null {
  if (!uri.startsWith(SCHEME)) return null;
  const path = uri.slice(SCHEME.length);
  const parts = path.split("/").filter((p) => p.length > 0);

  if (parts.length === 0) return null;

  if (parts[0] === "sessions" && parts.length === 1) {
    return { kind: "sessions" };
  }

  if (parts[0] === "docs" && parts[1] === "tools" && parts.length === 2) {
    return { kind: "docs.tools" };
  }

  if (parts[0] !== "session" || parts.length < 3) return null;
  const sessionId = parts[1];
  if (!sessionId) return null;

  // browser://session/{sid}/pages
  if (parts[2] === "pages" && parts.length === 3) {
    return { kind: "session.pages", sessionId };
  }

  // browser://session/{sid}/intercept/rules
  if (parts[2] === "intercept" && parts[3] === "rules" && parts.length === 4) {
    return { kind: "session.intercept", sessionId };
  }

  // browser://session/{sid}/page/{pid}/...
  if (parts[2] === "page" && parts.length >= 5) {
    const pageId = parts[3];
    if (!pageId) return null;
    const tail = parts.slice(4).join("/");
    switch (tail) {
      case "snapshot/latest":
        return { kind: "page.snapshot", sessionId, pageId };
      case "console/live":
        return { kind: "page.console", sessionId, pageId };
      case "network/live":
        return { kind: "page.network", sessionId, pageId };
      case "exceptions/live":
        return { kind: "page.exceptions", sessionId, pageId };
      case "url":
        return { kind: "page.url", sessionId, pageId };
      default:
        return null;
    }
  }

  return null;
}

export function buildUri(parsed: ResourceUri): string {
  switch (parsed.kind) {
    case "sessions":
      return `${SCHEME}sessions`;
    case "docs.tools":
      return `${SCHEME}docs/tools`;
    case "session.pages":
      return `${SCHEME}session/${parsed.sessionId}/pages`;
    case "session.intercept":
      return `${SCHEME}session/${parsed.sessionId}/intercept/rules`;
    case "page.snapshot":
      return `${SCHEME}session/${parsed.sessionId}/page/${parsed.pageId}/snapshot/latest`;
    case "page.console":
      return `${SCHEME}session/${parsed.sessionId}/page/${parsed.pageId}/console/live`;
    case "page.network":
      return `${SCHEME}session/${parsed.sessionId}/page/${parsed.pageId}/network/live`;
    case "page.exceptions":
      return `${SCHEME}session/${parsed.sessionId}/page/${parsed.pageId}/exceptions/live`;
    case "page.url":
      return `${SCHEME}session/${parsed.sessionId}/page/${parsed.pageId}/url`;
  }
}

/** Extract sessionId from a parsed URI, or null for global URIs. */
export function sessionIdOf(parsed: ResourceUri): string | null {
  if ("sessionId" in parsed) return parsed.sessionId;
  return null;
}
