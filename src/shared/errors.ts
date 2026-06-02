import { ErrorCode } from "./protocol.js";

export class DaemonError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "DaemonError";
  }

  toJsonRpcError(): { code: number; message: string; data?: unknown } {
    return { code: this.code, message: this.message, data: this.data };
  }

  static methodNotFound(method: string): DaemonError {
    return new DaemonError(ErrorCode.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }

  static invalidParams(message: string, data?: unknown): DaemonError {
    return new DaemonError(ErrorCode.INVALID_PARAMS, message, data);
  }

  static sessionNotFound(sessionId: string): DaemonError {
    return new DaemonError(ErrorCode.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
  }

  static pageNotFound(pageId: string): DaemonError {
    return new DaemonError(ErrorCode.PAGE_NOT_FOUND, `Page not found: ${pageId}`);
  }

  static browserDisconnected(): DaemonError {
    return new DaemonError(ErrorCode.BROWSER_DISCONNECTED, "Chrome is not connected");
  }

  static internal(message: string, data?: unknown): DaemonError {
    return new DaemonError(ErrorCode.INTERNAL_ERROR, message, data);
  }
}
