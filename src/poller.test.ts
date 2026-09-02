import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.ts";
import {
  getPosting,
  addSource,
  getSource,
  listOpenPostings,
  listPostingsForSource,
  markPollFailed,
  openDb,
  pendingEvents,
} from "./db.ts";
import { parseResult } from "./fit.ts";
import { pollSource, runCycle } from "./poller.ts";
import type { Adapter, FetchResult } from "./sources/index.ts";
import type { EventType, FetchedPosting, SourceRow } from "./types.ts";

/*
 * No network and no LLM anywhere in here. Every board is an in-memory Adapter
 * and `profilePath` is null in the test config, which switches the fit scorer
 * off entirely -- these tests must never shell out to the `claude` CLI.
 */

/* ------------------------------------------------------------- fixtures --- */

function freshDb(t: { after(fn: () => void): void }): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "eve-poll-"));
  const db = openDb(join(dir, "radar.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    dbPath: ":memory:",
    discordToken: "x",
    discordChannelId: "x",
    digestThreshold: 5,
    pingTarget: "@here",
    profilePath: null,
    fitModel: "sonnet",
    fitThreshold: 75,
    freshHours: 48,
    fitBudget: 25,
    freshPingHours: 3,
    // The fixture board is dated 2026-07-01. These tests are about snapshot
    // mechanics, not alert policy, so the age gate is opened wide here and
    // exercised on its own below.
    alertMaxAgeHours: Number.POSITIVE_INFINITY,
    staleDays: 7,
    deadlineDays: 3,
    maxFailures: 5,
    massDelistRatio: 0.5,
    // No filter file: these tests exercise the unfiltered path.
    filtersPath: null,
    browserUseDir: null,
    browserUsePython: "python3",
    browserTimeoutMin: 10,
    dashboardPort: 8787,
    dashboardBind: "127.0.0.1",
    ...over,
  };
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
    postedAt: "2026-07-01T09:00:00Z",
    closesAt: null,
    description: "We need a backend engineer.",
    ...over,
  };
}

/** N distinct postings — distinct titles, so they get distinct keys. */
function board(n: number): FetchedPosting[] {
  return Array.from({ length: n }, (_, i) =>
    posting({
      externalId: `10${i}`,
      title: `Engineer Level ${i}`,
      url: `https://boards.example/acme/10${i}`,
    }),
  );
}

/**
 * An adapter whose snapshot the test sets directly. `complete` mirrors the real
 * flag: undefined/true for the ATS adapters, false for the scraped source.
 */
function fakeAdapter(
  snapshot: FetchedPosting[] | null,
  over: Partial<Adapter> = {},
): Adapter {
  return {
    kind: "greenhouse",
    parse: () => null,
    fetch: async (): Promise<FetchResult> => ({
      postings: snapshot,
      etag: "etag-1",
    }),
    ...over,
  };
}

function src(db: DatabaseSync, ident = "acme"): SourceRow {
  return addSource(db, "greenhouse", ident, `Acme ${ident}`);
}

function reload(db: DatabaseSync, s: SourceRow): SourceRow {
  return getSource(db, s.kind, s.ident)!;
}

function eventTypes(db: DatabaseSync): EventType[] {
  return pendingEvents(db, 500).map((e) => e.type);
}

/* ------------------------------------------------------------- presence --- */

test("cold cycle inserts everything as new, identical rerun says nothing", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const snapshot = board(3);

  const first = await pollSource(db, cfg(), s, fakeAdapter(snapshot));
  assert.equal(first.seen, 3);
  assert.equal(first.opened, 3);
  assert.equal(listOpenPostings(db, s.id).length, 3);
  assert.deepEqual(eventTypes(db), [
    "posting_opened",
    "posting_opened",
    "posting_opened",
  ]);

  const before = eventTypes(db).length;
  const second = await pollSource(db, cfg(), reload(db, s), fakeAdapter(snapshot));
  assert.equal(second.opened, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.closed, 0);
  assert.equal(eventTypes(db).length, before, "an unchanged board is not news");
});

test("a new posting is pinged, fed or silenced by its stated age", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const h = 3_600_000;
  const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
  const snapshot = [
    posting({ externalId: "1", title: "Fresh", postedAt: iso(1 * h) }),
    posting({ externalId: "2", title: "Recent", postedAt: iso(10 * h) }),
    posting({ externalId: "3", title: "Stale", postedAt: iso(72 * h) }),
    posting({ externalId: "4", title: "Undated", postedAt: null }),
  ];
  const policy = cfg({ freshPingHours: 3, alertMaxAgeHours: 24 });
  const report = await pollSource(db, policy, s, fakeAdapter(snapshot));

  assert.equal(report.opened, 4, "every posting is stored and counted");
  assert.equal(listOpenPostings(db, s.id).length, 4, "the silent one is still tracked");
  const events = pendingEvents(db, 50);
  const byTitle = new Map(
    events.map((e) => [getPosting(db, e.posting_id)!.title, e.type]),
  );
  assert.equal(byTitle.get("Fresh"), "fresh_opening");
  assert.equal(byTitle.get("Recent"), "posting_opened");
  assert.equal(byTitle.has("Stale"), false, "a week-old drift-in is not news");
  assert.equal(byTitle.get("Undated"), "posting_opened", "unknown age stays in the feed");
});

test("a 304 touches nothing but the poll timestamp", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  await pollSource(db, cfg(), s, fakeAdapter(board(3)));

  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(null));
  assert.equal(report.notModified, true);
  assert.equal(listOpenPostings(db, s.id).length, 3);
});

test("a board with no stated date records posted_at_exact = 0", async (t) => {
  const db = freshDb(t);
  const s = src(db);

  await pollSource(db, cfg(), s, fakeAdapter([posting({ postedAt: null })]));

  const [row] = listPostingsForSource(db, s.id);
  assert.ok(row);
  assert.equal(row.posted_at_exact, 0, "a substituted date must never look stated");
  assert.ok(row.posted_at, "we still store something to sort by");
});

test("a stated date records posted_at_exact = 1", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  await pollSource(db, cfg(), s, fakeAdapter([posting()]));

  const [row] = listPostingsForSource(db, s.id);
  assert.equal(row?.posted_at_exact, 1);
});

/* -------------------------------------------------------------- closure --- */

test("a posting dropping out of the snapshot closes it and emits a closure", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const full = board(6);

  await pollSource(db, cfg(), s, fakeAdapter(full));
  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(full.slice(1)));

  assert.equal(report.closed, 1);
  assert.equal(listOpenPostings(db, s.id).length, 5);
  assert.ok(eventTypes(db).includes("posting_closed"));
});

/* ------------------------------------------------------ mass-delist guard --- */

test("the guard refuses a truncated snapshot: no rows change, no events, fail_count up", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const full = board(6);
  await pollSource(db, cfg(), s, fakeAdapter(full));

  const eventsBefore = eventTypes(db).length;
  const rowsBefore = listPostingsForSource(db, s.id).map((r) => [r.id, r.state, r.last_seen]);

  // Two of six survive: a 67% loss, well past the 50% ratio.
  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(full.slice(0, 2)));

  assert.equal(report.skipped, true);
  assert.match(report.error ?? "", /mass delist/);
  assert.equal(listOpenPostings(db, s.id).length, 6, "nothing may be closed");
  assert.deepEqual(
    listPostingsForSource(db, s.id).map((r) => [r.id, r.state, r.last_seen]),
    rowsBefore,
    "a refused cycle writes no rows at all",
  );
  assert.equal(eventTypes(db).length, eventsBefore, "and queues no events");
  assert.equal(reload(db, s).fail_count, 1);
});

test("an empty snapshot against a non-empty board is refused", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  await pollSource(db, cfg(), s, fakeAdapter(board(2)));

  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter([]));

  assert.equal(report.skipped, true);
  assert.equal(listOpenPostings(db, s.id).length, 2);
  assert.equal(reload(db, s).fail_count, 1);
});

test("an empty snapshot on a board we have never seen is fine", async (t) => {
  const db = freshDb(t);
  const s = src(db);

  const report = await pollSource(db, cfg(), s, fakeAdapter([]));

  assert.equal(report.skipped, false);
  assert.equal(reload(db, s).fail_count, 0);
});

test("a small board is exempt from the ratio", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const full = board(3);
  await pollSource(db, cfg(), s, fakeAdapter(full));

  // 2 of 3 gone is past the ratio, but 3 postings is too few for it to mean
  // anything -- and a tiny board must still be able to close things.
  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(full.slice(0, 1)));

  assert.equal(report.skipped, false);
  assert.equal(report.closed, 2);
});

test("a loss under the ratio is acted on normally", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const full = board(8);
  await pollSource(db, cfg(), s, fakeAdapter(full));

  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(full.slice(0, 5)));

  assert.equal(report.skipped, false);
  assert.equal(report.closed, 3);
});

/* --------------------------------------------------- incomplete sources --- */

test("an incomplete source never closes anything on absence", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  const incomplete = (snap: FetchedPosting[]) =>
    fakeAdapter(snap, { complete: false });
  const full = board(6);

  await pollSource(db, cfg(), s, incomplete(full));
  assert.equal(listOpenPostings(db, s.id).length, 6);

  // Everything but one falls off the ranking. A complete source would call that
  // a mass delisting; an incomplete one must call it page two.
  const report = await pollSource(db, cfg(), reload(db, s), incomplete(full.slice(0, 1)));

  assert.equal(report.skipped, false, "the delist guard is moot here");
  assert.equal(report.closed, 0);
  assert.equal(listOpenPostings(db, s.id).length, 6);
  assert.ok(!eventTypes(db).includes("posting_closed"));
  assert.ok(!eventTypes(db).includes("vanished_while_claimed"));
  assert.equal(reload(db, s).fail_count, 0);
});

test("an incomplete source still reports new postings", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  await pollSource(db, cfg(), s, fakeAdapter(board(2), { complete: false }));
  const report = await pollSource(db, cfg(), reload(db, s), fakeAdapter(board(3), {
    complete: false,
  }));

  assert.equal(report.opened, 1);
});

/* --------------------------------------------------------------- cycle --- */

test("a source at maxFailures is skipped", async (t) => {
  const db = freshDb(t);
  const s = src(db);
  for (let i = 0; i < 5; i++) markPollFailed(db, s.id);

  let fetched = false;
  const adapter = fakeAdapter(board(3), {
    fetch: async () => {
      fetched = true;
      return { postings: board(3), etag: null };
    },
  });
  const report = await pollSource(db, cfg({ maxFailures: 5 }), reload(db, s), adapter);

  assert.equal(report.skipped, true);
  assert.equal(fetched, false, "a muted board is not even contacted");
});

test("one throwing source does not stop the next one polling", async (t) => {
  const db = freshDb(t);
  const bad = src(db, "aaa-bad");
  const good = src(db, "zzz-good");

  const reports = await runCycle(db, cfg(), (s) =>
    s.ident === bad.ident
      ? fakeAdapter(null, {
          fetch: async () => {
            throw new Error("board is on fire");
          },
        })
      : fakeAdapter(board(2)),
  );

  assert.equal(reports.length, 2);
  assert.equal(reload(db, bad).fail_count, 1);
  assert.equal(listOpenPostings(db, good.id).length, 2, "the healthy board still polled");
});

/* ------------------------------------------------------------ parseResult --- */

test("parseResult: clean JSON", () => {
  assert.deepEqual(parseResult('{"score": 82, "reason": "matches Rust requirement"}'), {
    score: 82,
    reason: "matches Rust requirement",
  });
});

test("parseResult: fenced JSON", () => {
  const raw = '```json\n{"score": 41, "reason": "needs 8 years"}\n```';
  assert.deepEqual(parseResult(raw), { score: 41, reason: "needs 8 years" });
});

test("parseResult: JSON embedded in prose", () => {
  const raw =
    'Sure! Here is my assessment:\n{"score": 12, "reason": "no work authorisation"}\nHope that helps.';
  assert.deepEqual(parseResult(raw), { score: 12, reason: "no work authorisation" });
});

test("parseResult: clamps and rounds", () => {
  assert.equal(parseResult('{"score": 140, "reason": "x"}')?.score, 100);
  assert.equal(parseResult('{"score": -20, "reason": "x"}')?.score, 0);
  assert.equal(parseResult('{"score": 74.6, "reason": "x"}')?.score, 75);
});

test("parseResult: braces inside the reason do not truncate the object", () => {
  const raw = '{"score": 50, "reason": "role mentions {tech} stack"}';
  assert.deepEqual(parseResult(raw), { score: 50, reason: "role mentions {tech} stack" });
});

test("parseResult: a missing reason still yields a score", () => {
  assert.deepEqual(parseResult('{"score": 30}'), {
    score: 30,
    reason: "no reason given",
  });
});

test("parseResult: null on anything unusable", () => {
  assert.equal(parseResult(""), null);
  assert.equal(parseResult("I could not score this posting."), null);
  assert.equal(parseResult("{not json at all"), null);
  assert.equal(parseResult('{"score": "high", "reason": "x"}'), null, "strings would coerce to 0");
  assert.equal(parseResult('{"reason": "no score field"}'), null);
  assert.equal(parseResult('{"score": null, "reason": "x"}'), null);
});
