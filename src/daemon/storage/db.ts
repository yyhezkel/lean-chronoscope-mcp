import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionDir } from "@shared/paths.js";
import { getLogger } from "@shared/logger.js";

const log = getLogger("daemon/db");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface SessionDb {
  db: Db;
  sessionId: string;
  dbPath: string;
  close(): void;
}

export function openSessionDb(sessionId: string, dataDir?: string): SessionDb {
  const dir = getSessionDir(sessionId, dataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
  const dbPath = path.join(dir, "db.sqlite");
  const db = new Database(dbPath);

  // Pragmas before migrations.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 2000");

  runMigrations(db, sessionId);
  log.info({ sessionId, dbPath }, "session db opened");

  return {
    db,
    sessionId,
    dbPath,
    close: () => {
      try {
        db.close();
      } catch (err) {
        log.warn({ err, sessionId }, "error closing session db");
      }
    },
  };
}

function runMigrations(db: Db, sessionId: string): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db.prepare("SELECT version FROM _migrations").all().map((r: any) => r.version as number),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = parseInt(file.split("_")[0]!, 10);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
    })();
    log.info({ sessionId, version, file }, "migration applied");
  }

  // Stamp session metadata.
  const upsert = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  upsert.run("session_id", sessionId);
  if (!db.prepare("SELECT value FROM meta WHERE key='created_at'").get()) {
    upsert.run("created_at", String(Date.now()));
  }
  upsert.run("schema_version", String(files.length));
}
