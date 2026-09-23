import { classifyRole, ROLE_FILTER_VERSION } from "./roles.ts";
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

export function openDb(path: string, busyTimeoutMs = 5000): DatabaseSync {
  const db = new DatabaseSync(path);
  // The poller and the bot hold this file open at the same time — the poller
  // writes rows and queues events, the bot reads the queue and stamps
  // deliveries. WAL lets those overlap; busy_timeout absorbs the moment they
  // collide instead of throwing SQLITE_BUSY at whichever process loses.
  // busy_timeout first: switching journal mode takes a lock of its own, and
  // three processes opening this file within the same second (a timer-fired
  // poll plus a bot and dashboard restart) hit that lock without it.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  db.exec("PRAGMA journal_mode = WAL");
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
  if (!cols.has("next_attempt_at")) {
    db.exec("ALTER TABLE sources ADD COLUMN next_attempt_at TEXT");
  }
  if (!cols.has("cursor")) {
    db.exec("ALTER TABLE sources ADD COLUMN cursor TEXT");
  }

  const postingCols = new Set(db.prepare("PRAGMA table_info(postings)").all().map(c => c.name));
  for (const [name, type] of Object.entries({roleFamily: 'TEXT', rolePriority: 'INTEGER', matchedSignals: 'TEXT', secondaryRoleFamilies: 'TEXT', roleVersion: 'INTEGER', fit_confidence: 'REAL', fit_eligible: 'INTEGER', fit_version: 'TEXT', fit_details: 'TEXT', fit_retry_after: 'TEXT', fit_notified_at: 'TEXT'})) {
    if (!postingCols.has(name)) db.exec(`ALTER TABLE postings ADD COLUMN ${name} ${type}`);
  }
  const stale = db.prepare("SELECT id, title, description FROM postings WHERE roleVersion IS NULL OR roleVersion != ?").all(ROLE_FILTER_VERSION);
  if (stale.length === 0) return; // Opening an up-to-date database needs no writer lock.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of stale) updateRole(db, Number(row.id), String(row.title), row.description as string | null);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function updateRole(db: DatabaseSync, id: number, title: string, description: string | null): void {
  const role = classifyRole(title, description);
  db.prepare('UPDATE postings SET roleFamily = ?, rolePriority = ?, matchedSignals = ?, secondaryRoleFamilies = ?, roleVersion = ? WHERE id = ?')
    .run(role?.roleFamily ?? null, role?.rolePriority ?? null, JSON.stringify(role?.matchedSignals ?? []), JSON.stringify(role?.secondaryRoleFamilies ?? []), ROLE_FILTER_VERSION, id);
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
 *
 * `cursor` is tri-state: `undefined` leaves the stored value alone (a 304, or
 * an adapter that does not paginate), `null` clears it (a finished walk), and a
 * string persists the adapter's opaque state.
 */
export function markPolled(
  db: DatabaseSync,
  sourceId: number,
  etag: string | null,
  cursor: string | null | undefined = undefined,
): void {
  db.prepare(
    `UPDATE sources
        SET etag = COALESCE(?, etag),
            last_poll = datetime('now'),
            next_attempt_at = NULL,
            cursor = CASE WHEN ? = 1 THEN ? ELSE cursor END,
            fail_count = 0
      WHERE id = ?`,
  ).run(etag, cursor === undefined ? 0 : 1, cursor ?? null, sourceId);
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

/**
 * Push a source's next attempt out to `until` (SQLite `datetime('now')`
 * format). `markPollFailed` counts failures; this is what actually stops the
 * poller from contacting a source it just failed on, without touching the
 * diagnostic `last_poll`.
 */
export function deferSource(db: DatabaseSync, sourceId: number, until: string): void {
  db.prepare("UPDATE sources SET next_attempt_at = ? WHERE id = ?").run(until, sourceId);
}

/* -------------------------------------------------------- domain gate --- */

/**
 * A blocked host stays blocked for a while, and that is a fact about the host
 * rather than about any one query URL. Persisted so a restart mid-cooldown
 * does not walk straight back into the 429.
 */
export function getDomainCooldown(
  db: DatabaseSync,
  domain: string,
): { nextAttemptAt: string; reason: string | null } | null {
  const row = db
    .prepare("SELECT next_attempt_at, reason FROM domain_state WHERE domain = ?")
    .get(domain) as { next_attempt_at: string; reason: string | null } | undefined;
  return row ? { nextAttemptAt: row.next_attempt_at, reason: row.reason } : null;
}

export function setDomainCooldown(
  db: DatabaseSync,
  domain: string,
  until: string,
  reason: string | null,
): void {
  db.prepare(
    `INSERT INTO domain_state (domain, next_attempt_at, reason, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (domain) DO UPDATE SET
       next_attempt_at = excluded.next_attempt_at,
       reason = excluded.reason,
       updated_at = datetime('now')`,
  ).run(domain, until, reason);
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
    ? "SELECT * FROM postings WHERE state = 'open' AND (roleFamily IS NOT NULL OR fit_eligible = 1) AND source_id = ? ORDER BY posted_at DESC, id DESC"
    : "SELECT * FROM postings WHERE state = 'open' AND (roleFamily IS NOT NULL OR fit_eligible = 1) ORDER BY posted_at DESC, id DESC";
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
       fit_version = CASE WHEN title IS NOT excluded.title OR location IS NOT excluded.location
         OR remote IS NOT excluded.remote OR description IS NOT COALESCE(excluded.description, description)
         THEN NULL ELSE fit_version END,
       fit_retry_after = CASE WHEN description IS NOT COALESCE(excluded.description, description) THEN NULL ELSE fit_retry_after END,
       description  = COALESCE(excluded.description, description),
       last_seen    = datetime('now'),
       -- Only a genuine repost re-dates the posting. A company that reopens a
       -- search has created a new opening in the world, and applying to it now
       -- really is early -- so a reposted role must be able to satisfy the
       -- freshness gate, or the repost and high-fit alerts could never coincide.
       -- An ordinary refresh leaves the date alone, and a board that restates
       -- the original publish date on a repost simply won't look fresh, which
       -- makes this self-correcting rather than a source of false alarms.
       -- One more case: a stored guess (our first sighting, exact = 0) yields
       -- to a stated date the board has since given us. A guess never
       -- overwrites a fact, and a fact never overwrites another fact.
       posted_at    = CASE
                        WHEN state = 'closed' THEN excluded.posted_at
                        WHEN posted_at_exact = 0 AND excluded.posted_at_exact = 1 THEN excluded.posted_at
                        ELSE posted_at END,
       posted_at_exact = CASE
                        WHEN state = 'closed' THEN excluded.posted_at_exact
                        WHEN posted_at_exact = 0 AND excluded.posted_at_exact = 1 THEN 1
                        ELSE posted_at_exact END,
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
  const stored = db.prepare('SELECT title, description FROM postings WHERE id = ?').get(r.id)!;
  updateRole(db, r.id, stored.title as string, stored.description as string | null);
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
    `UPDATE postings SET fit_score = ?, fit_reason = ?, fit_scored_at = datetime('now'), fit_confidence = NULL, fit_eligible = NULL, fit_version = NULL
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
 *
 * The profile (Jev) branch splits the budget three ways instead of taking the
 * newest rows. Newest-first is the right *default* — a fresh posting is the one
 * worth applying to — but under continuous arrivals it is also a starvation
 * schedule: every cycle brings newer rows, the oldest unscored rows are always
 * at the back, and a job can sit unscored forever while the budget is spent
 * ahead of it. The split (roughly 70% fresh / 20% oldest / 10% due retries) is
 * a proposed policy, not a proven optimum; its job is to guarantee the tail
 * makes progress while keeping the fresh bias.
 */
export function listUnscoredPostings(
  db: DatabaseSync,
  limit = 25,
  version?: string,
): PostingRow[] {
  if (version) return fairQueue(db, limit, version);
  return db
    .prepare(
      `SELECT * FROM postings
        WHERE state = 'open' AND roleFamily IS NOT NULL AND fit_score IS NULL AND description IS NOT NULL
        ORDER BY rolePriority ASC, posted_at DESC, id DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as PostingRow[];
}

/** Work is eligible while its version is stale and it is not in a retry wait. */
const ELIGIBLE_SQL = `state = 'open'
  AND (fit_version IS NULL OR fit_version != ?)
  AND (fit_retry_after IS NULL OR fit_retry_after <= datetime('now'))`;

/**
 * Queue depth and the age of the oldest eligible row. Logged every cycle so a
 * growing tail is visible in the journal rather than only discoverable by
 * querying SQLite. A budget that cannot keep up shows up here long before
 * anyone notices a stale match.
 */
export function scoringQueueStats(
  db: DatabaseSync,
  version?: string,
): { pending: number; oldest: string | null } {
  const row = version
    ? (db
        .prepare(`SELECT COUNT(*) AS pending, MIN(first_seen) AS oldest FROM postings WHERE ${ELIGIBLE_SQL}`)
        .get(version) as { pending: number; oldest: string | null } | undefined)
    : (db
        .prepare(
          `SELECT COUNT(*) AS pending, MIN(first_seen) AS oldest FROM postings
            WHERE state = 'open' AND roleFamily IS NOT NULL AND fit_score IS NULL AND description IS NOT NULL`,
        )
        .get() as { pending: number; oldest: string | null } | undefined);
  return { pending: Number(row?.pending ?? 0), oldest: row?.oldest ?? null };
}

function fairQueue(db: DatabaseSync, limit: number, version: string): PostingRow[] {
  const picked = new Map<number, PostingRow>();
  const add = (rows: PostingRow[]): void => {
    for (const row of rows) if (!picked.has(row.id)) picked.set(row.id, row);
  };

  // Reserve at least one slot per bucket so a budget of 1..9 still rotates
  // rather than collapsing back to newest-only.
  const retrySlots = Math.max(1, Math.round(limit * 0.1));
  const oldestSlots = Math.max(1, Math.round(limit * 0.2));
  const freshSlots = Math.max(1, limit - retrySlots - oldestSlots);

  // Fresh first: when the budget runs out mid-batch, the rows already committed
  // are the ones most likely to matter.
  add(
    db
      .prepare(`SELECT * FROM postings WHERE ${ELIGIBLE_SQL} ORDER BY posted_at DESC, id DESC LIMIT ?`)
      .all(version, freshSlots) as unknown as PostingRow[],
  );
  add(
    db
      .prepare(
        `SELECT * FROM postings WHERE ${ELIGIBLE_SQL} AND fit_retry_after IS NULL
          ORDER BY first_seen ASC, id ASC LIMIT ?`,
      )
      .all(version, oldestSlots) as unknown as PostingRow[],
  );
  add(
    db
      .prepare(
        `SELECT * FROM postings WHERE ${ELIGIBLE_SQL} AND fit_retry_after IS NOT NULL
          ORDER BY fit_retry_after ASC, id ASC LIMIT ?`,
      )
      .all(version, retrySlots) as unknown as PostingRow[],
  );

  // Deduplication can leave a bucket collision; fill the remainder newest-first.
  if (picked.size < limit) {
    add(
      db
        .prepare(`SELECT * FROM postings WHERE ${ELIGIBLE_SQL} ORDER BY posted_at DESC, id DESC LIMIT ?`)
        .all(version, limit) as unknown as PostingRow[],
    );
  }
  return [...picked.values()].slice(0, limit);
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

/**
 * The delivery queue.
 *
 * `roleFamily IS NOT NULL` is the cheap classifier's noise gate: postings that
 * match none of the five role families are stored and shown on the dashboard,
 * but their routine openings do not reach Discord. That gate must not swallow
 * the events that are not routine:
 *
 *   - `high_fit` is Jev's verdict on a posting that may well have a title the
 *     classifier did not recognise, and a model-judged match is exactly what
 *     the user asked to be told about;
 *   - `vanished_while_claimed` and `stale` only exist for postings the user
 *     claimed, so they are personal regardless of classification.
 *
 * `includeUnclassified` (matches-only mode) lifts the gate entirely, because
 * the drain deletes everything it does not send.
 */
export function pendingEvents(db: DatabaseSync, limit = 100, includeUnclassified = false): EventRow[] {
  if (includeUnclassified) {
    return db
      .prepare("SELECT * FROM events WHERE delivered_at IS NULL ORDER BY id LIMIT ?")
      .all(limit) as unknown as EventRow[];
  }
  return db
    .prepare(
      `SELECT * FROM events
        WHERE delivered_at IS NULL
          AND (type IN ('high_fit', 'vanished_while_claimed', 'stale')
               OR posting_id IN (SELECT id FROM postings WHERE roleFamily IS NOT NULL))
        ORDER BY id LIMIT ?`,
    )
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

export function setJevFit(db: DatabaseSync, id: number, fit: import("./jev.ts").JevResult, version: string): void {
  db.prepare(`UPDATE postings SET fit_score=?, fit_reason=?, fit_confidence=?, fit_eligible=?, fit_details=?,
    fit_version=?, fit_retry_after=NULL, fit_scored_at=datetime('now') WHERE id=?`)
    .run(fit.score, fit.reason, fit.confidence, Number(fit.eligible), fit.details, version, id);
}
export function deferFit(db: DatabaseSync, id: number, hours = 6): void {
  db.prepare("UPDATE postings SET fit_retry_after=datetime('now', ?) WHERE id=?").run(`+${hours} hours`, id);
}
