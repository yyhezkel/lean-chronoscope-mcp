import type { HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { PageCollector } from "./PageCollector.js";
import type { SessionWriter } from "../storage/writer.js";
import type { Broadcaster } from "../live/broadcaster.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/collectors/network");

const MAX_BODY_BYTES = 2_000_000; // safety cap: never inhale > 2MB into memory per response

export class NetworkCollector extends PageCollector {
  /** request ids we've already inserted (skip duplicate requestservedfromcache events). */
  private seen = new Set<string>();

  constructor(
    page: Page,
    pageId: string,
    private readonly writer: SessionWriter,
    sessionId?: string,
    broadcaster?: Broadcaster,
    private readonly opts: { captureBodies?: boolean } = {},
  ) {
    super(page, pageId, sessionId, broadcaster);
  }

  override async start(): Promise<void> {
    const onRequest = (req: HTTPRequest) => {
      const rid = requestId(req);
      if (this.seen.has(rid)) return;
      this.seen.add(rid);
      try {
        const initiator = (req as any).initiator?.();
        const ts = Date.now();
        const lastId = this.writer.insertNetworkRequest({
          pageId: this.pageId,
          navId: this.currentNavId,
          requestId: rid,
          tsRequest: ts,
          method: req.method(),
          url: req.url(),
          resourceType: req.resourceType(),
          initiator: initiator ? JSON.stringify(initiator) : undefined,
          reqHeaders: JSON.stringify(req.headers()),
        });
        this.emitPage("page.network", { kind: "network.request", lastId, lastTs: ts });
      } catch (err) {
        log.warn({ err, url: req.url() }, "network request insert failed");
      }
    };
    this.page.on("request", onRequest);
    this.onDispose(() => this.page.off("request", onRequest));

    const onResponse = (resp: HTTPResponse) => {
      const req = resp.request();
      const rid = requestId(req);
      const remoteIp = resp.remoteAddress?.()?.ip;
      try {
        const ts = Date.now();
        this.writer.updateNetworkResponse({
          requestId: rid,
          tsResponse: ts,
          status: resp.status(),
          statusText: resp.statusText(),
          protocol: undefined,
          remoteIp: remoteIp ?? undefined,
          fromDiskCache: resp.fromCache(),
          fromSvcWorker: !!resp.fromServiceWorker?.(),
          resHeaders: JSON.stringify(resp.headers()),
        });
        this.emitPage("page.network", { kind: "network.response", lastTs: ts });
      } catch (err) {
        log.warn({ err, url: req.url() }, "network response update failed");
      }
    };
    this.page.on("response", onResponse);
    this.onDispose(() => this.page.off("response", onResponse));

    const onFinished = (req: HTTPRequest) => {
      const rid = requestId(req);
      void this.finalize(req, rid).catch((err) => {
        log.warn({ err, url: req.url() }, "network finalize failed");
      });
    };
    this.page.on("requestfinished", onFinished);
    this.onDispose(() => this.page.off("requestfinished", onFinished));

    const onFailed = (req: HTTPRequest) => {
      const rid = requestId(req);
      try {
        const ts = Date.now();
        this.writer.updateNetworkFailed({
          requestId: rid,
          tsFinished: ts,
          errorText: req.failure()?.errorText ?? "unknown",
        });
        this.emitPage("page.network", { kind: "network.failed", lastTs: ts });
      } catch (err) {
        log.warn({ err, url: req.url() }, "network failure update failed");
      }
    };
    this.page.on("requestfailed", onFailed);
    this.onDispose(() => this.page.off("requestfailed", onFailed));
  }

  private async finalize(req: HTTPRequest, rid: string): Promise<void> {
    let body: Buffer | string | undefined;
    let size: number | undefined;
    if (this.opts.captureBodies) {
      try {
        const resp = req.response();
        if (resp) {
          const raw = await resp.content();
          const buf = Buffer.from(raw);
          if (buf.length <= MAX_BODY_BYTES) {
            body = buf;
            size = buf.length;
          } else {
            size = buf.length;
          }
        }
      } catch {
        /* some responses (preflight, redirects) have no body */
      }
    }
    const ts = Date.now();
    this.writer.updateNetworkFinished({
      requestId: rid,
      tsFinished: ts,
      sizeResponse: size,
      body,
    });
    this.emitPage("page.network", { kind: "network.finished", lastTs: ts });
  }
}

function requestId(req: HTTPRequest): string {
  // puppeteer-core 24 exposes the stable CDP request id via the public `id`
  // getter; older internal field `_requestId` is the fallback. Both are stable
  // for the lifetime of the request, so the same `req` yields the same key in
  // onRequest and onResponse (critical — a per-call random id would break the
  // response UPDATE and leave status NULL forever).
  const pub = (req as unknown as { id?: string }).id;
  if (pub) return pub;
  const internal = (req as any)._requestId as string | undefined;
  if (internal) return internal;
  // Last resort: stable-ish key without a random suffix so request/response
  // at least correlate within the same URL+method.
  return `${req.method()}_${req.url()}`;
}
