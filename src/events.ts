import type { DatabaseSync } from "node:sqlite";
import {
  markDeadlineNotified,
  markStaleNotified,
  queueEvent,
} from "./db.ts";
import { parseUtc, type Diff } from "./diff.ts";
import type { PostingRow } from "./types.ts";

/**
 * Diffs and clock conditions in, queued events out. Nothing here touches
 * Discord — the poller only ever writes rows, and the bot drains them later, so
 * an outage at the gateway delays alerts instead of losing them.
 *
 * Four of the seven event types are pinged alerts and are the reason the
 * product exists: high_fit, vanished_while_claimed, deadline, stale. The rest
 * is a news feed. Everything below is written to keep the four rare enough to
 * still be worth reacting to.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** What the poller knows about a posting's age when it queues its opening. */
export interface OpeningAge {
  /** ISO publish time as stored. */
  postedAt: string;
  /** 1 when the board stated it, 0 when it is our own first sighting. */
  exact: number;
}

export interface OpeningPolicy {
  freshPingHours: number;
  alertMaxAgeHours: number;
}

/** Bucket a new posting by stated age. Unknown age is never fresh and never stale. */
export function classifyOpening(
  age: OpeningAge,
  policy: OpeningPolicy,
  now = Date.now(),
): { kind: "fresh" | "quiet" | "silent"; ageHours: number | null } {
  if (age.exact !== 1) return { kind: "quiet", ageHours: null };
  const t = parseUtc(age.postedAt);
  if (Number.isNaN(t)) return { kind: "quiet", ageHours: null };
  const ageHours = (now - t) / HOUR_MS;
  if (ageHours <= policy.freshPingHours) return { kind: "fresh", ageHours };
  if (ageHours > policy.alertMaxAgeHours) return { kind: "silent", ageHours };
  return { kind: "quiet", ageHours };
}

/**
 * `age` and `policy` shape what a `new` diff becomes:
 *
 *   - within `freshPingHours`     -> `fresh_opening`, a pinged alert
 *   - within `alertMaxAgeHours`   -> `posting_opened`, the quiet feed
 *   - older than that             -> no event; the row still exists for the
 *                                    dashboard, but Discord hears nothing
 *   - no stated publish time      -> `posting_opened`, as before
 *
 * The silent bucket is what stops ranked search pages from re-announcing
 * their back catalogue every time the visible window shifts. Omit both to get
 * the old behaviour (every new posting is a quiet opening); tests and the
 * `/watch` seed path use that.
 */
export function emitDiffEvents(
  db: DatabaseSync,
  sourceId: number,
  postingId: number,
  diffs: Diff[],
  age?: OpeningAge,
  policy?: OpeningPolicy,
): void {
  for (const d of diffs) {
    switch (d.kind) {
      case "new": {
        const c = age && policy ? classifyOpening(age, policy) : { kind: "quiet" as const, ageHours: null };
        if (c.kind === "silent") break;
        if (c.kind === "fresh") {
          queueEvent(db, sourceId, postingId, "fresh_opening", {
            ageHours: Math.round((c.ageHours ?? 0) * 10) / 10,
          });
          break;
        }
        queueEvent(db, sourceId, postingId, "posting_opened");
        break;
      }
      case "reposted":
        queueEvent(db, sourceId, postingId, "posting_reposted", {
          gapDays: d.gapDays,
          previousExternalId: d.previousExternalId,
        });
        break;
      case "updated":
        // A retitled or relocated posting is the same posting. Delivery folds
        // this into the embed that already exists rather than posting again.
        queueEvent(db, sourceId, postingId, "posting_opened", {
          update: true,
          fields: d.fields,
        });
        break;
      case "closed":
        queueEvent(db, sourceId, postingId, "posting_closed");
        break;
    }
  }
}

/**
 * A posting left the board.
 *
 * Claimed and never applied to is the one case worth waking someone for: you
 * marked this as a job you intended to apply to, and it closed while you still
 * hadn't. Nothing else in the system can tell you that, and by the time you
 * notice on your own the posting is unrecoverable.
 *
 * If you had already applied, the listing disappearing is the expected end of
 * the story. Unclaimed, it was never yours. Both close quietly.
 */
export function emitClosure(
  db: DatabaseSync,
  sourceId: number,
  posting: PostingRow,
): void {
  if (posting.claimed_by && !posting.applied_at) {
    queueEvent(db, sourceId, posting.id, "vanished_while_claimed", {
      claimedBy: posting.claimed_by,
      daysHeld: daysSince(posting.claimed_at),
    });
    return;
  }
  queueEvent(db, sourceId, posting.id, "posting_closed", {
    applied: Boolean(posting.applied_at),
  });
}

/**
 * The freshness ping: a strong match that is still new enough that applying
 * early is worth something.
 *
 * The `posted_at_exact` gate is the non-obvious one and it is not optional.
 * When a board states no publish date we substitute `first_seen`, which is a
 * fact about us and not about the posting. On the very first poll of a newly
 * watched board, `first_seen` is *now* for every posting on it — including the
 * ones that have been open for eight months. Without this gate, adding a source
 * would ping its entire back catalogue as breaking news, and the alert would be
 * worthless from the first day anyone used it. A posting whose age we are only
 * guessing at is tracked and scored like any other; it just never claims to be
 * fresh.
 */
export function emitHighFit(
  db: DatabaseSync,
  sourceId: number,
  posting: PostingRow,
  score: number,
  threshold: number,
  freshHours: number,
): boolean {
  if (score < threshold) return false;
  if (posting.posted_at_exact !== 1) return false;

  const postedAt = parseUtc(posting.posted_at);
  if (Number.isNaN(postedAt)) return false;
  const ageHours = (Date.now() - postedAt) / HOUR_MS;
  if (ageHours > freshHours) return false;

  queueEvent(db, sourceId, posting.id, "high_fit", {
    score,
    threshold,
    ageHours: Math.round(ageHours),
    reason: posting.fit_reason,
  });
  return true;
}

/**
 * Claimed a while ago, still open, still not applied to. Nothing arrives from
 * the board to trigger this — it is a clock condition, so it has to be swept
 * for. `stale_notified_at` holds it to one nudge per life; the upsert clears
 * that guard on a repost, which is the only way a posting gets a second one.
 */
export function sweepStale(db: DatabaseSync, staleDays: number): number {
  const rows = db
    .prepare(
      `SELECT id, source_id FROM postings
        WHERE state = 'open'
          AND claimed_by IS NOT NULL
          AND applied_at IS NULL
          AND claimed_at IS NOT NULL
          AND claimed_at < datetime('now', ?)
          AND stale_notified_at IS NULL`,
    )
    .all(`-${staleDays} days`) as unknown as Array<{
    id: number;
    source_id: number;
  }>;

  for (const r of rows) {
    queueEvent(db, r.source_id, r.id, "stale", { days: staleDays });
    markStaleNotified(db, r.id);
  }
  return rows.length;
}

/**
 * A stated application deadline coming up. `datetime()` normalises both sides
 * because boards emit ISO with a zone while our own columns are bare UTC, and
 * comparing those as text silently gets the ordering wrong.
 *
 * The lower bound matters as much as the upper: a deadline already in the past
 * is not an opportunity, and firing on one would be an alert you can only
 * resent.
 */
export function sweepDeadlines(db: DatabaseSync, deadlineDays: number): number {
  const rows = db
    .prepare(
      `SELECT id, source_id, closes_at FROM postings
        WHERE state = 'open'
          AND applied_at IS NULL
          AND closes_at IS NOT NULL
          AND datetime(closes_at) > datetime('now')
          AND datetime(closes_at) <= datetime('now', ?)
          AND deadline_notified_at IS NULL`,
    )
    .all(`+${deadlineDays} days`) as unknown as Array<{
    id: number;
    source_id: number;
    closes_at: string;
  }>;

  for (const r of rows) {
    queueEvent(db, r.source_id, r.id, "deadline", {
      closesAt: r.closes_at,
      days: deadlineDays,
    });
    markDeadlineNotified(db, r.id);
  }
  return rows.length;
}

function daysSince(ts: string | null): number {
  if (!ts) return 0;
  const t = parseUtc(ts);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / DAY_MS));
}
