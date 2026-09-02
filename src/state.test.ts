import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  addSource,
  claimPosting,
  closePosting,
  getPosting,
  listPostingsForSource,
  listOpenPostings,
  markPollFailed,
  markPolled,
  openDb,
  pendingEvents,
  removeSource,
  setApplied,
  setFit,
  setMessageId,
  upsertPosting,
} from "./db.ts";
import { diffSnapshot } from "./diff.ts";
import {
  classifyOpening,
  emitClosure,
  emitDiffEvents,
  emitHighFit,
  sweepDeadlines,
  sweepStale,
} from "./events.ts";
import { postingKey } from "./key.ts";
import type { EventType, FetchedPosting, PostingRow } from "./types.ts";

/* ------------------------------------------------------------- fixtures --- */

function freshDb(t: { after(fn: () => void): void }): {
  db: DatabaseSync;
  sourceId: number;
} {
  const dir = mkdtempSync(join(tmpdir(), "eve-test-"));
  const db = openDb(join(dir, "radar.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const src = addSource(db, "greenhouse", "acme", "Acme");
  return { db, sourceId: src.id };
}

function posting(over: Partial<FetchedPosting> = {}): FetchedPosting {
  return {
    externalId: "1001",
    title: "Backend Engineer",
    company: "Acme GmbH",
    location: "Berlin, Germany",
    remote: false,
    department: "Engineering",
    url: "https://boards.example/acme/1001",
    postedAt: null,
    closesAt: null,
    description: "Write servers.",
    ...over,
  };
}

/** What the poller does with one snapshot, minus the network and the guards. */
function poll(
  db: DatabaseSync,
  sourceId: number,
  snapshot: FetchedPosting[],
  opts: { exact?: boolean } = {},
): void {
  const stored = listPostingsForSource(db, sourceId);
  const { present, vanished } = diffSnapshot(stored, snapshot);

  for (const p of present) {
    const id = upsertPosting(db, {
      source_id: sourceId,
      key: p.key,
      external_id: p.fetched.externalId,
      title: p.fetched.title,
      company: p.fetched.company,
      location: p.fetched.location,
      remote: p.fetched.remote === null ? null : p.fetched.remote ? 1 : 0,
      department: p.fetched.department,
      url: p.fetched.url,
      posted_at: p.fetched.postedAt ?? nowSql(),
      posted_at_exact: opts.exact === false ? 0 : p.fetched.postedAt ? 1 : 0,
      closes_at: p.fetched.closesAt,
      description: p.fetched.description,
    });
    emitDiffEvents(db, sourceId, id, p.diffs);
  }

  for (const row of vanished) {
    closePosting(db, row.id);
    emitClosure(db, sourceId, row);
  }
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function sqlOffset(db: DatabaseSync, modifier: string): string {
  return (
    db.prepare("SELECT datetime('now', ?) AS t").get(modifier) as { t: string }
  ).t;
}

function types(db: DatabaseSync): EventType[] {
  return pendingEvents(db).map((e) => e.type as EventType);
}

function only(db: DatabaseSync, sourceId: number): PostingRow {
  const rows = listPostingsForSource(db, sourceId);
  assert.equal(rows.length, 1, "expected exactly one posting row");
  return rows[0]!;
}

/* ------------------------------------------------------------ diff core --- */

test("a posting seen for the first time is reported as new", (t) => {
  const { db, sourceId } = freshDb(t);
  const { present, vanished } = diffSnapshot([], [posting()]);
  assert.equal(present.length, 1);
  assert.deepEqual(present[0]!.diffs, [{ kind: "new" }]);
  assert.equal(vanished.length, 0);

  poll(db, sourceId, [posting()]);
  assert.deepEqual(types(db), ["posting_opened"]);
});

test("a posting that has not changed emits nothing on the next poll", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const before = pendingEvents(db).length;

  poll(db, sourceId, [posting({ description: "Write servers. (reworded)" })]);
  assert.equal(pendingEvents(db).length, before);
});

test("a change to a field a human cares about is reported as an update", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  poll(db, sourceId, [posting({ url: "https://boards.example/acme/moved" })]);

  const evs = pendingEvents(db);
  assert.deepEqual(evs.map((e) => e.type), ["posting_opened", "posting_opened"]);
  assert.deepEqual(JSON.parse(evs[1]!.payload_json), {
    update: true,
    fields: ["url"],
  });
});

test("a stored posting missing from the snapshot lands in vanished", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);

  const { present, vanished } = diffSnapshot(
    listPostingsForSource(db, sourceId),
    [],
  );
  assert.equal(present.length, 0);
  assert.equal(vanished.length, 1);

  poll(db, sourceId, []);
  assert.equal(only(db, sourceId).state, "closed");
});

test("the same key appearing twice in one snapshot yields one posting", (t) => {
  const { db, sourceId } = freshDb(t);
  const dupe = posting({ externalId: "2002", department: "Platform" });
  poll(db, sourceId, [posting(), dupe]);

  assert.equal(listPostingsForSource(db, sourceId).length, 1);
  assert.deepEqual(types(db), ["posting_opened"]);
  // The duplicate must not keep re-writing the row every cycle.
  poll(db, sourceId, [posting(), dupe]);
  assert.deepEqual(types(db), ["posting_opened"]);
});

test("a closed key coming back is a repost, not a new posting", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  poll(db, sourceId, []);
  // A repost genuinely does arrive under a new ATS id; the key must survive it.
  poll(db, sourceId, [posting({ externalId: "9009" })]);

  const row = only(db, sourceId);
  assert.equal(row.state, "open");
  assert.equal(row.closed_at, null);
  assert.equal(row.repost_count, 1);
  assert.equal(row.external_id, "9009");

  const evs = pendingEvents(db);
  assert.deepEqual(
    evs.map((e) => e.type),
    ["posting_opened", "posting_closed", "posting_reposted"],
  );
  assert.equal(JSON.parse(evs[2]!.payload_json).previousExternalId, "1001");
});

test("the repost gap is measured in UTC and not skewed by the local offset", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const row = only(db, sourceId);
  db.prepare(
    "UPDATE postings SET state = 'closed', closed_at = datetime('now', '-10 days') WHERE id = ?",
  ).run(row.id);

  const { present } = diffSnapshot(listPostingsForSource(db, sourceId), [
    posting(),
  ]);
  const d = present[0]!.diffs[0]!;
  assert.equal(d.kind, "reposted");
  assert.equal(d.kind === "reposted" && d.gapDays, 10);
});

/* -------------------------------------------------------- poll fidelity --- */

test("a poll never clobbers the claim, the fit score or the message id", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;

  claimPosting(db, id, "mahesh");
  setFit(db, id, 88, "strong match");
  setMessageId(db, id, "msg-1");
  setApplied(db, id);

  poll(db, sourceId, [posting({ title: "Backend Engineer II" })]);

  const row = getPosting(db, id)!;
  assert.equal(row.claimed_by, "mahesh");
  assert.ok(row.claimed_at);
  assert.equal(row.fit_score, 88);
  assert.equal(row.fit_reason, "strong match");
  assert.ok(row.fit_scored_at);
  assert.equal(row.message_id, "msg-1");
  assert.ok(row.applied_at);
});

test("a board returning no description does not erase the one we captured", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting({ description: "The only copy." })]);
  poll(db, sourceId, [posting({ description: null })]);

  assert.equal(only(db, sourceId).description, "The only copy.");
});

test("deleting a source cascades its postings away", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  assert.equal(listOpenPostings(db).length, 1);

  assert.equal(removeSource(db, "greenhouse", "acme"), true);
  assert.equal(listOpenPostings(db).length, 0);
});

test("a failing poll counts up and a good one resets the counter", (t) => {
  const { db, sourceId } = freshDb(t);
  assert.equal(markPollFailed(db, sourceId), 1);
  assert.equal(markPollFailed(db, sourceId), 2);
  markPolled(db, sourceId, "etag-1");

  const src = db
    .prepare("SELECT * FROM sources WHERE id = ?")
    .get(sourceId) as { fail_count: number; etag: string; last_poll: string };
  assert.equal(src.fail_count, 0);
  assert.equal(src.etag, "etag-1");
  assert.ok(src.last_poll);
});

/* -------------------------------------------------------------- closure --- */

test("a posting that vanishes while claimed and unapplied raises the race warning", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  claimPosting(db, only(db, sourceId).id, "mahesh");

  poll(db, sourceId, []);
  assert.deepEqual(types(db), ["posting_opened", "vanished_while_claimed"]);
});

test("a posting that vanishes after it was applied to closes quietly", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;
  claimPosting(db, id, "mahesh");
  setApplied(db, id);

  poll(db, sourceId, []);
  assert.deepEqual(types(db), ["posting_opened", "posting_closed"]);
});

test("a posting that vanishes unclaimed closes quietly", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  poll(db, sourceId, []);
  assert.deepEqual(types(db), ["posting_opened", "posting_closed"]);
});

/* ------------------------------------------------------------- high fit --- */

function highFitRow(db: DatabaseSync, sourceId: number, over: Partial<PostingRow>) {
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;
  for (const [k, v] of Object.entries(over)) {
    db.prepare(`UPDATE postings SET ${k} = ? WHERE id = ?`).run(
      v as string | number | null,
      id,
    );
  }
  return getPosting(db, id)!;
}

test("a fresh posting scoring above the threshold pings", (t) => {
  const { db, sourceId } = freshDb(t);
  const row = highFitRow(db, sourceId, {
    posted_at: sqlOffset(db, "-2 hours"),
    posted_at_exact: 1,
  });
  assert.equal(emitHighFit(db, sourceId, row, 90, 75, 48), true);
  assert.ok(types(db).includes("high_fit"));
});

test("a high score on a posting older than the freshness window does not ping", (t) => {
  const { db, sourceId } = freshDb(t);
  const row = highFitRow(db, sourceId, {
    posted_at: sqlOffset(db, "-9 days"),
    posted_at_exact: 1,
  });
  assert.equal(emitHighFit(db, sourceId, row, 99, 75, 48), false);
  assert.equal(types(db).includes("high_fit"), false);
});

test("a fresh posting scoring below the threshold does not ping", (t) => {
  const { db, sourceId } = freshDb(t);
  const row = highFitRow(db, sourceId, {
    posted_at: sqlOffset(db, "-1 hours"),
    posted_at_exact: 1,
  });
  assert.equal(emitHighFit(db, sourceId, row, 40, 75, 48), false);
  assert.equal(types(db).includes("high_fit"), false);
});

test("a posting whose publish date we guessed never pings however high and fresh", (t) => {
  const { db, sourceId } = freshDb(t);
  // The day-one case: a board that states no dates, so first_seen stands in and
  // every posting on it looks minutes old, back catalogue included.
  const row = highFitRow(db, sourceId, {
    posted_at: sqlOffset(db, "-1 minutes"),
    posted_at_exact: 0,
  });
  assert.equal(emitHighFit(db, sourceId, row, 100, 75, 48), false);
  assert.equal(types(db).includes("high_fit"), false);
});

/* --------------------------------------------------------------- sweeps --- */

test("a claim left unapplied past the stale window is nudged exactly once", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;
  claimPosting(db, id, "mahesh");
  db.prepare(
    "UPDATE postings SET claimed_at = datetime('now', '-30 days') WHERE id = ?",
  ).run(id);

  assert.equal(sweepStale(db, 7), 1);
  assert.equal(sweepStale(db, 7), 0);
  assert.equal(types(db).filter((x) => x === "stale").length, 1);
});

test("a claim that was already applied to is never nudged", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;
  claimPosting(db, id, "mahesh");
  setApplied(db, id);
  db.prepare(
    "UPDATE postings SET claimed_at = datetime('now', '-30 days') WHERE id = ?",
  ).run(id);

  assert.equal(sweepStale(db, 7), 0);
});

test("an approaching deadline fires once", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting({ closesAt: null })]);
  db.prepare(
    "UPDATE postings SET closes_at = datetime('now', '+2 days') WHERE id = ?",
  ).run(only(db, sourceId).id);

  assert.equal(sweepDeadlines(db, 3), 1);
  assert.equal(sweepDeadlines(db, 3), 0);
  assert.equal(types(db).filter((x) => x === "deadline").length, 1);
});

test("a deadline that has already passed never fires", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  db.prepare(
    "UPDATE postings SET closes_at = datetime('now', '-1 days') WHERE id = ?",
  ).run(only(db, sourceId).id);

  assert.equal(sweepDeadlines(db, 3), 0);
});

test("a repost clears the notify guards so the sweeps can speak again", (t) => {
  const { db, sourceId } = freshDb(t);
  poll(db, sourceId, [posting()]);
  const id = only(db, sourceId).id;
  claimPosting(db, id, "mahesh");
  db.prepare(
    `UPDATE postings SET claimed_at = datetime('now', '-30 days') WHERE id = ?`,
  ).run(id);
  sweepStale(db, 7);
  assert.ok(getPosting(db, id)!.stale_notified_at);

  poll(db, sourceId, []);
  poll(db, sourceId, [posting({ externalId: "9009" })]);

  const row = getPosting(db, id)!;
  assert.equal(row.stale_notified_at, null);
  assert.equal(row.deadline_notified_at, null);
  assert.equal(sweepStale(db, 7), 1);
});

/* ------------------------------------------------------------------ key --- */

test("cosmetic churn in a title does not fork one posting into two", (t) => {
  assert.equal(
    postingKey(posting()),
    postingKey(posting({ title: "Backend Engineer (m/w/d)", externalId: "77" })),
  );
});

/* ------------------------------------------------------- opening policy --- */

const POLICY = { freshPingHours: 3, alertMaxAgeHours: 24 };
const H = 3_600_000;
const T0 = Date.parse("2026-09-02T18:00:00Z");

test("a stated publish time within the ping window is fresh", () => {
  const c = classifyOpening({ postedAt: new Date(T0 - 2 * H).toISOString(), exact: 1 }, POLICY, T0);
  assert.equal(c.kind, "fresh");
  assert.equal(Math.round(c.ageHours!), 2);
});

test("a stated publish time inside the feed window is quiet", () => {
  assert.equal(
    classifyOpening({ postedAt: new Date(T0 - 12 * H).toISOString(), exact: 1 }, POLICY, T0).kind,
    "quiet",
  );
});

test("a stated publish time past the feed window is silent", () => {
  assert.equal(
    classifyOpening({ postedAt: new Date(T0 - 5 * 24 * H).toISOString(), exact: 1 }, POLICY, T0).kind,
    "silent",
  );
});

test("a guessed publish time is never fresh and never silenced", () => {
  // first_seen is *now* on a seed poll; without this rule a fresh /watch would
  // ping the whole back catalogue.
  const c = classifyOpening({ postedAt: new Date(T0 - 1 * H).toISOString(), exact: 0 }, POLICY, T0);
  assert.equal(c.kind, "quiet");
  assert.equal(c.ageHours, null);
});

test("bare SQLite timestamps are read as UTC when classifying", () => {
  const c = classifyOpening({ postedAt: "2026-09-02 17:30:00", exact: 1 }, POLICY, T0);
  assert.equal(c.kind, "fresh");
});

test("a stored guess yields to a stated date on a later poll, but a fact never does", (t) => {
  const { db, sourceId } = freshDb(t);
  // First sighting: the board said nothing, so posted_at is our clock.
  poll(db, sourceId, [posting({ postedAt: null })]);
  const guessed = only(db, sourceId);
  assert.equal(guessed.posted_at_exact, 0);

  // The board now states a time (e.g. the adapter learned to read it).
  poll(db, sourceId, [posting({ postedAt: "2026-08-30T08:00:00Z" })]);
  const upgraded = only(db, sourceId);
  assert.equal(upgraded.posted_at_exact, 1);
  assert.equal(upgraded.posted_at, "2026-08-30T08:00:00Z");

  // A different stated time on a still-open posting does not overwrite the first.
  poll(db, sourceId, [posting({ postedAt: "2026-08-31T08:00:00Z" })]);
  assert.equal(only(db, sourceId).posted_at, "2026-08-30T08:00:00Z");
});
