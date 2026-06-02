-- M2.5: per-session resource revision counters.
--
-- The Broadcaster (src/daemon/live/broadcaster.ts) keeps in-memory revision
-- counters per `browser://...` URI. This table is the survivable mirror so
-- counters can be restored after a daemon restart — wired in M4 alongside
-- the global session registry / session resume flow.
--
-- Writes are best-effort and happen on the broadcaster's debounced flush
-- (200ms window), so contention is low. The table is per-session because
-- URIs we care about (page.console, page.network, page.exceptions,
-- page.snapshot, page.url, session.pages, session.intercept) are all
-- session-scoped. Global URIs (`browser://sessions`, `browser://docs/tools`)
-- intentionally don't persist a revision — they're cheap to roll on restart.

CREATE TABLE resource_revisions (
  uri      TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL
);

CREATE INDEX ix_resource_revisions_last_ts ON resource_revisions(last_ts);
