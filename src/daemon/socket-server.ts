import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getLogger } from "@shared/logger.js";
import { nextConnectionId } from "@shared/ids.js";
import { DaemonError } from "@shared/errors.js";
import type {
  DaemonNotification,
  DaemonNotificationMethod,
  DaemonRequest,
  DaemonResponse,
} from "@shared/protocol.js";
import { ErrorCode } from "@shared/protocol.js";
import type { ConnectionContext, RpcDispatcher } from "./rpc-handlers.js";

const log = getLogger("daemon/socket");

export interface SocketServerOptions {
  socketPath: string;
  dispatcher: RpcDispatcher;
  /** Called when a client socket closes — used by SubscriptionRegistry to drop refs. */
  onConnectionClose?: (connectionId: string) => void;
}

export function startSocketServer(opts: SocketServerOptions): net.Server {
  const { socketPath, dispatcher, onConnectionClose } = opts;

  // Clean up stale socket from a previous run.
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      log.warn({ err, socketPath }, "could not remove stale socket");
    }
  }

  const server = net.createServer((socket) => {
    const connectionId = nextConnectionId();
    log.debug({ connectionId }, "client connected");
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    const sendNotification = (method: DaemonNotificationMethod, params: unknown): void => {
      if (socket.destroyed) return;
      const msg: DaemonNotification = { jsonrpc: "2.0", method, params };
      socket.write(JSON.stringify(msg) + "\n");
    };

    const ctx: ConnectionContext = { connectionId, sendNotification };

    rl.on("line", (line) => {
      void handleLine(line, dispatcher, socket, ctx).catch((err) => {
        log.error({ err, connectionId }, "uncaught dispatch error");
      });
    });

    socket.on("error", (err) => log.warn({ err, connectionId }, "client socket error"));
    socket.on("close", () => {
      log.debug({ connectionId }, "client disconnected");
      try {
        onConnectionClose?.(connectionId);
      } catch (err) {
        log.warn({ err, connectionId }, "onConnectionClose threw");
      }
    });
  });

  server.on("error", (err) => {
    log.error({ err }, "socket server error");
  });

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o660);
    } catch (err) {
      log.warn({ err }, "could not chmod socket");
    }
    log.info({ socketPath }, "daemon socket listening");
  });

  return server;
}

async function handleLine(
  line: string,
  dispatcher: RpcDispatcher,
  socket: net.Socket,
  ctx: ConnectionContext,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: DaemonRequest;
  try {
    req = JSON.parse(trimmed) as DaemonRequest;
  } catch (err) {
    const errResp: DaemonResponse = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: ErrorCode.PARSE_ERROR, message: "Parse error", data: String(err) },
    };
    sendMessage(socket, errResp);
    return;
  }

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    sendMessage(socket, {
      jsonrpc: "2.0",
      id: req.id ?? 0,
      error: { code: ErrorCode.INVALID_REQUEST, message: "Invalid request" },
    });
    return;
  }

  try {
    const result = await dispatcher.dispatch(req.method, req.params, ctx);
    sendMessage(socket, { jsonrpc: "2.0", id: req.id, result });
  } catch (err) {
    if (err instanceof DaemonError) {
      sendMessage(socket, { jsonrpc: "2.0", id: req.id, error: err.toJsonRpcError() });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, method: req.method, connectionId: ctx.connectionId }, "handler threw");
      sendMessage(socket, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: ErrorCode.INTERNAL_ERROR, message: msg },
      });
    }
  }
}

function sendMessage(socket: net.Socket, msg: DaemonResponse | DaemonNotification): void {
  if (socket.destroyed) return;
  socket.write(JSON.stringify(msg) + "\n");
}
