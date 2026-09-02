-- eve schema. Single Discord channel (configured), so no per-source channel column.
-- Both the poller and the bot open this file; WAL is set at connection time in db.ts.
--
-- The shape differs from issue-radar in one structural way: job boards serve a
-- full snapshot of what is currently open, never a delta. There is no cursor to
-- advance and no "closed" notification -- a posting's disappearance from the
-- snapshot IS the close event. So `last_seen` carries the weight `last_sync`
-- carried there, and it lives per-posting rather than per-source.

CREATE TABLE IF NOT EXISTS sources (
  id       INTEGER PRIMARY KEY,
  -- greenhouse | lever | ashby | personio | smartrecruiters | workday | successfactors | arbeitsagentur
  --   | stepstone | indeed | xing | linkedin | browser
  kind     TEXT NOT NULL,
  -- Board token / company slug / encoded search query. Meaning is adapter-local.
  ident    TEXT NOT NULL,
  -- Human name for embeds ("Stripe", "StepStone: ML Engineer, Berlin").
  label    TEXT NOT NULL,
  -- ETag from the last fetch, replayed as If-None-Match where the board honours it.
  etag     TEXT,
  -- Wall-clock of the last successful fetch. Diagnostic only, never a cursor:
  -- a snapshot source has nothing to resume from.
  last_poll TEXT,
  -- Consecutive failed polls. A board that 404s forever gets muted, not retried
  -- into the ground -- companies do delete their job boards.
  fail_count INTEGER NOT NULL DEFAULT 0,
  -- Hash of the filter spec in force when this source was last polled.
  --
  -- Filters are applied to the snapshot before the diff, so a posting that stops
  -- matching is simply absent -- and absence is how this system infers closure.
  -- That means widening or narrowing a filter would otherwise read as a mass
  -- delisting or a flood of new postings. When the hash changes, the poller runs
  -- one re-baseline cycle: rows are refreshed, nothing is closed, and the new
  -- hash is stored. NULL means "never filtered", which re-baselines on first use.
  filter_hash TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, ident)
);

CREATE TABLE IF NOT EXISTS postings (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  -- Synthesised dedupe key: hash(company | normalised title | normalised location).
  -- NOT the ATS id. A reposted role comes back with a fresh ATS id, and treating
  -- that as a new posting is the loudest possible source of false alerts -- it
  -- would make every repost look like a brand new opening.
  key         TEXT    NOT NULL,
  -- The board's own id, kept for the URL and for spotting a genuine relist.
  external_id TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  company     TEXT    NOT NULL,
  location    TEXT,
  remote      INTEGER,
  department  TEXT,
  url         TEXT    NOT NULL,
  -- Board-stated publish time. Many boards omit it; then first_seen stands in,
  -- and `posted_at_exact` records which of the two this is, because the
  -- freshness alert is only trustworthy when the board actually told us.
  posted_at   TEXT    NOT NULL,
  posted_at_exact INTEGER NOT NULL DEFAULT 0,
  -- Stated application deadline, when the board publishes one.
  closes_at   TEXT,
  first_seen  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Bumped every cycle the posting is still in the snapshot.
  last_seen   TEXT    NOT NULL DEFAULT (datetime('now')),
  state       TEXT    NOT NULL DEFAULT 'open',   -- open | closed
  closed_at   TEXT,
  -- Times this key has come back from the dead. >0 means the company has
  -- re-run this search at least once.
  repost_count INTEGER NOT NULL DEFAULT 0,
  -- Full JD text, stored because the fit scorer needs it and refetching a
  -- delisted posting is impossible -- once it's gone, it's gone.
  description TEXT,
  -- 0-100 from the local scorer, NULL until scored. Scoring costs an LLM call,
  -- so it is done once per key and reused across reposts.
  fit_score   INTEGER,
  fit_reason  TEXT,
  fit_scored_at TEXT,
  -- Discord message holding this posting's embed. Later events edit it in place.
  message_id  TEXT,
  -- Ours, not the board's. A poll must never clobber these.
  claimed_by  TEXT,
  claimed_at  TEXT,
  applied_at  TEXT,
  stale_notified_at TEXT,
  deadline_notified_at TEXT,
  UNIQUE (source_id, key)
);

CREATE INDEX IF NOT EXISTS postings_open_idx ON postings (source_id, state, last_seen);
CREATE INDEX IF NOT EXISTS postings_key_idx  ON postings (key);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  posting_id   INTEGER NOT NULL,
  type         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL means pending. Stamped only after Discord confirms, so a crash
  -- re-delivers rather than silently dropping. This column is the entire
  -- crash-safety story.
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS events_pending_idx ON events (delivered_at, id);
