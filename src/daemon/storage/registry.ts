import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getRegistryDbPath } from "@shared/paths.js";
import { getLogger } from "@shared/logger.js";
import type { SessionSource } from "@shared/protocol.js";

const log = getLogger("daemon/registry");

export type SessionStatus = "open" | "closed";

export interface RegistryRow {
  id: string;
  title: string | null;
  createdAt: number;
  lastActivity: number;
  status: SessionStatus;
  source: SessionSource | null;
  pageCount: number;
  sizeBytes: number;
  closedAt: number | null;
  dataDir: string | null;
}

/**
 * Persistent cross-session index. A SEPARATE SQLite DB from the per-session
 * db.sqlite files (it must NOT go through the per-session migration runner).
 * It survives daemon restarts and lets us enumerate / reason about sessions
 * (age, size, status) without loading every BrowserContext + session DB.
 *
 * Every mutation is best-effort: it logs and swallows errors. A registry
 * failure must NEVER break session ensure/close — the index is an optimization,
 * the in-memory map + on-disk dirs remain the source of truth.
 */
export class RegistryStore {
  private readonly db: Db;

  constructor(dataDir?: string) {
    const p = getRegistryDbPath(dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.db = new Database(p);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 2000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id            TEXT PRIMARY KEY,
        created_at    INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'open',
        source        TEXT,
        page_count    INTEGER NOT NULL DEFAULT 0,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        closed_at     INTEGER,
        data_dir      TEXT,
        title         TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_sessions_last_activity ON sessions(last_activity);
      CREATE INDEX IF NOT EXISTS ix_sessions_status        ON sessions(status);
    `);
    // Idempotent upgrade for registries created before the title column existed.
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "title")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS ix_sessions_title ON sessions(title)`);
  }

  /** Insert or re-open a session row (called once per create). */
  upsertOpen(row: {
    id: string;
    createdAt: number;
    lastActivity: number;
    source: SessionSource | null;
    dataDir: string | null;
    title: string | null;
  }): void {
    this.run(
      `INSERT INTO sessions (id, created_at, last_activity, status, source, data_dir, title)
       VALUES (@id, @createdAt, @lastActivity, 'open', @source, @dataDir, @title)
       ON CONFLICT(id) DO UPDATE SET
         status='open', last_activity=@lastActivity,
         source=COALESCE(@source, source), data_dir=@dataDir, closed_at=NULL,
         title=COALESCE(@title, title)`,
      row,
    );
  }

  /** Newest-active session id carrying `title`, or null. */
  resolveByTitle(title: string): string | null {
    try {
      const row = this.db
        .prepare(`SELECT id FROM sessions WHERE title=? ORDER BY last_activity DESC LIMIT 1`)
        .get(title) as { id: string } | undefined;
      return row?.id ?? null;
    } catch (err) {
      log.warn({ err, title }, "registry.resolveByTitle failed");
      return null;
    }
  }

  /** Periodic stats flush from the reaper tick (live sessions only). */
  updateStats(id: string, s: { lastActivity: number; sizeBytes: number; pageCount: number }): void {
    this.run(
      `UPDATE sessions SET last_activity=@lastActivity, size_bytes=@sizeBytes, page_count=@pageCount
       WHERE id=@id`,
      { id, ...s },
    );
  }

  /** Flip a session to closed, retaining the row for discovery/history. */
  markClosed(
    id: string,
    s: { closedAt: number; lastActivity: number; sizeBytes: number; pageCount: number },
  ): void {
    this.run(
      `UPDATE sessions SET status='closed', closed_at=@closedAt, last_activity=@lastActivity,
         size_bytes=@sizeBytes, page_count=@pageCount WHERE id=@id`,
      { id, ...s },
    );
  }

  /** Remove a row entirely — used when the on-disk dir is age-swept. */
  delete(id: string): void {
    this.run(`DELETE FROM sessions WHERE id=@id`, { id });
  }

  /**
   * Boot reconciliation: the in-memory map is empty at boot, so any row still
   * marked 'open' is an orphan from an unclean shutdown. Heal in one statement.
   */
  markAllClosed(now: number): void {
    this.run(
      `UPDATE sessions SET status='closed', closed_at=COALESCE(closed_at, @now) WHERE status='open'`,
      { now },
    );
  }

  /** True if a row exists for this id (used during dir reconciliation). */
  has(id: string): boolean {
    try {
      return this.db.prepare(`SELECT 1 FROM sessions WHERE id=?`).get(id) != null;
    } catch (err) {
      log.warn({ err, id }, "registry.has failed");
      return false;
    }
  }

  /** Insert a discovered on-disk session as a closed index entry. */
  insertClosed(row: {
    id: string;
    createdAt: number;
    lastActivity: number;
    sizeBytes: number;
    dataDir: string | null;
  }): void {
    this.run(
      `INSERT OR IGNORE INTO sessions
         (id, created_at, last_activity, status, page_count, size_bytes, closed_at, data_dir)
       VALUES (@id, @createdAt, @lastActivity, 'closed', 0, @sizeBytes, @lastActivity, @dataDir)`,
      row,
    );
  }

  /** All rows, newest activity first. Empty on error. */
  list(status?: SessionStatus): RegistryRow[] {
    try {
      const sql = status
        ? `SELECT * FROM sessions WHERE status=? ORDER BY last_activity DESC`
        : `SELECT * FROM sessions ORDER BY last_activity DESC`;
      const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as any[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title ?? null,
        createdAt: r.created_at,
        lastActivity: r.last_activity,
        status: r.status,
        source: r.source ?? null,
        pageCount: r.page_count,
        sizeBytes: r.size_bytes,
        closedAt: r.closed_at ?? null,
        dataDir: r.data_dir ?? null,
      }));
    } catch (err) {
      log.warn({ err }, "registry.list failed");
      return [];
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn({ err }, "error closing registry db");
    }
  }

  private run(sql: string, params: Record<string, unknown>): void {
    try {
      this.db.prepare(sql).run(params);
    } catch (err) {
      log.warn({ err, sql }, "registry write failed (non-fatal)");
    }
  }
}
