import net from "node:net";
import readline from "node:readline";
import { getLogger } from "@shared/logger.js";
import type {
  DaemonMethod,
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
} from "@shared/protocol.js";

const log = getLogger("mcp/daemon-client");

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type NotificationHandler = (notification: DaemonNotification) => void;

export class DaemonClient {
  private socket: net.Socket | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notificationHandlers: NotificationHandler[] = [];
  private connected = false;

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => {
        log.info({ socketPath: this.socketPath }, "connected to daemon");
        this.socket = socket;
        this.rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
        this.rl.on("line", (line) => this.handleLine(line));
        socket.on("close", () => this.handleClose());
        socket.on("error", (err) => log.warn({ err }, "socket error"));
        this.connected = true;
        resolve();
      });
      socket.once("error", (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  async call<R = unknown>(method: DaemonMethod, params: unknown = {}): Promise<R> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("daemon client not connected");
    }
    const id = this.nextId++;
    const req: DaemonRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
      });
      this.socket!.write(JSON.stringify(req) + "\n");
    });
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  close(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: DaemonResponse | DaemonNotification;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      log.warn({ err, line: trimmed.slice(0, 200) }, "could not parse daemon message");
      return;
    }
    if ("id" in msg && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) {
        log.warn({ id: msg.id }, "response for unknown id");
        return;
      }
      this.pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        const err = new Error(msg.error.message) as Error & { code?: number; data?: unknown };
        err.code = msg.error.code;
        err.data = msg.error.data;
        p.reject(err);
      } else if ("result" in msg) {
        p.resolve(msg.result);
      } else {
        p.reject(new Error("malformed response"));
      }
    } else if ("method" in msg) {
      for (const h of this.notificationHandlers) {
        try {
          h(msg);
        } catch (err) {
          log.warn({ err }, "notification handler threw");
        }
      }
    }
  }

  private handleClose(): void {
    this.connected = false;
    const err = new Error("daemon connection closed");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    log.warn("daemon socket closed");
  }
}
