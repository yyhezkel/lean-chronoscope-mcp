-- M5.4: FTS5 indexes for console + network.
--
-- "External content" FTS keeps the index in sync via triggers on the base
-- tables, so we don't have to remember to write the FTS row at every
-- insert/update site. The base tables are the canonical store; FTS is just
-- a search index that can be rebuilt at any time.
--
-- Network bodies arrive in a second UPDATE after the initial INSERT, so we
-- include UPDATE triggers too. We index req_body_text + res_body_text only
-- (not blob-spilled bodies; those are >10KB and rare in search workflows).

CREATE VIRTUAL TABLE IF NOT EXISTS console_fts USING fts5(
  text,
  content='console_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS console_ai AFTER INSERT ON console_messages BEGIN
  INSERT INTO console_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS console_ad AFTER DELETE ON console_messages BEGIN
  INSERT INTO console_fts(console_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS console_au AFTER UPDATE ON console_messages BEGIN
  INSERT INTO console_fts(console_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO console_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS network_fts USING fts5(
  url,
  req_body,
  res_body,
  content='network_requests',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS network_ai AFTER INSERT ON network_requests BEGIN
  INSERT INTO network_fts(rowid, url, req_body, res_body)
  VALUES (new.id, new.url, COALESCE(new.req_body_text, ''), COALESCE(new.res_body_text, ''));
END;
CREATE TRIGGER IF NOT EXISTS network_ad AFTER DELETE ON network_requests BEGIN
  INSERT INTO network_fts(network_fts, rowid, url, req_body, res_body)
  VALUES ('delete', old.id, old.url, COALESCE(old.req_body_text, ''), COALESCE(old.res_body_text, ''));
END;
CREATE TRIGGER IF NOT EXISTS network_au AFTER UPDATE ON network_requests BEGIN
  INSERT INTO network_fts(network_fts, rowid, url, req_body, res_body)
  VALUES ('delete', old.id, old.url, COALESCE(old.req_body_text, ''), COALESCE(old.res_body_text, ''));
  INSERT INTO network_fts(rowid, url, req_body, res_body)
  VALUES (new.id, new.url, COALESCE(new.req_body_text, ''), COALESCE(new.res_body_text, ''));
END;
