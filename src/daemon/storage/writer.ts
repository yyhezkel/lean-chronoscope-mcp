import type { Database } from "better-sqlite3";
import { env } from "@shared/env.js";
import { BlobStore } from "./blobs.js";

const INLINE_BODY_THRESHOLD = 10_000;

export interface InsertPageRow {
  id: string;
  targetId: string;
  url?: string;
  title?: string;
}

export interface InsertNavRow {
  pageId: string;
  loaderId: string;
  url: string;
  status?: string;
}

export interface InsertConsoleRow {
  pageId: string;
  navId: number | null;
  ts: number;
  level: string;
  text: string;
  source?: string;
  url?: string;
  line?: number;
  col?: number;
  stack?: string;
  args?: string;
}

export interface InsertNetworkRow {
  pageId: string;
  navId: number | null;
  requestId: string;
  tsRequest: number;
  method: string;
  url: string;
  resourceType?: string;
  initiator?: string;
  reqHeaders?: string;
}

export interface UpdateNetworkResponseRow {
  requestId: string;
  tsResponse: number;
  status: number;
  statusText?: string;
  protocol?: string;
  remoteIp?: string;
  fromDiskCache?: boolean;
  fromSvcWorker?: boolean;
  resHeaders?: string;
}

export interface UpdateNetworkFinishedRow {
  requestId: string;
  tsFinished: number;
  sizeResponse?: number;
  body?: string | Buffer;
}

export interface UpdateNetworkFailedRow {
  requestId: string;
  tsFinished: number;
  errorText: string;
}

export interface InsertExceptionRow {
  pageId: string;
  navId: number | null;
  ts: number;
  text: string;
  url?: string;
  line?: number;
  col?: number;
  stack?: string;
}

/** Sync, prepared-statement-backed writer. No await in hot paths. */
export class SessionWriter {
  private readonly insPage;
  private readonly closePage;
  private readonly insNav;
  private readonly finNav;
  private readonly insConsole;
  private readonly insNetwork;
  private readonly updNetResp;
  private readonly updNetFin;
  private readonly updNetFail;
  private readonly insException;
  private readonly insSnapshot;

  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {
    this.insPage = db.prepare(
      `INSERT OR REPLACE INTO pages (id, target_id, url, title, opened_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.closePage = db.prepare(`UPDATE pages SET closed_at = ? WHERE id = ?`);
    this.insNav = db.prepare(
      `INSERT INTO navigations (page_id, loader_id, url, started_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.finNav = db.prepare(
      `UPDATE navigations SET finished_at = ?, status = ? WHERE id = ?`,
    );
    this.insConsole = db.prepare(
      `INSERT INTO console_messages (page_id, nav_id, ts, level, text, source, url, line, col, stack_blob, args_blob)
       VALUES (@pageId, @navId, @ts, @level, @text, @source, @url, @line, @col, @stack, @args)`,
    );
    this.insNetwork = db.prepare(
      `INSERT INTO network_requests (page_id, nav_id, request_id, ts_request, method, url, resource_type, initiator, req_headers)
       VALUES (@pageId, @navId, @requestId, @tsRequest, @method, @url, @resourceType, @initiator, @reqHeaders)`,
    );
    this.updNetResp = db.prepare(
      `UPDATE network_requests
       SET ts_response = @tsResponse, status = @status, status_text = @statusText,
           protocol = @protocol, remote_ip = @remoteIp,
           from_disk_cache = @fromDiskCache, from_svc_worker = @fromSvcWorker,
           res_headers = @resHeaders
       WHERE request_id = @requestId`,
    );
    this.updNetFin = db.prepare(
      `UPDATE network_requests
       SET ts_finished = @tsFinished, size_response = @sizeResponse,
           res_body_text = @resBodyText, res_body_blob = @resBodyBlob
       WHERE request_id = @requestId`,
    );
    this.updNetFail = db.prepare(
      `UPDATE network_requests SET ts_finished = ?, error_text = ? WHERE request_id = ?`,
    );
    this.insException = db.prepare(
      `INSERT INTO exceptions (page_id, nav_id, ts, text, url, line, col, stack)
       VALUES (@pageId, @navId, @ts, @text, @url, @line, @col, @stack)`,
    );
    this.insSnapshot = db.prepare(
      `INSERT INTO snapshots (page_id, ts, url, loader_id, tree_blob, uid_count, parent_id)
       VALUES (@pageId, @ts, @url, @loaderId, @treeBlob, @uidCount, @parentId)`,
    );
  }

  insertPage(row: InsertPageRow): void {
    this.insPage.run(row.id, row.targetId, row.url ?? null, row.title ?? null, Date.now());
  }

  markPageClosed(pageId: string): void {
    this.closePage.run(Date.now(), pageId);
  }

  insertNavigation(row: InsertNavRow): number {
    const result = this.insNav.run(
      row.pageId,
      row.loaderId,
      row.url,
      Date.now(),
      row.status ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  finishNavigation(id: number, status: string): void {
    this.finNav.run(Date.now(), status, id);
  }

  insertConsole(row: InsertConsoleRow): number {
    const info = this.insConsole.run({
      pageId: row.pageId,
      navId: row.navId,
      ts: row.ts,
      level: row.level,
      text: row.text,
      source: row.source ?? null,
      url: row.url ?? null,
      line: row.line ?? null,
      col: row.col ?? null,
      stack: row.stack ? this.blobs.put(row.stack) : null,
      args: row.args ? this.blobs.put(row.args) : null,
    });
    return Number(info.lastInsertRowid);
  }

  insertNetworkRequest(row: InsertNetworkRow): number {
    const info = this.insNetwork.run({
      pageId: row.pageId,
      navId: row.navId,
      requestId: row.requestId,
      tsRequest: row.tsRequest,
      method: row.method,
      url: row.url,
      resourceType: row.resourceType ?? null,
      initiator: row.initiator ?? null,
      reqHeaders: row.reqHeaders ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  updateNetworkResponse(row: UpdateNetworkResponseRow): void {
    this.updNetResp.run({
      requestId: row.requestId,
      tsResponse: row.tsResponse,
      status: row.status,
      statusText: row.statusText ?? null,
      protocol: row.protocol ?? null,
      remoteIp: row.remoteIp ?? null,
      fromDiskCache: row.fromDiskCache ? 1 : 0,
      fromSvcWorker: row.fromSvcWorker ? 1 : 0,
      resHeaders: row.resHeaders ?? null,
    });
  }

  updateNetworkFinished(row: UpdateNetworkFinishedRow): void {
    let resBodyText: string | null = null;
    let resBodyBlob: string | null = null;
    if (row.body != null) {
      const buf = typeof row.body === "string" ? Buffer.from(row.body, "utf8") : row.body;
      if (buf.length < INLINE_BODY_THRESHOLD) {
        resBodyText = buf.toString("utf8");
      } else {
        resBodyBlob = this.blobs.put(buf);
      }
    }
    this.updNetFin.run({
      requestId: row.requestId,
      tsFinished: row.tsFinished,
      sizeResponse: row.sizeResponse ?? null,
      resBodyText,
      resBodyBlob,
    });
  }

  updateNetworkFailed(row: UpdateNetworkFailedRow): void {
    this.updNetFail.run(row.tsFinished, row.errorText, row.requestId);
  }

  insertSnapshot(row: {
    pageId: string;
    ts: number;
    url: string;
    loaderId: string | null;
    treeJson: string;
    uidCount: number;
    parentId?: number | null;
  }): number {
    const info = this.insSnapshot.run({
      pageId: row.pageId,
      ts: row.ts,
      url: row.url,
      loaderId: row.loaderId,
      treeBlob: row.treeJson,
      uidCount: row.uidCount,
      parentId: row.parentId ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  insertException(row: InsertExceptionRow): number {
    const info = this.insException.run({
      pageId: row.pageId,
      navId: row.navId,
      ts: row.ts,
      text: row.text,
      url: row.url ?? null,
      line: row.line ?? null,
      col: row.col ?? null,
      stack: row.stack ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /**
   * Bound in-session growth by count (the primary growth cap). Keeps the newest
   * N console/network rows and the newest N snapshots PER page. The FTS mirrors
   * stay consistent automatically via the AFTER DELETE triggers (migration 003)
   * — never DELETE from console_fts/network_fts directly. Freed pages are handed
   * back to the OS via incremental_vacuum (cheap, bounded, non-locking).
   *
   * Called only from the reaper tick (cold path), guarded by inFlight===0.
   * After deleting rows it sweeps now-orphaned blob files (dedup-safe — a blob
   * is removed only when no surviving row references its sha).
   */
  prune(): void {
    const maxConsole = Number(env("MAX_CONSOLE") ?? 50_000);
    const maxNetwork = Number(env("MAX_NETWORK") ?? 50_000);
    const maxSnapPerPage = Number(env("MAX_SNAPSHOTS_PER_PAGE") ?? 10);

    const tx = this.db.transaction(() => {
      let n = 0;
      if (maxConsole > 0) {
        n += this.db
          .prepare(
            `DELETE FROM console_messages WHERE id NOT IN (
               SELECT id FROM console_messages ORDER BY id DESC LIMIT ?)`,
          )
          .run(maxConsole).changes;
      }
      if (maxNetwork > 0) {
        n += this.db
          .prepare(
            `DELETE FROM network_requests WHERE id NOT IN (
               SELECT id FROM network_requests ORDER BY id DESC LIMIT ?)`,
          )
          .run(maxNetwork).changes;
      }
      if (maxSnapPerPage > 0) {
        // Rank each page's snapshots newest-first; surplus = rank > N. Null out
        // parent_id pointers into the surplus first so the self-FK never dangles,
        // then delete the surplus.
        const surplus = `SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY id DESC) AS rn
             FROM snapshots
           ) WHERE rn > ?`;
        this.db.prepare(`UPDATE snapshots SET parent_id = NULL WHERE parent_id IN (${surplus})`).run(
          maxSnapPerPage,
        );
        n += this.db.prepare(`DELETE FROM snapshots WHERE id IN (${surplus})`).run(maxSnapPerPage).changes;
      }
      return n;
    });
    const deleted = tx() as number;

    // Only walk the blob dir when rows actually went away. Console/network are
    // the only tables that spill blobs; a deleted row may have orphaned its
    // stack/args/body blob.
    if (deleted > 0) {
      this.blobs.sweepUnreferenced(this.referencedBlobShas());
    }

    try {
      this.db.pragma("incremental_vacuum(1000)");
    } catch {
      /* no-op unless auto_vacuum=INCREMENTAL was enabled at create */
    }
  }

  /**
   * Every blob sha still referenced by a row. Blobs come only from the 4
   * spill columns (snapshots.tree_blob / exceptions.stack are inline TEXT).
   */
  private referencedBlobShas(): Set<string> {
    const set = new Set<string>();
    const add = (sql: string) => {
      for (const r of this.db.prepare(sql).all() as Array<{ s: string | null }>) {
        if (r.s) set.add(r.s);
      }
    };
    add(`SELECT DISTINCT stack_blob AS s FROM console_messages WHERE stack_blob IS NOT NULL`);
    add(`SELECT DISTINCT args_blob AS s FROM console_messages WHERE args_blob IS NOT NULL`);
    add(`SELECT DISTINCT req_body_blob AS s FROM network_requests WHERE req_body_blob IS NOT NULL`);
    add(`SELECT DISTINCT res_body_blob AS s FROM network_requests WHERE res_body_blob IS NOT NULL`);
    return set;
  }
}
