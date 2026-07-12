-- Schema v1. Per-session SQLite at /var/lib/lean-chronoscope/sessions/<id>/db.sqlite.
-- PRAGMAs are set in db.ts before this migration runs (cannot be set inside a transaction).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,
  target_id   TEXT NOT NULL,
  url         TEXT,
  title       TEXT,
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER
);

CREATE TABLE IF NOT EXISTS navigations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      TEXT NOT NULL REFERENCES pages(id),
  loader_id    TEXT NOT NULL,
  url          TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT
);
CREATE INDEX IF NOT EXISTS nav_page_started ON navigations(page_id, started_at DESC);

CREATE TABLE IF NOT EXISTS console_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      TEXT NOT NULL REFERENCES pages(id),
  nav_id       INTEGER REFERENCES navigations(id),
  ts           INTEGER NOT NULL,
  level        TEXT NOT NULL,
  text         TEXT NOT NULL,
  source       TEXT,
  url          TEXT,
  line         INTEGER,
  col          INTEGER,
  stack_blob   TEXT,
  args_blob    TEXT
);
CREATE INDEX IF NOT EXISTS cm_page_ts ON console_messages(page_id, ts DESC);
CREATE INDEX IF NOT EXISTS cm_level ON console_messages(level);
CREATE INDEX IF NOT EXISTS cm_nav ON console_messages(nav_id);

CREATE TABLE IF NOT EXISTS network_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id         TEXT NOT NULL REFERENCES pages(id),
  nav_id          INTEGER REFERENCES navigations(id),
  request_id      TEXT NOT NULL,
  ts_request      INTEGER NOT NULL,
  ts_response     INTEGER,
  ts_finished     INTEGER,
  method          TEXT NOT NULL,
  url             TEXT NOT NULL,
  resource_type   TEXT,
  status          INTEGER,
  status_text     TEXT,
  protocol        TEXT,
  remote_ip       TEXT,
  from_disk_cache INTEGER DEFAULT 0,
  from_svc_worker INTEGER DEFAULT 0,
  size_request    INTEGER,
  size_response   INTEGER,
  error_text      TEXT,
  req_headers     TEXT,
  res_headers     TEXT,
  req_body_blob   TEXT,
  req_body_text   TEXT,
  res_body_blob   TEXT,
  res_body_text   TEXT,
  initiator       TEXT
);
CREATE INDEX IF NOT EXISTS nr_page_ts ON network_requests(page_id, ts_request DESC);
CREATE INDEX IF NOT EXISTS nr_url ON network_requests(url);
CREATE INDEX IF NOT EXISTS nr_status ON network_requests(status);
CREATE INDEX IF NOT EXISTS nr_request_id ON network_requests(request_id);
CREATE INDEX IF NOT EXISTS nr_nav ON network_requests(nav_id);

CREATE TABLE IF NOT EXISTS exceptions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id   TEXT NOT NULL REFERENCES pages(id),
  nav_id    INTEGER REFERENCES navigations(id),
  ts        INTEGER NOT NULL,
  text      TEXT NOT NULL,
  url       TEXT,
  line      INTEGER,
  col       INTEGER,
  stack     TEXT
);
CREATE INDEX IF NOT EXISTS ex_page_ts ON exceptions(page_id, ts DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id      TEXT NOT NULL REFERENCES pages(id),
  ts           INTEGER NOT NULL,
  url          TEXT NOT NULL,
  loader_id    TEXT,
  tree_blob    TEXT NOT NULL,
  uid_count    INTEGER NOT NULL,
  parent_id    INTEGER REFERENCES snapshots(id)
);
CREATE INDEX IF NOT EXISTS snap_page_ts ON snapshots(page_id, ts DESC);

CREATE TABLE IF NOT EXISTS evaluations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id     TEXT NOT NULL REFERENCES pages(id),
  ts          INTEGER NOT NULL,
  expression  TEXT NOT NULL,
  result      TEXT,
  is_error    INTEGER DEFAULT 0,
  duration_ms INTEGER
);
