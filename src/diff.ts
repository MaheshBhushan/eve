import { postingKey } from "./key.ts";
import type { FetchedPosting, PostingRow } from "./types.ts";

/**
 * Set-difference over a board snapshot.
 *
 * issue-radar diffs a *delta* feed: GitHub is asked "what changed since T",
 * answers with exactly those issues, and silence means nothing happened. Every
 * event is carried by something arriving.
 *
 * A job board answers a different question. It serves the full list of what is
 * open right now — no cursor, no timeline, no "this req was closed" record.
 * Nothing ever arrives to say a posting ended; it simply stops being in the
 * list. So the most valuable event this system produces is carried by an
 * *absence*, and the comparison has to be set difference against everything we
 * have stored, not field comparison against what we were handed.
 *
 * That inverts the safety story. On a delta feed a truncated response costs us
 * a missed update. Here a truncated response — a board erroring out on page
 * three, an adapter silently returning [] — is indistinguishable from the
 * entire company closing every req it has, and acting on it would mass-close
 * live postings and destroy the claims and alerts that are the point of the
 * product. Snapshot completeness is therefore safety-critical: the caller must
 * satisfy itself that a snapshot is whole (see `massDelistRatio`) before doing
 * anything with `vanished`. This function will faithfully report a catastrophe
 * it has no way to distinguish from a truth.
 */

export type Diff =
  | { kind: "new" }
  | { kind: "reposted"; gapDays: number; previousExternalId: string }
  | { kind: "updated"; fields: string[] }
  | { kind: "closed" };

export interface SnapshotDiff {
  present: Array<{
    fetched: FetchedPosting;
    key: string;
    diffs: Diff[];
    stored?: PostingRow;
  }>;
  vanished: PostingRow[];
}

/**
 * SQLite's `datetime('now')` renders "YYYY-MM-DD HH:MM:SS" with no zone marker,
 * and `new Date()` reads an unmarked string like that as *local* time — so a
 * naive parse skews every stored timestamp by the machine's UTC offset, which
 * is exactly enough to make a gap or a freshness window wrong. Anything already
 * carrying a zone (the ISO dates boards emit) is left to the normal parser.
 */
export function parseUtc(s: string): number {
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s);
  return Date.parse(bare ? `${s.replace(" ", "T")}Z` : s);
}

const DAY_MS = 86_400_000;

export function diffSnapshot(
  stored: PostingRow[],
  snapshot: FetchedPosting[],
): SnapshotDiff {
  const byKey = new Map(stored.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const present: SnapshotDiff["present"] = [];

  for (const fetched of snapshot) {
    const key = postingKey(fetched);

    // Two live listings collapsing to one key — the same req filed under two
    // departments, say. They share one row, so if both were written they would
    // overwrite each other every cycle and emit an `updated` event forever.
    // First one wins; the rest are not news.
    if (seen.has(key)) continue;
    seen.add(key);

    const row = byKey.get(key);
    if (!row) {
      present.push({ fetched, key, diffs: [{ kind: "new" }] });
    } else if (row.state === "closed") {
      present.push({
        fetched,
        key,
        stored: row,
        diffs: [
          {
            kind: "reposted",
            gapDays: gapDays(row.closed_at),
            previousExternalId: row.external_id,
          },
        ],
      });
    } else {
      const fields = changedFields(row, fetched);
      present.push({
        fetched,
        key,
        stored: row,
        diffs: fields.length ? [{ kind: "updated", fields }] : [],
      });
    }
  }

  const vanished = stored.filter((r) => r.state === "open" && !seen.has(r.key));
  return { present, vanished };
}

/**
 * Only the fields a human would notice. Boards rewrite description HTML and
 * bump their own timestamps on almost every cycle; treating that as change
 * would turn the feed into noise and bury the events that matter.
 */
function changedFields(stored: PostingRow, fetched: FetchedPosting): string[] {
  const fields: string[] = [];
  if (stored.title !== fetched.title) fields.push("title");
  if ((stored.location ?? null) !== (fetched.location ?? null)) {
    fields.push("location");
  }
  if (stored.url !== fetched.url) fields.push("url");
  if ((stored.closes_at ?? null) !== (fetched.closesAt ?? null)) {
    fields.push("closes_at");
  }
  return fields;
}

function gapDays(closedAt: string | null): number {
  if (!closedAt) return 0;
  const t = parseUtc(closedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / DAY_MS));
}
