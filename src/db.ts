import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EventRow,
  EventType,
  PostingRow,
  PostingUpsert,
  SourceKind,
  SourceRow,
} from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // The poller and the bot hold this file open at the same time — the poller
  // writes rows and queues events, the bot reads the queue and stamps
  // deliveries. WAL lets those overlap; busy_timeout absorbs the moment they
  // collide instead of throwing SQLITE_BUSY at whichever process loses.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // Postings and events hang off sources by FK; without this pragma SQLite
  // ignores the ON DELETE CASCADE and removing a source orphans its rows.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(join(here, "schema.sql"), "utf8"));
  migrate(db);
  return db;
}

/**
 * Additive columns, for databases created before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` silently does nothing on an existing table, so a
 * new column in schema.sql never reaches a database that already has the table.
 * Every such column needs a line here or the field is simply missing at runtime.
 */
function migrate(db: DatabaseSync): void {
  const cols = new Set(
    (
      db.prepare("PRAGMA table_info(sources)").all() as unknown as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  if (!cols.has("filter_hash")) {
    db.exec("ALTER TABLE sources ADD COLUMN filter_hash TEXT");
  }
}

/* -------------------------------------------------------------- sources --- */

export function addSource(
  db: DatabaseSync,
  kind: SourceKind,
  ident: string,
  label: string,
): SourceRow {
  db.prepare(
    "INSERT OR IGNORE INTO sources (kind, ident, label) VALUES (?, ?, ?)",
  ).run(kind, ident, label);
  return getSource(db, kind, ident)!;
}

export function getSource(
  db: DatabaseSync,
  kind: SourceKind,
  ident: string,
): SourceRow | undefined {
  return db
    .prepare("SELECT * FROM sources WHERE kind = ? AND ident = ?")
    .get(kind, ident) as SourceRow | undefined;
}

export function listSources(db: DatabaseSync): SourceRow[] {
  return db
    .prepare("SELECT * FROM sources ORDER BY label, kind, ident")
    .all() as unknown as SourceRow[];
}

/**
 * Resolve a posting's board. Rendering any posting needs its source, so this is
 * on the hot path for every embed the bot builds — worth an indexed lookup
 * rather than scanning `listSources` per row.
 */
export function getSourceById(
  db: DatabaseSync,
  sourceId: number,
): SourceRow | undefined {
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(sourceId) as
    | SourceRow
    | undefined;
}

export function removeSource(
  db: DatabaseSync,
  kind: SourceKind,
  ident: string,
): boolean {
  const r = db
    .prepare("DELETE FROM sources WHERE kind = ? AND ident = ?")
    .run(kind, ident);
  return r.changes > 0;
}

export function setSourceLabel(
  db: DatabaseSync,
  sourceId: number,
  label: string,
): void {
  db.prepare("UPDATE sources SET label = ? WHERE id = ?").run(label, sourceId);
}

/**
 * Hash of the filter spec in force the last time this source was polled, or
 * NULL for a source that has never been filtered.
 *
 * Read separately rather than off `SourceRow` because it is consumed at exactly
 * one point in one cycle -- the re-baseline check in the poller -- and a stale
 * copy carried around on a row object is precisely the thing that would make
 * that check wrong.
 */
export function getFilterHash(
  db: DatabaseSync,
  sourceId: number,
): string | null {
  const row = db
    .prepare("SELECT filter_hash FROM sources WHERE id = ?")
    .get(sourceId) as { filter_hash: string | null } | undefined;
  return row?.filter_hash ?? null;
}

/** Written only after a cycle has finished acting on the new spec. */
export function setFilterHash(
  db: DatabaseSync,
  sourceId: number,
  hash: string,
): void {
  db.prepare("UPDATE sources SET filter_hash = ? WHERE id = ?").run(
    hash,
    sourceId,
  );
}

/**
 * A poll that came back with a usable snapshot. `last_poll` is diagnostic, not
 * a cursor — there is nothing to resume from on a snapshot source. Resetting
 * fail_count here is what un-mutes a board that recovered on its own.
 */
export function markPolled(
  db: DatabaseSync,
  sourceId: number,
  etag: string | null,
): void {
  db.prepare(
    `UPDATE sources
        SET etag = COALESCE(?, etag),
            last_poll = datetime('now'),
            fail_count = 0
      WHERE id = ?`,
  ).run(etag, sourceId);
}

/** Returns the new consecutive-failure count so the caller can mute at maxFailures. */
export function markPollFailed(db: DatabaseSync, sourceId: number): number {
  db.prepare("UPDATE sources SET fail_count = fail_count + 1 WHERE id = ?").run(
    sourceId,
  );
  const row = db
    .prepare("SELECT fail_count FROM sources WHERE id = ?")
    .get(sourceId) as { fail_count: number } | undefined;
  return row?.fail_count ?? 0;
}

/* ------------------------------------------------------------- postings --- */

export function getPosting(
  db: DatabaseSync,
  postingId: number,
): PostingRow | undefined {
  return db.prepare("SELECT * FROM postings WHERE id = ?").get(postingId) as
    | PostingRow
    | undefined;
}

export function listOpenPostings(
  db: DatabaseSync,
  sourceId?: number,
): PostingRow[] {
  const sql = sourceId
    ? "SELECT * FROM postings WHERE state = 'open' AND source_id = ? ORDER BY posted_at DESC, id DESC"
    : "SELECT * FROM postings WHERE state = 'open' ORDER BY posted_at DESC, id DESC";
  const stmt = db.prepare(sql);
  return (sourceId ? stmt.all(sourceId) : stmt.all()) as unknown as PostingRow[];
}

/**
 * Every posting ever seen on a source, closed ones included. The diff needs the
 * dead keys: a key coming back from 'closed' is a repost, and without the
 * closed rows in hand it would read as a brand new opening instead.
 */
export function listPostingsForSource(
  db: DatabaseSync,
  sourceId: number,
): PostingRow[] {
  return db
    .prepare("SELECT * FROM postings WHERE source_id = ? ORDER BY id")
    .all(sourceId) as unknown as PostingRow[];
}

/**
 * Write what the board just told us, and nothing else.
 *
 * Everything the board owns is refreshed; everything we own — the claim, the
 * fit score, the Discord message id, the notify guards — is untouched, because
 * a poll runs every few minutes and any of those clobbered once is gone.
 *
 * Two subtleties live in the ON CONFLICT clause:
 *
 *  - `description` is only overwritten when the incoming value is non-null. A
 *    delisted posting can never be refetched, so a JD we captured once is the
 *    only copy that will ever exist; a later cycle where the board omits the
 *    body must not erase it.
 *  - `repost_count` is incremented from the *stored* state. SQLite evaluates
 *    every SET expression against the pre-update row, so reading `state` here
 *    still sees 'closed' even though another clause is setting it to 'open' —
 *    but the ordering is load-bearing enough to say out loud, because the
 *    obvious imperative reading of this statement never fires the increment.
 *
 * Returns the posting's id.
 */
export function upsertPosting(db: DatabaseSync, row: PostingUpsert): number {
  db.prepare(
    `INSERT INTO postings
       (source_id, key, external_id, title, company, location, remote,
        department, url, posted_at, posted_at_exact, closes_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_id, key) DO UPDATE SET
       external_id  = excluded.external_id,
       title        = excluded.title,
       location     = excluded.location,
       remote       = excluded.remote,
       department   = excluded.department,
       url          = excluded.url,
       closes_at    = excluded.closes_at,
       description  = COALESCE(excluded.description, description),
       last_seen    = datetime('now'),
       -- Only a genuine repost re-dates the posting. A company that reopens a
       -- search has created a new opening in the world, and applying to it now
       -- really is early -- so a reposted role must be able to satisfy the
       -- freshness gate, or the repost and high-fit alerts could never coincide.
       -- An ordinary refresh leaves the date alone, and a board that restates
       -- the original publish date on a repost simply won't look fresh, which
       -- makes this self-correcting rather than a source of false alarms.
       posted_at    = CASE WHEN state = 'closed' THEN excluded.posted_at ELSE posted_at END,
       posted_at_exact = CASE WHEN state = 'closed' THEN excluded.posted_at_exact ELSE posted_at_exact END,
       repost_count = repost_count + (CASE WHEN state = 'closed' THEN 1 ELSE 0 END),
       state        = 'open',
       closed_at    = NULL,
       -- A posting that came back gets a fresh life: the sweeps are allowed to
       -- speak about it again.
       stale_notified_at = NULL,
       deadline_notified_at = NULL`,
  ).run(
    row.source_id,
    row.key,
    row.external_id,
    row.title,
    row.company,
    row.location,
    row.remote,
    row.department,
    row.url,
    row.posted_at,
    row.posted_at_exact,
    row.closes_at,
    row.description,
  );

  const r = db
    .prepare("SELECT id FROM postings WHERE source_id = ? AND key = ?")
    .get(row.source_id, row.key) as { id: number };
  return r.id;
}

/** Still on the board and unchanged: prove it is alive, say nothing. */
export function touchPosting(db: DatabaseSync, postingId: number): void {
  db.prepare(
    "UPDATE postings SET last_seen = datetime('now') WHERE id = ?",
  ).run(postingId);
}

/** The board stopped listing it. That absence is the whole close event. */
export function closePosting(db: DatabaseSync, postingId: number): void {
  db.prepare(
    `UPDATE postings SET state = 'closed', closed_at = datetime('now')
      WHERE id = ? AND state = 'open'`,
  ).run(postingId);
}

/** Scored once per key and reused across reposts — each score is an LLM call. */
export function setFit(
  db: DatabaseSync,
  postingId: number,
  score: number,
  reason: string,
): void {
  db.prepare(
    `UPDATE postings SET fit_score = ?, fit_reason = ?, fit_scored_at = datetime('now')
      WHERE id = ?`,
  ).run(score, reason, postingId);
}

export function setMessageId(
  db: DatabaseSync,
  postingId: number,
  messageId: string | null,
): void {
  db.prepare("UPDATE postings SET message_id = ? WHERE id = ?").run(
    messageId,
    postingId,
  );
}

/** `who = null` releases the claim, and clears the timestamp with it. */
export function claimPosting(
  db: DatabaseSync,
  postingId: number,
  who: string | null,
): void {
  db.prepare(
    `UPDATE postings
        SET claimed_by = ?,
            claimed_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END
      WHERE id = ?`,
  ).run(who, who, postingId);
}

/** `applied = false` undoes a misclick; the claim survives either way. */
export function setApplied(
  db: DatabaseSync,
  postingId: number,
  applied = true,
): void {
  db.prepare(
    `UPDATE postings SET applied_at = ${applied ? "datetime('now')" : "NULL"} WHERE id = ?`,
  ).run(postingId);
}

export function markStaleNotified(db: DatabaseSync, postingId: number): void {
  db.prepare(
    "UPDATE postings SET stale_notified_at = datetime('now') WHERE id = ?",
  ).run(postingId);
}

export function markDeadlineNotified(db: DatabaseSync, postingId: number): void {
  db.prepare(
    "UPDATE postings SET deadline_notified_at = datetime('now') WHERE id = ?",
  ).run(postingId);
}

/**
 * The scorer's work queue. Descriptionless rows are skipped because there is
 * nothing to score them from; the limit is the per-cycle spend cap.
 */
export function listUnscoredPostings(
  db: DatabaseSync,
  limit = 25,
): PostingRow[] {
  return db
    .prepare(
      `SELECT * FROM postings
        WHERE state = 'open' AND fit_score IS NULL AND description IS NOT NULL
        ORDER BY posted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as PostingRow[];
}

/* --------------------------------------------------------------- events --- */

export function queueEvent(
  db: DatabaseSync,
  sourceId: number,
  postingId: number,
  type: EventType,
  payload: Record<string, unknown> = {},
): void {
  db.prepare(
    "INSERT INTO events (source_id, posting_id, type, payload_json) VALUES (?, ?, ?, ?)",
  ).run(sourceId, postingId, type, JSON.stringify(payload));
}

export function pendingEvents(db: DatabaseSync, limit = 100): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE delivered_at IS NULL ORDER BY id LIMIT ?")
    .all(limit) as unknown as EventRow[];
}

/** Stamped only after Discord confirms — see the note on events.delivered_at. */
export function markDelivered(db: DatabaseSync, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    "UPDATE events SET delivered_at = datetime('now') WHERE id = ?",
  );
  for (const id of ids) stmt.run(id);
}
