import type { CDPSession, ConsoleMessage, Page } from "puppeteer-core";
import { PageCollector } from "./PageCollector.js";
import type { SessionWriter } from "../storage/writer.js";
import type { Broadcaster } from "../live/broadcaster.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/collectors/console");

const LEVEL_MAP: Record<string, string> = {
  log: "log",
  info: "info",
  warning: "warn",
  warn: "warn",
  error: "error",
  debug: "debug",
  trace: "trace",
  verbose: "debug",
};

export class ConsoleCollector extends PageCollector {
  constructor(
    page: Page,
    pageId: string,
    private readonly writer: SessionWriter,
    sessionId?: string,
    broadcaster?: Broadcaster,
  ) {
    super(page, pageId, sessionId, broadcaster);
  }

  override async start(): Promise<void> {
    // 1) Puppeteer-level console events (page.on('console')).
    const onConsole = (msg: ConsoleMessage) => {
      try {
        const loc = msg.location();
        const text = msg.text();
        const args = msg.args();
        let argsBlob: string | undefined;
        if (args.length > 0) {
          try {
            argsBlob = JSON.stringify(args.map((a) => safePreview(a)));
          } catch {
            /* ignore */
          }
        }
        const ts = Date.now();
        const lastId = this.writer.insertConsole({
          pageId: this.pageId,
          navId: this.currentNavId,
          ts,
          level: LEVEL_MAP[msg.type()] ?? msg.type(),
          text,
          source: "console",
          url: loc.url,
          line: loc.lineNumber,
          col: loc.columnNumber,
          args: argsBlob,
        });
        this.emitPage("page.console", { kind: "console", lastId, lastTs: ts });
      } catch (err) {
        log.warn({ err }, "console insert failed");
      }
    };
    this.page.on("console", onConsole);
    this.onDispose(() => this.page.off("console", onConsole));

    const onPageError = (evt: unknown) => {
      const err = evt as Error;
      try {
        const ts = Date.now();
        const lastId = this.writer.insertException({
          pageId: this.pageId,
          navId: this.currentNavId,
          ts,
          text: err?.message ?? String(evt),
          stack: err?.stack ?? undefined,
        });
        this.emitPage("page.exceptions", { kind: "pageerror", lastId, lastTs: ts });
      } catch (e) {
        log.warn({ e }, "pageerror insert failed");
      }
    };
    this.page.on("pageerror", onPageError);
    this.onDispose(() => this.page.off("pageerror", onPageError));

    // 2) Direct CDP subscription to Runtime.exceptionThrown for uncaught errors
    // that the puppeteer 'pageerror' event sometimes misses.
    const client: CDPSession = await this.page.createCDPSession();
    try {
      await client.send("Runtime.enable");
    } catch (err) {
      log.warn({ err }, "Runtime.enable failed (cdp)");
    }
    const onException = (params: any) => {
      const ex = params?.exceptionDetails;
      if (!ex) return;
      const text = ex.exception?.description ?? ex.text ?? "Uncaught exception";
      try {
        const ts = Date.now();
        const lastId = this.writer.insertException({
          pageId: this.pageId,
          navId: this.currentNavId,
          ts,
          text,
          url: ex.url,
          line: ex.lineNumber,
          col: ex.columnNumber,
          stack: ex.stackTrace ? JSON.stringify(ex.stackTrace) : null,
        } as any);
        this.emitPage("page.exceptions", { kind: "exception", lastId, lastTs: ts });
      } catch (err) {
        log.warn({ err }, "exception insert failed");
      }
    };
    client.on("Runtime.exceptionThrown", onException);
    this.onDispose(() => {
      try {
        client.off("Runtime.exceptionThrown", onException);
        // detach() rejects ("Session already detached") when the page is
        // already closed. It's async, so a try/catch can't catch it — must
        // attach a .catch() or it escapes as an unhandledRejection.
        void client.detach().catch(() => {});
      } catch {
        /* ignore */
      }
    });
  }
}

function safePreview(handle: any): unknown {
  try {
    const v = handle._remoteObject?.value ?? handle._remoteObject?.description;
    return v ?? String(handle);
  } catch {
    return null;
  }
}
