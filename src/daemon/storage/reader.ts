import type { Database } from "better-sqlite3";

export interface ConsoleSummary {
  id: number;
  pageId: string;
  navId: number | null;
  ts: number;
  level: string;
  text: string;
  source: string | null;
  url: string | null;
  line: number | null;
  col: number | null;
  hasStack: boolean;
  hasArgs: boolean;
}

export interface ConsoleDetail extends ConsoleSummary {
  stackSha: string | null;
  argsSha: string | null;
}

export interface NetworkSummary {
  id: number;
  pageId: string;
  navId: number | null;
  requestId: string;
  tsRequest: number;
  tsResponse: number | null;
  tsFinished: number | null;
  method: string;
  url: string;
  resourceType: string | null;
  status: number | null;
  errorText: string | null;
  sizeResponse: number | null;
}

export interface NetworkDetail extends NetworkSummary {
  statusText: string | null;
  protocol: string | null;
  remoteIp: string | null;
  fromDiskCache: boolean;
  fromSvcWorker: boolean;
  reqHeaders: string | null;
  resHeaders: string | null;
  reqBodyText: string | null;
  reqBodyBlob: string | null;
  resBodyText: string | null;
  resBodyBlob: string | null;
  initiator: string | null;
}

export interface ExceptionSummary {
  id: number;
  pageId: string;
  navId: number | null;
  ts: number;
  text: string;
  url: string | null;
  line: number | null;
  col: number | null;
  stack: string | null;
}

export interface ListOptions {
  pageId?: string;
  navId?: number;
  level?: string;
  sinceTs?: number;
  limit: number;
  offset: number;
}

export class SessionReader {
  constructor(private readonly db: Database) {}

  /** Latest navigation id for a page (newest first). 0-based index from latest. */
  getNavIdsForPage(pageId: string, maxLast = 3): number[] {
    return this.db
      .prepare("SELECT id FROM navigations WHERE page_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(pageId, maxLast)
      .map((r: any) => r.id as number);
  }

  listConsole(opts: ListOptions): { rows: ConsoleSummary[]; total: number } {
    const { where, params } = buildWhere({
      page_id: opts.pageId,
      nav_id: opts.navId,
      level: opts.level,
      ts_min: opts.sinceTs,
    });
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM console_messages ${where}`).get(...params) as any).c as number;
    const rows = this.db
      .prepare(
        `SELECT id, page_id, nav_id, ts, level, text, source, url, line, col,
                CASE WHEN stack_blob IS NULL THEN 0 ELSE 1 END as has_stack,
                CASE WHEN args_blob IS NULL THEN 0 ELSE 1 END as has_args
         FROM console_messages ${where} ORDER BY ts ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as any[];
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        navId: r.nav_id,
        ts: r.ts,
        level: r.level,
        text: r.text,
        source: r.source,
        url: r.url,
        line: r.line,
        col: r.col,
        hasStack: !!r.has_stack,
        hasArgs: !!r.has_args,
      })),
    };
  }

  getConsole(id: number): ConsoleDetail | null {
    const r = this.db
      .prepare(
        `SELECT id, page_id, nav_id, ts, level, text, source, url, line, col, stack_blob, args_blob
         FROM console_messages WHERE id = ?`,
      )
      .get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      pageId: r.page_id,
      navId: r.nav_id,
      ts: r.ts,
      level: r.level,
      text: r.text,
      source: r.source,
      url: r.url,
      line: r.line,
      col: r.col,
      hasStack: !!r.stack_blob,
      hasArgs: !!r.args_blob,
      stackSha: r.stack_blob,
      argsSha: r.args_blob,
    };
  }

  listNetwork(opts: ListOptions & { hideStatic?: boolean; urlContains?: string; status?: number }): {
    rows: NetworkSummary[];
    total: number;
  } {
    const filters: Record<string, unknown> = {
      page_id: opts.pageId,
      nav_id: opts.navId,
    };
    const extras: string[] = [];
    const extraParams: unknown[] = [];
    if (opts.sinceTs != null) {
      extras.push("ts_request >= ?");
      extraParams.push(opts.sinceTs);
    }
    if (opts.status != null) {
      extras.push("status = ?");
      extraParams.push(opts.status);
    }
    if (opts.urlContains) {
      extras.push("url LIKE ?");
      extraParams.push(`%${opts.urlContains}%`);
    }
    if (opts.hideStatic) {
      extras.push(
        `(status IS NULL OR status >= 400 OR resource_type NOT IN ('stylesheet','image','font','media','manifest'))`,
      );
    }

    const { where: baseWhere, params } = buildWhere(filters);
    const finalWhere =
      extras.length === 0
        ? baseWhere
        : baseWhere
          ? `${baseWhere} AND ${extras.join(" AND ")}`
          : `WHERE ${extras.join(" AND ")}`;
    const allParams = [...params, ...extraParams];
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM network_requests ${finalWhere}`).get(...allParams) as any).c as number;
    const rows = this.db
      .prepare(
        `SELECT id, page_id, nav_id, request_id, ts_request, ts_response, ts_finished,
                method, url, resource_type, status, error_text, size_response
         FROM network_requests ${finalWhere} ORDER BY ts_request ASC LIMIT ? OFFSET ?`,
      )
      .all(...allParams, opts.limit, opts.offset) as any[];
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        navId: r.nav_id,
        requestId: r.request_id,
        tsRequest: r.ts_request,
        tsResponse: r.ts_response,
        tsFinished: r.ts_finished,
        method: r.method,
        url: r.url,
        resourceType: r.resource_type,
        status: r.status,
        errorText: r.error_text,
        sizeResponse: r.size_response,
      })),
    };
  }

  getNetwork(id: number): NetworkDetail | null {
    const r = this.db.prepare(`SELECT * FROM network_requests WHERE id = ?`).get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      pageId: r.page_id,
      navId: r.nav_id,
      requestId: r.request_id,
      tsRequest: r.ts_request,
      tsResponse: r.ts_response,
      tsFinished: r.ts_finished,
      method: r.method,
      url: r.url,
      resourceType: r.resource_type,
      status: r.status,
      statusText: r.status_text,
      protocol: r.protocol,
      remoteIp: r.remote_ip,
      fromDiskCache: !!r.from_disk_cache,
      fromSvcWorker: !!r.from_svc_worker,
      sizeResponse: r.size_response,
      errorText: r.error_text,
      reqHeaders: r.req_headers,
      resHeaders: r.res_headers,
      reqBodyText: r.req_body_text,
      reqBodyBlob: r.req_body_blob,
      resBodyText: r.res_body_text,
      resBodyBlob: r.res_body_blob,
      initiator: r.initiator,
    };
  }

  tableCounts(): { console: number; network: number; snapshots: number; exceptions: number } {
    const count = (sql: string) =>
      ((this.db.prepare(sql).get() as any)?.c ?? 0) as number;
    return {
      console: count("SELECT COUNT(*) as c FROM console_messages"),
      network: count("SELECT COUNT(*) as c FROM network_requests"),
      snapshots: count("SELECT COUNT(*) as c FROM snapshots"),
      exceptions: count("SELECT COUNT(*) as c FROM exceptions"),
    };
  }

  searchConsole(query: string, limit: number): {
    rows: Array<{ id: number; pageId: string; ts: number; level: string; text: string; snippet: string }>;
    total: number;
  } {
    const q = normalizeFtsQuery(query);
    const total = (this.db
      .prepare(`SELECT COUNT(*) as c FROM console_fts WHERE console_fts MATCH ?`)
      .get(q) as any).c as number;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.page_id as pageId, c.ts, c.level, c.text,
                snippet(console_fts, 0, '[', ']', '…', 12) as snippet
         FROM console_fts
         JOIN console_messages c ON c.id = console_fts.rowid
         WHERE console_fts MATCH ?
         ORDER BY bm25(console_fts) LIMIT ?`,
      )
      .all(q, limit) as any[];
    return { total, rows };
  }

  searchNetwork(query: string, limit: number): {
    rows: Array<{ id: number; pageId: string; ts: number; method: string; url: string; status: number | null; snippet: string }>;
    total: number;
  } {
    const q = normalizeFtsQuery(query);
    const total = (this.db
      .prepare(`SELECT COUNT(*) as c FROM network_fts WHERE network_fts MATCH ?`)
      .get(q) as any).c as number;
    // FTS5 auxiliary functions (snippet/bm25) can't be combined with a JOIN on
    // a multi-column external-content table here (SQLite raises "SQL logic
    // error"). Rank in a subquery over the FTS table alone, then join for the
    // display columns. The URL itself is the most useful "snippet" for network.
    const rows = this.db
      .prepare(
        `SELECT n.id, n.page_id as pageId, n.ts_request as ts, n.method, n.url, n.status,
                n.url as snippet
         FROM (
           SELECT rowid, rank FROM network_fts WHERE network_fts MATCH ? ORDER BY rank LIMIT ?
         ) m
         JOIN network_requests n ON n.id = m.rowid`,
      )
      .all(q, limit) as any[];
    return { total, rows };
  }

  getLatestSnapshotIds(pageId: string, limit: number): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM snapshots WHERE page_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(pageId, limit) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  getSnapshotById(id: number): {
    id: number;
    pageId: string;
    ts: number;
    url: string;
    loaderId: string | null;
    treeJson: string;
    uidCount: number;
  } | null {
    const r = this.db.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id) as any;
    if (!r) return null;
    return {
      id: r.id,
      pageId: r.page_id,
      ts: r.ts,
      url: r.url,
      loaderId: r.loader_id,
      treeJson: r.tree_blob,
      uidCount: r.uid_count,
    };
  }

  listExceptions(opts: ListOptions): { rows: ExceptionSummary[]; total: number } {
    const { where, params } = buildWhere({
      page_id: opts.pageId,
      nav_id: opts.navId,
      ts_min: opts.sinceTs,
    });
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM exceptions ${where}`).get(...params) as any).c as number;
    const rows = this.db
      .prepare(
        `SELECT * FROM exceptions ${where} ORDER BY ts ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as any[];
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        pageId: r.page_id,
        navId: r.nav_id,
        ts: r.ts,
        text: r.text,
        url: r.url,
        line: r.line,
        col: r.col,
        stack: r.stack,
      })),
    };
  }
}

/**
 * Make a user query safe for FTS5 MATCH. FTS5 chokes on bare terms containing
 * punctuation it treats as operators (`.`, `:`, `-`, `/`, etc.) — e.g.
 * `example.com` raises "fts5: syntax error near .". If the query already looks
 * like a valid FTS expression (quoted, or contains explicit AND/OR/NEAR/`*`),
 * pass it through; otherwise split on non-word chars and AND the terms together
 * as quoted phrases. This keeps advanced search working while making the common
 * "paste a URL or dotted token" case Just Work.
 */
function normalizeFtsQuery(raw: string): string {
  const q = raw.trim();
  if (!q) return '""';
  // Looks like an intentional FTS expression — leave it alone.
  if (/["()*]/.test(q) || /\b(AND|OR|NOT|NEAR)\b/.test(q)) return q;
  // If it's a single clean alphanumeric token, pass through (cheapest path).
  if (/^[A-Za-z0-9_]+$/.test(q)) return q;
  // Otherwise split into word-ish tokens and AND quoted phrases.
  const tokens = q.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(" ");
}

function buildWhere(filters: Record<string, unknown>): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(filters)) {
    if (v == null) continue;
    if (k === "ts_min") {
      parts.push("ts >= ?");
      params.push(v);
    } else {
      parts.push(`${k} = ?`);
      params.push(v);
    }
  }
  return parts.length === 0
    ? { where: "", params }
    : { where: `WHERE ${parts.join(" AND ")}`, params };
}
