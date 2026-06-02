import type { CDPSession, Page } from "puppeteer-core";
import { getLogger } from "@shared/logger.js";
import type { Broadcaster } from "../live/broadcaster.js";
import { buildUri } from "../live/uri.js";

const log = getLogger("daemon/intercept");

/**
 * Rule actions:
 *   - abort       fail the request (network error to the page)
 *   - continue    let the request go through, optionally with overrides
 *   - respond     synthesize a response without contacting the server
 *
 * Rules are evaluated in insertion order; the first match wins. `oneShot`
 * removes the rule after its first match so it can model "next request only".
 */
export type RuleAction =
  | { kind: "abort"; reason?: string }
  | {
      kind: "continue";
      method?: string;
      postData?: string;
      headers?: Record<string, string>;
      url?: string;
    }
  | {
      kind: "respond";
      status: number;
      headers?: Record<string, string>;
      body?: string;
      mimeType?: string;
    };

export interface InterceptRule {
  id: string;
  urlPattern: string;
  method?: string;
  oneShot: boolean;
  action: RuleAction;
  /** Wall-clock ms when the rule was added. */
  addedAt: number;
  /** How many times the rule has fired. */
  hits: number;
}

interface RequestPausedEvent {
  requestId: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
  };
  resourceType?: string;
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

/**
 * Per-session interception engine. Holds rules + a CDP session per attached
 * page. Pages must call `attach(page, pageId)` on creation and `detach(pageId)`
 * on close, so the engine can keep `Fetch.enable` patterns in sync.
 *
 * `addRule` / `removeRule` recompute the Fetch.enable pattern set and re-issue
 * it on every attached page (CDP only honors the *last* `Fetch.enable` call —
 * there is no incremental add). The Broadcaster is poked on every change so
 * subscribers of `browser://session/{sid}/intercept/rules` get notified.
 */
export class InterceptionEngine {
  private readonly rules = new Map<string, InterceptRule>();
  private readonly pages = new Map<string, CDPSession>();
  private nextRuleSeq = 1;

  constructor(
    private readonly sessionId: string,
    private readonly broadcaster?: Broadcaster,
  ) {}

  list(): InterceptRule[] {
    return Array.from(this.rules.values());
  }

  async addRule(input: Omit<InterceptRule, "id" | "addedAt" | "hits">): Promise<InterceptRule> {
    const id = `r_${String(this.nextRuleSeq++).padStart(3, "0")}`;
    const rule: InterceptRule = { ...input, id, addedAt: Date.now(), hits: 0 };
    this.rules.set(id, rule);
    await this.syncAllPages();
    this.notifyRulesChanged();
    return rule;
  }

  async removeRule(id: string): Promise<boolean> {
    const had = this.rules.delete(id);
    if (had) {
      await this.syncAllPages();
      this.notifyRulesChanged();
    }
    return had;
  }

  async attach(page: Page, pageId: string): Promise<void> {
    if (this.pages.has(pageId)) return;
    const client = await page.createCDPSession();
    this.pages.set(pageId, client);
    client.on("Fetch.requestPaused", (params: RequestPausedEvent) => {
      void this.handlePaused(client, params);
    });
    // Even with zero rules we don't `Fetch.enable` — the daemon should add no
    // overhead until the user actually wants to intercept.
    if (this.rules.size > 0) {
      await this.enableOnClient(client);
    }
  }

  async detach(pageId: string): Promise<void> {
    const client = this.pages.get(pageId);
    if (!client) return;
    this.pages.delete(pageId);
    try {
      if (this.rules.size > 0) await client.send("Fetch.disable").catch(() => {});
      await client.detach();
    } catch (err) {
      log.warn({ err, pageId }, "intercept client detach failed");
    }
  }

  async dispose(): Promise<void> {
    for (const pageId of Array.from(this.pages.keys())) {
      await this.detach(pageId);
    }
    this.rules.clear();
  }

  private async syncAllPages(): Promise<void> {
    if (this.rules.size === 0) {
      // Disable Fetch on every page so we stop intercepting.
      for (const client of this.pages.values()) {
        try {
          await client.send("Fetch.disable");
        } catch (err) {
          log.warn({ err }, "Fetch.disable failed");
        }
      }
      return;
    }
    for (const client of this.pages.values()) {
      try {
        await this.enableOnClient(client);
      } catch (err) {
        log.warn({ err }, "Fetch.enable failed");
      }
    }
  }

  private async enableOnClient(client: CDPSession): Promise<void> {
    // `Fetch.enable` accepts URL patterns with `*`. We use one entry per rule
    // so CDP can quickly filter without sending every request to us. Method
    // filtering is enforced on our side because CDP's `requestStage` doesn't
    // support per-method filtering.
    const patterns = Array.from(this.rules.values()).map((r) => ({
      urlPattern: r.urlPattern,
      requestStage: "Request" as const,
    }));
    await client.send("Fetch.enable", { patterns });
  }

  private async handlePaused(client: CDPSession, params: RequestPausedEvent): Promise<void> {
    const match = this.findMatch(params);
    if (!match) {
      try {
        await client.send("Fetch.continueRequest", { requestId: params.requestId });
      } catch (err) {
        log.warn({ err }, "passthrough continue failed");
      }
      return;
    }
    match.hits++;
    try {
      switch (match.action.kind) {
        case "abort":
          await client.send("Fetch.failRequest", {
            requestId: params.requestId,
            errorReason: (match.action.reason as any) ?? "Aborted",
          });
          break;
        case "continue":
          await client.send("Fetch.continueRequest", {
            requestId: params.requestId,
            ...(match.action.url ? { url: match.action.url } : {}),
            ...(match.action.method ? { method: match.action.method } : {}),
            ...(match.action.postData
              ? { postData: Buffer.from(match.action.postData).toString("base64") }
              : {}),
            ...(match.action.headers
              ? {
                  headers: Object.entries(match.action.headers).map(([name, value]) => ({
                    name,
                    value,
                  })),
                }
              : {}),
          });
          break;
        case "respond": {
          const body = match.action.body ?? "";
          const headers = { ...(match.action.headers ?? {}) };
          if (match.action.mimeType && !("content-type" in lowercaseKeys(headers))) {
            headers["Content-Type"] = match.action.mimeType;
          }
          await client.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: match.action.status,
            responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
            body: Buffer.from(body).toString("base64"),
          });
          break;
        }
      }
    } catch (err) {
      log.warn({ err, ruleId: match.id }, "intercept action failed");
      try {
        await client.send("Fetch.continueRequest", { requestId: params.requestId });
      } catch {
        /* ignore */
      }
    }
    if (match.oneShot) {
      this.rules.delete(match.id);
      // Async sync so the *current* requestPaused handler returns first.
      void this.syncAllPages();
      this.notifyRulesChanged();
    }
  }

  private findMatch(params: RequestPausedEvent): InterceptRule | null {
    for (const r of this.rules.values()) {
      if (r.method && r.method.toUpperCase() !== params.request.method.toUpperCase()) continue;
      if (!matchesUrlPattern(r.urlPattern, params.request.url)) continue;
      return r;
    }
    return null;
  }

  private notifyRulesChanged(): void {
    if (!this.broadcaster) return;
    this.broadcaster.emit(
      buildUri({ kind: "session.intercept", sessionId: this.sessionId }),
      { kind: "intercept.rules" },
    );
  }
}

function lowercaseKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k]!;
  return out;
}

/**
 * Translate a CDP-style URL glob (`*` matches any chars) into a RegExp and
 * test against `url`. Anchored at both ends because CDP semantics are
 * full-string match.
 */
function matchesUrlPattern(pattern: string, url: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = new RegExp(`^${escaped}$`);
  return re.test(url);
}
