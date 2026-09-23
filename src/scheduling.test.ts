import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  addSource,
  getDomainCooldown,
  getSource,
  listUnscoredPostings,
  openDb,
  upsertPosting,
} from "./db.ts";
import { pollSource, runCycle } from "./poller.ts";
import { HttpError } from "./http.ts";
import type { Config } from "./config.ts";
import type { Adapter, FetchResult } from "./sources/index.ts";
import type { FetchedPosting, SourceRow } from "./types.ts";

/*
 * Scheduling is where a fleet of sources stops being a list of independent
 * fetches: a block on one host has to pause every query on that host, a failing
 * source has to stop being retried in a tight loop, and the scoring queue has
 * to let old work finish instead of drowning under new arrivals. These tests
 * drive that machinery without a network and without the live database.
 */

function freshDb(t: { after(fn: () => void): void }): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "eve-sched-"));
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
    alertMaxAgeHours: Number.POSITIVE_INFINITY,
    staleDays: 7,
    deadlineDays: 3,
    maxFailures: 5,
    massDelistRatio: 0.5,
    filtersPath: null,
    browserUseDir: null,
    browserUsePython: "python3",
    browserTimeoutMin: 10,
    dashboardPort: 8787,
    dashboardBind: "127.0.0.1",
    statsTimezone: "Europe/Berlin",
    ...over,
  };
}

function source(db: DatabaseSync, ident: string): SourceRow {
  return addSource(db, "greenhouse", ident, ident);
}

function reload(db: DatabaseSync, s: SourceRow): SourceRow {
  return getSource(db, s.kind, s.ident)!;
}

function board(n: number): FetchedPosting[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `10${i}`,
    title: `Backend Engineer Level ${i}`,
    company: "Acme GmbH",
    location: "Berlin, Germany",
    remote: false,
    department: null,
    url: `https://boards.example/acme/10${i}`,
    postedAt: "2026-09-01T09:00:00Z",
    closesAt: null,
    description: "Backend work.",
  }));
}

function adapter(
  fetch: Adapter["fetch"],
  over: Partial<Adapter> = {},
): Adapter {
  return {
    kind: "greenhouse",
    parse: () => null,
    fetch,
    ...over,
  };
}

const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/* --------------------------------------------------------- domain gate --- */

test("a 429 pauses the whole domain: the next source on it is skipped without a request", async (t) => {
  const db = freshDb(t);
  const first = source(db, "first");
  const second = source(db, "second");
  const other = source(db, "other");

  let secondCalls = 0;
  const throttled = adapter(async () => {
    throw new HttpError("https://throttled.test/jobs -> HTTP 429", "blocked", {
      status: 429,
      retryAfterMs: 60_000,
    });
  }, { domain: () => "throttled.test" });
  const sibling = adapter(async () => {
    secondCalls++;
    return { postings: board(1), etag: null };
  }, { domain: () => "throttled.test" });
  const healthy = adapter(async () => ({ postings: board(1), etag: null }), {
    domain: () => "healthy.test",
  });

  await assert.rejects(() => pollSource(db, cfg(), first, throttled), /429/);

  const cooldown = getDomainCooldown(db, "throttled.test");
  assert.ok(cooldown, "the block is recorded against the host");
  assert.ok(cooldown!.nextAttemptAt > nowSql(), "and it is in the future");

  const siblingReport = await pollSource(db, cfg(), reload(db, second), sibling);
  assert.equal(siblingReport.skipped, true);
  assert.match(siblingReport.error ?? "", /domain cooldown/);
  assert.equal(secondCalls, 0, "no request is made while the domain is cooling down");

  const otherReport = await pollSource(db, cfg(), reload(db, other), healthy);
  assert.equal(otherReport.skipped, false, "other domains keep polling");
  assert.equal(otherReport.opened, 1);
});

test("a 403 without Retry-After still pauses the domain for a bounded default", async (t) => {
  const db = freshDb(t);
  const s = source(db, "walled");
  const walled = adapter(async () => {
    throw new HttpError("https://walled.test/jobs -> HTTP 403", "blocked", { status: 403 });
  }, { domain: () => "walled.test" });

  await assert.rejects(() => pollSource(db, cfg(), s, walled), /403/);
  const cooldown = getDomainCooldown(db, "walled.test");
  assert.ok(cooldown, "a bare 403 still records a cooldown");
  assert.ok(cooldown!.nextAttemptAt > nowSql());
});

test("a plain-error 429 from an older adapter still pauses the domain", async (t) => {
  const db = freshDb(t);
  const first = source(db, "legacy-first");
  const second = source(db, "legacy-second");

  // LinkedIn/Indeed/StepStone/XING throw plain Errors with the status in the
  // message; the cooldown must not depend on HttpError to recognise a block.
  let secondCalls = 0;
  const legacy = adapter(async () => {
    throw new Error("https://www.example.test/jobs -> HTTP 429: rate-limited or blocked, backing off");
  }, { domain: () => "legacy.test" });
  const sibling = adapter(async () => {
    secondCalls++;
    return { postings: board(1), etag: null };
  }, { domain: () => "legacy.test" });

  await assert.rejects(() => pollSource(db, cfg(), first, legacy), /429/);
  assert.ok(getDomainCooldown(db, "legacy.test"), "the plain-error 429 is recorded");

  const report = await pollSource(db, cfg(), reload(db, second), sibling);
  assert.equal(report.skipped, true);
  assert.match(report.error ?? "", /domain cooldown/);
  assert.equal(secondCalls, 0);
});

/* ------------------------------------------------------------- backoff --- */

test("a failed source backs off instead of being retried every cycle", async (t) => {
  const db = freshDb(t);
  const s = source(db, "flaky");

  let calls = 0;
  const failing = adapter(async () => {
    calls++;
    throw new Error("board is on fire");
  });

  const firstCycle = await runCycle(db, cfg(), () => failing);
  assert.equal(firstCycle[0]!.error !== null, true);
  assert.equal(calls, 1);
  assert.equal(reload(db, s).fail_count, 1);
  assert.ok(reload(db, s).next_attempt_at, "a backoff is persisted");
  assert.ok(reload(db, s).next_attempt_at! > nowSql());

  const secondCycle = await runCycle(db, cfg(), () => failing);
  assert.equal(calls, 1, "the source is not contacted again while backing off");
  assert.match(secondCycle[0]!.error ?? "", /backoff/);

  // Once the backoff has elapsed, the source is tried again — and a success
  // clears both the backoff and the failure count.
  db.prepare("UPDATE sources SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(s.id);
  const thirdCycle = await runCycle(db, cfg(), () =>
    adapter(async () => ({ postings: board(2), etag: null })),
  );
  assert.equal(thirdCycle[0]!.skipped, false);
  assert.equal(reload(db, s).fail_count, 0);
  assert.equal(reload(db, s).next_attempt_at, null);
});

test("a refused mass-delist cycle defers briefly instead of retrying every cycle", async (t) => {
  const db = freshDb(t);
  const s = source(db, "shrinking");
  const full = board(6);
  await pollSource(db, cfg(), s, adapter(async () => ({ postings: full, etag: null })));

  // 2 of 6 survive: refused by the guard, but the host is clearly reachable, so
  // the deferral must be the short first backoff step, not a long mute.
  const report = await pollSource(
    db,
    cfg(),
    reload(db, s),
    adapter(async () => ({ postings: full.slice(0, 2), etag: null })),
  );
  assert.equal(report.skipped, true);
  const next = reload(db, s).next_attempt_at;
  assert.ok(next, "a refusal defers the next attempt");
  const waitMs = Date.parse(`${next!.replace(" ", "T")}Z`) - Date.now();
  assert.ok(waitMs <= 5 * 60_000 + 5_000, `first backoff step is one cycle, got ${waitMs}ms`);
});

test("a muted source is probed again after its backoff and recovers on success", async (t) => {
  const db = freshDb(t);
  const s = source(db, "flapping");

  // Five consecutive failures: muted, with the capped 6h backoff persisted.
  let calls = 0;
  const failing = adapter(async () => {
    calls++;
    throw new Error("board is on fire");
  });
  for (let i = 0; i < 5; i++) {
    db.prepare("UPDATE sources SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(s.id);
    await runCycle(db, cfg(), () => failing);
  }
  const muted = reload(db, s);
  assert.equal(muted.fail_count, 5);
  assert.ok(muted.next_attempt_at, "the muted source keeps a probe schedule");

  // While the backoff is in the future, it is skipped.
  const skipped = await pollSource(db, cfg(), muted, failing);
  assert.equal(skipped.skipped, true);
  assert.match(skipped.error ?? "", /muted after 5/);
  const callsAfterMute = calls;

  // Once the backoff expires it is probed again — and a success clears the mute.
  db.prepare("UPDATE sources SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(s.id);
  const recovered = await pollSource(
    db,
    cfg(),
    reload(db, s),
    adapter(async () => ({ postings: board(2), etag: null })),
  );
  assert.equal(recovered.skipped, false, "a muted source must be able to come back on its own");
  assert.equal(recovered.opened, 2);
  assert.equal(calls, callsAfterMute, "the probe used the recovered adapter, not the failing one");
  assert.equal(reload(db, s).fail_count, 0);
  assert.equal(reload(db, s).next_attempt_at, null);
});

/* ---------------------------------------------------------- fair queue --- */

function postingRow(
  db: DatabaseSync,
  sourceId: number,
  key: string,
  postedAt: string,
): number {
  return upsertPosting(db, {
    source_id: sourceId,
    key,
    external_id: key,
    title: `Backend Engineer ${key}`,
    company: "Acme GmbH",
    location: "Berlin, Germany",
    remote: 0,
    department: null,
    url: `https://boards.example/${key}`,
    posted_at: postedAt,
    posted_at_exact: 1,
    closes_at: null,
    description: "Build backend systems with Python.",
  });
}

test("the scoring queue keeps room for old and retried work under a flood of new arrivals", (t) => {
  const db = freshDb(t);
  const s = source(db, "queue");

  const freshIds: number[] = [];
  for (let i = 0; i < 20; i++) {
    const id = postingRow(db, s.id, `fresh-${i}`, `2026-09-${String(20 - (i % 10)).padStart(2, "0")}T09:00:00Z`);
    freshIds.push(id);
  }
  const oldIds = [
    postingRow(db, s.id, "old-1", "2026-08-01T09:00:00Z"),
    postingRow(db, s.id, "old-2", "2026-08-02T09:00:00Z"),
  ];
  const retryId = postingRow(db, s.id, "retry-1", "2026-08-03T09:00:00Z");
  const notDueId = postingRow(db, s.id, "not-due", "2026-08-04T09:00:00Z");

  // The old rows really are older than the fresh ones, whatever the insert
  // order was: `first_seen` is what the oldest bucket orders on.
  db.prepare("UPDATE postings SET first_seen = datetime('now', '-30 days') WHERE key LIKE 'old-%'").run();
  db.prepare("UPDATE postings SET first_seen = datetime('now', '-20 days'), fit_retry_after = datetime('now', '-1 hour') WHERE key = 'retry-1'").run();
  db.prepare("UPDATE postings SET first_seen = datetime('now', '-20 days'), fit_retry_after = datetime('now', '+6 hours') WHERE key = 'not-due'").run();

  const batch = listUnscoredPostings(db, 10, "v1");
  const ids = batch.map((p) => p.id);

  assert.equal(batch.length, 10, "the budget is honoured");
  assert.equal(new Set(ids).size, 10, "no row is handed out twice");
  assert.ok(ids.includes(retryId), "a due retry gets its slice");
  assert.ok(oldIds.some((id) => ids.includes(id)), "the oldest waiting work makes progress");
  assert.ok(!ids.includes(notDueId), "a retry still in its wait is not eligible");
  assert.ok(freshIds.some((id) => ids.includes(id)), "fresh work is still the bulk");
});

test("the scoring queue never returns more than the budget, even with one eligible row", (t) => {
  const db = freshDb(t);
  const s = source(db, "tiny");
  postingRow(db, s.id, "only", "2026-09-01T09:00:00Z");
  assert.equal(listUnscoredPostings(db, 1, "v1").length, 1);
  assert.equal(listUnscoredPostings(db, 5, "v1").length, 1);
});
