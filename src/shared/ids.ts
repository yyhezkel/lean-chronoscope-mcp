let _pageCounter = 0;
let _requestCounter = 0;
let _connectionCounter = 0;

export function nextPageId(): string {
  _pageCounter += 1;
  return `p_${_pageCounter}`;
}

export function nextRequestId(): number {
  _requestCounter += 1;
  return _requestCounter;
}

export function nextConnectionId(): string {
  _connectionCounter += 1;
  return `c_${_connectionCounter}`;
}

export function randomSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A session id becomes a filesystem path (`<dataDir>/sessions/<id>/`), and ids
 * now come from untrusted callers (attach `sessionId`, the `x-lc-session`
 * header). Reject anything that could escape the sessions dir or is malformed.
 * Throws with a caller-facing message on failure.
 */
export function assertSafeSessionId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw new Error("session id must be 1–200 characters");
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new Error("session id must not contain '/', '\\', '..', or NUL");
  }
}
