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
  --   | remotive | weworkremotely | remoteok | workingnomads | himalayas | arbeitnow
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
  -- Earliest time the poller may retry after a failure. Persisted separately
  -- from last_poll because many query sources share one throttled domain: a
  -- per-source timestamp alone lets twelve LinkedIn searches each discover the
  -- same 429 in the same cycle.
  next_attempt_at TEXT,
  -- Opaque resumable state for paginated discovery feeds. Written by the
  -- adapter, never interpreted by the poller; NULL means "start over".
  cursor   TEXT,
  -- Consecutive failed polls. At `maxFailures` the source is marked muted and
  -- probed only on the capped backoff (up to 6h) instead of every cycle --
  -- companies do delete their job boards, but a temporary outage must not
  -- become a permanent mute that only a human can undo.
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

-- Domain-level backoff, shared by every source whose adapter reports that
-- domain. A 429 is a property of the host, not of the query that happened to
-- receive it: pausing only that one source just moves the problem to the next
-- query ten seconds later. Until `next_attempt_at` passes, the poller skips
-- every source on this host without a request; other domains keep polling.
CREATE TABLE IF NOT EXISTS domain_state (
  domain          TEXT PRIMARY KEY,
  next_attempt_at TEXT NOT NULL,
  reason          TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Jev usage telemetry. Additive: these tables record what was asked of the
-- model and what came back; they never change matching behaviour, and the
-- existing postings.fit_* columns remain the current-result snapshot.
--
-- Three units, deliberately separate (see the optimization handoff):
--   evaluation  = one requested assessment of one posting (logical)
--   attempt     = one HTTP invocation of the TypeSafe transport (physical)
--   cache entry = one validated answer set reusable for identical input
-- A timeout is not a rejection, a cache hit is not a fresh call, and NULL
-- usage means unknown, never zero.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jev_evaluations (
  id                   TEXT PRIMARY KEY,
  -- SET NULL, not CASCADE: usage history must survive /unwatch and cleanup.
  posting_id           INTEGER REFERENCES postings(id) ON DELETE SET NULL,
  posting_key          TEXT NOT NULL,
  source_kind          TEXT NOT NULL,
  -- Hash of the adapter ident (search queries are not stored verbatim).
  source_ident_hash    TEXT,
  origin               TEXT NOT NULL,   -- poller | manual_fit
  requested_at_ms      INTEGER NOT NULL,
  completed_at_ms      INTEGER,
  input_hash           TEXT,
  profile_hash         TEXT NOT NULL,
  inference_version    TEXT NOT NULL,
  policy_version       TEXT NOT NULL,
  requested_model      TEXT NOT NULL,
  result_model         TEXT,
  -- pending | model_result | cache_hit | local_exclusion |
  -- evidence_deferred | budget_deferred | error | interrupted
  status               TEXT NOT NULL,
  -- match | rejected | review_needed
  outcome              TEXT,
  reason_codes_json    TEXT NOT NULL DEFAULT '[]',
  fit_score            REAL,
  confidence           REAL,
  eligible             INTEGER,
  fit_threshold        REAL NOT NULL,
  confidence_threshold REAL NOT NULL,
  cache_entry_hash     TEXT,
  error_kind           TEXT
);
CREATE INDEX IF NOT EXISTS jev_eval_requested_idx ON jev_evaluations (requested_at_ms);
CREATE INDEX IF NOT EXISTS jev_eval_input_idx     ON jev_evaluations (input_hash);

CREATE TABLE IF NOT EXISTS jev_attempts (
  id                    TEXT PRIMARY KEY,
  evaluation_id         TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL,
  input_hash            TEXT NOT NULL,
  started_at_ms         INTEGER NOT NULL,
  finished_at_ms        INTEGER,
  duration_ms           INTEGER,
  -- reserved | started | finished | unknown
  state                 TEXT NOT NULL,
  http_status           INTEGER,
  -- success | http_error | timeout | transport_error | invalid_response
  outcome               TEXT,
  error_code            TEXT,
  retry_after_ms        INTEGER,
  provider_request_id   TEXT,
  requested_model       TEXT NOT NULL,
  returned_model        TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  -- reported | missing | invalid
  usage_status          TEXT NOT NULL,
  request_bytes         INTEGER NOT NULL,
  profile_chars         INTEGER NOT NULL,
  description_chars     INTEGER NOT NULL,
  questions_chars       INTEGER NOT NULL,
  rate_version          TEXT,
  estimated_cost_microunits INTEGER,
  UNIQUE (evaluation_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS jev_attempt_started_idx ON jev_attempts (started_at_ms);
CREATE INDEX IF NOT EXISTS jev_attempt_eval_idx    ON jev_attempts (evaluation_id);

-- One-row key/value store for boundaries that must never reset on restart or
-- upgrade: when tracking began, and the telemetry schema revision.
CREATE TABLE IF NOT EXISTS jev_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
