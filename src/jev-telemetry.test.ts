import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { addSource, getPosting, openDb, removeSource, upsertPosting } from "./db.ts";
import { evaluatePosting, recoverStaleAttempts, telemetryStartMs, ensureTelemetryStart } from "./jev-service.ts";
import { jobInputHash, type JevContext } from "./jev.ts";
import { jevInventoryExtras, jevStats, jevTelemetry, renderStatsReport, statsWindow, startOfZonedDay } from "./stats.ts";
import type { Config } from "./config.ts";
import type { FilterConfig } from "./filter.ts";
import type { PostingRow, SourceRow } from "./types.ts";

/*
 * Milestone A acceptance: the ledger must reconcile exactly under mocked
 * transport, survive restarts, and never turn an unknown outcome into a
 * fabricated success or a rejection. No test here calls TypeSafe.
 */

const CTX: JevContext = {
  profile: "candidate evidence",
  version: "legacy-version",
  inferenceVersion: "inference-v1",
  policyVersion: "policy-v1",
  profileHash: "profile-hash",
  model: "jev-test",
};

function cfg(over: Partial<Config> = {}): Config {
  return {
    fitProvider: "typesafe", fitConfidence: 0.8, matchesOnly: true, fitConcurrency: 3,
    dbPath: ":memory:", discordToken: "x", discordChannelId: "x", digestThreshold: 5, pingTarget: "@here",
    profilePath: "/tmp/profile.json", fitModel: "jev-test", fitThreshold: 75, freshHours: 48, fitBudget: 100,
    freshPingHours: 3, alertMaxAgeHours: 24, staleDays: 7, deadlineDays: 3, maxFailures: 5, massDelistRatio: 0.5,
    filtersPath: null, browserUseDir: null, browserUsePython: "python3", browserTimeoutMin: 10,
    dashboardPort: 8787, dashboardBind: "127.0.0.1", statsTimezone: "Europe/Berlin",
    ...over,
  };
}

function fixture(t: { after(fn: () => void): void }): {
  db: DatabaseSync; source: SourceRow; posting: PostingRow;
} {
  const dir = mkdtempSync(join(tmpdir(), "eve-jev-"));
  const db = openDb(join(dir, "jev.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = addSource(db, "greenhouse", "acme", "Acme");
  const id = upsertPosting(db, {
    source_id: source.id, key: "k1", external_id: "1", title: "AI Engineer", company: "Acme",
    location: "Berlin, Germany", remote: 0, department: null, url: "https://example.test/1",
    posted_at: "2026-09-22T09:00:00Z", posted_at_exact: 1, closes_at: null,
    description: "Build RAG applications with Python.",
  });
  return { db, source, posting: getPosting(db, id)! };
}

function jevBody(over: Record<string, unknown> = {}): unknown {
  return {
    model: "jev-test",
    answers: {
      experience: { type: "choice", choice: "satisfied", confidence: 0.9 },
      education: { type: "choice", choice: "satisfied", confidence: 0.9 },
      language: { type: "choice", choice: "satisfied", confidence: 0.9 },
      eligibility: { type: "choice", choice: "satisfied", confidence: 0.9 },
      technology: { type: "choice", choice: "satisfied", confidence: 0.9 },
      relevance: { type: "score", score: 3.2, confidence: 0.9 },
    },
    usage: { input_tokens: 4000, output_tokens: 120 },
    ...over,
  };
}

/** Counts calls and serves canned responses in order. */
function transport(responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    return typeof next === "function" ? await next() : next;
  }) as typeof fetch;
  return { fn, calls };
}

const ok = (body: unknown = jevBody()) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/* ----------------------------------------------------------- happy path --- */

test("a successful response records one evaluation, one attempt and exact tokens", async (t) => {
  const { db, source, posting } = fixture(t);
  const { fn, calls } = transport([ok()]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "model_result");
  assert.equal(result.outcome, "match");
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);

  const evaluation = db.prepare("SELECT * FROM jev_evaluations").get() as Record<string, unknown>;
  assert.equal(evaluation.origin, "poller");
  assert.equal(evaluation.status, "model_result");
  assert.equal(evaluation.outcome, "match");
  assert.equal(evaluation.input_hash, jobInputHash(posting, CTX));
  assert.equal(evaluation.profile_hash, CTX.profileHash);
  assert.equal(evaluation.requested_model, "jev-test");
  assert.equal(evaluation.result_model, "jev-test");

  const attempt = db.prepare("SELECT * FROM jev_attempts").get() as Record<string, unknown>;
  assert.equal(attempt.attempt_number, 1);
  assert.equal(attempt.state, "finished");
  assert.equal(attempt.outcome, "success");
  assert.equal(attempt.input_tokens, 4000);
  assert.equal(attempt.output_tokens, 120);
  assert.equal(attempt.usage_status, "reported");
  assert.equal(attempt.http_status, 200);
  assert.ok(Number(attempt.request_bytes) > 0);
  assert.ok(Number(attempt.description_chars) > 0);

  // The posting snapshot is still the current verdict.
  assert.equal(getPosting(db, posting.id)!.fit_version, CTX.version);
  assert.equal(getPosting(db, posting.id)!.fit_eligible, 1);
});

test("429 then success: two attempts, one retry, one logical result", async (t) => {
  const { db, source, posting } = fixture(t);
  const { fn } = transport([
    new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
    ok(),
  ]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "model_result");
  assert.equal(result.attempts, 2);
  const attempts = db.prepare("SELECT attempt_number, outcome, http_status FROM jev_attempts ORDER BY attempt_number").all() as unknown as Array<Record<string, unknown>>;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]!.outcome, "http_error");
  assert.equal(attempts[0]!.http_status, 429);
  assert.equal(attempts[1]!.outcome, "success");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jev_evaluations").get() as { n: number }).n, 1);

  const window = statsWindow("all", Date.now(), "Europe/Berlin", telemetryStartMs(db) ?? 0);
  const telemetry = jevTelemetry(db, window);
  assert.equal(telemetry.attempts, 2);
  assert.equal(telemetry.retries, 1);
  assert.equal(telemetry.validResponses, 1);
  assert.equal(telemetry.terminalFailures, 1);
});

/* -------------------------------------------------------- failure modes --- */

test("a timeout is an error with unknown usage, never a rejection", async (t) => {
  const { db, source, posting } = fixture(t);
  const timeout = () => {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    throw e;
  };
  const { fn } = transport([timeout, timeout, timeout]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "error");
  assert.equal(result.outcome, null, "a timeout must not become a match or a rejection");
  assert.equal(result.errorKind, "timeout");
  const attempts = db.prepare("SELECT outcome, usage_status, input_tokens, state FROM jev_attempts").all() as unknown as Array<Record<string, unknown>>;
  assert.equal(attempts.length, 3, "bounded retries: three attempts");
  assert.ok(attempts.every((a) => a.outcome === "timeout"));
  assert.ok(attempts.every((a) => a.usage_status === "missing" && a.input_tokens === null));

  const evaluation = db.prepare("SELECT status, outcome, error_kind FROM jev_evaluations").get() as Record<string, unknown>;
  assert.equal(evaluation.status, "error");
  assert.equal(evaluation.outcome, null);
  assert.equal(evaluation.error_kind, "timeout");
  // The posting is held for a later retry rather than stamped with a verdict.
  assert.equal(getPosting(db, posting.id)!.fit_version, null);
  assert.ok(getPosting(db, posting.id)!.fit_retry_after);
});

test("a 200 with an invalid answer set still counts the usage it billed", async (t) => {
  const { db, source, posting } = fixture(t);
  const broken = jevBody({ answers: { experience: { type: "choice", choice: "satisfied", confidence: 2 } } });
  const { fn } = transport([ok(broken)]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "error");
  assert.equal(result.errorKind, "invalid_answers");
  const attempt = db.prepare("SELECT outcome, usage_status, input_tokens, output_tokens FROM jev_attempts").get() as Record<string, unknown>;
  assert.equal(attempt.outcome, "invalid_response");
  assert.equal(attempt.usage_status, "reported");
  assert.equal(attempt.input_tokens, 4000);
  assert.equal(attempt.output_tokens, 120);
});

test("missing and malformed usage stay unknown instead of becoming zero", async (t) => {
  const { db, source, posting } = fixture(t);
  const noUsage = jevBody({ usage: undefined });
  const badUsage = jevBody({ usage: { input_tokens: "many", output_tokens: null } });
  await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, transport([ok(noUsage)]).fn);
  await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, transport([ok(badUsage)]).fn);

  const rows = db.prepare("SELECT usage_status, input_tokens, output_tokens FROM jev_attempts ORDER BY rowid").all() as unknown as Array<Record<string, unknown>>;
  assert.equal(rows[0]!.usage_status, "missing");
  assert.equal(rows[1]!.usage_status, "invalid");
  assert.ok(rows.every((r) => r.input_tokens === null && r.output_tokens === null));
});

/* ------------------------------------------------------------- local --- */

test("a local rule exclusion costs no request and is not a model call", async (t) => {
  const { db, source, posting } = fixture(t);
  db.prepare("UPDATE postings SET title='Senior AI Engineer' WHERE id=?").run(posting.id);
  const senior = getPosting(db, posting.id)!;
  const { fn, calls } = transport([]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", senior, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "local_exclusion");
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(result.reasonCodes, ["role_rules_excluded"]);
  assert.equal(calls.length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jev_attempts").get() as { n: number }).n, 0);
  assert.equal(getPosting(db, posting.id)!.fit_version, CTX.version, "the local verdict is still stamped");
});

test("a discovery-rule miss is recorded as a local exclusion with its own code", async (t) => {
  const { db, source, posting } = fixture(t);
  db.prepare("UPDATE postings SET location='US only' WHERE id=?").run(posting.id);
  const usOnly = getPosting(db, posting.id)!;
  const filters: FilterConfig = { default: { locationNone: ["|us|"] } };
  const { fn, calls } = transport([]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", usOnly, { origin: "poller", source, filters }, fn);

  assert.equal(result.status, "local_exclusion");
  assert.deepEqual(result.reasonCodes, ["discovery_excluded"]);
  assert.equal(calls.length, 0);
});

test("missing and oversized descriptions are deferrals, not model errors", async (t) => {
  const { db, source, posting } = fixture(t);
  db.prepare("UPDATE postings SET description=NULL WHERE id=?").run(posting.id);
  const { fn, calls } = transport([]);
  const missing = await evaluatePosting(db, cfg(), CTX, "key", getPosting(db, posting.id)!, { origin: "poller", source, filters: {} }, fn);
  assert.equal(missing.status, "evidence_deferred");
  assert.deepEqual(missing.reasonCodes, ["missing_description"]);
  assert.equal(calls.length, 0);

  db.prepare("UPDATE postings SET description=? WHERE id=?").run("x".repeat(60_001), posting.id);
  const oversized = await evaluatePosting(db, cfg(), CTX, "key", getPosting(db, posting.id)!, { origin: "poller", source, filters: {} }, fn);
  assert.equal(oversized.status, "evidence_deferred");
  assert.deepEqual(oversized.reasonCodes, ["oversized_description"]);
  assert.equal(calls.length, 0);

  const statuses = db.prepare("SELECT status, reason_codes_json FROM jev_evaluations ORDER BY rowid").all() as unknown as Array<Record<string, unknown>>;
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every((s) => s.status === "evidence_deferred"));
});

test("enrichment supplies the missing description and the evaluation proceeds", async (t) => {
  const { db, source, posting } = fixture(t);
  db.prepare("UPDATE postings SET description=NULL WHERE id=?").run(posting.id);
  const { fn, calls } = transport([ok()]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", getPosting(db, posting.id)!, {
    origin: "poller", source, filters: {}, enrich: async () => "Enriched description with Python.",
  }, fn);
  assert.equal(result.status, "model_result");
  assert.equal(calls.length, 1);
  assert.equal(getPosting(db, posting.id)!.description, "Enriched description with Python.");
});

/* ---------------------------------------------------------- identity --- */

test("the same posting evaluated twice is two logical evaluations, one inventory row", async (t) => {
  const { db, source, posting } = fixture(t);
  await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, transport([ok()]).fn);
  await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "manual_fit", source, filters: {} }, transport([ok()]).fn);

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jev_evaluations").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM postings").get() as { n: number }).n, 1);
  const origins = db.prepare("SELECT origin FROM jev_evaluations ORDER BY rowid").all() as unknown as Array<{ origin: string }>;
  assert.deepEqual(origins.map((o) => o.origin), ["poller", "manual_fit"]);
});

test("identical model input on two sources shares one input hash; different restrictions do not", (t) => {
  const { db, source, posting } = fixture(t);
  const second = addSource(db, "remoteok", "all", "Remote OK");
  const twin = getPosting(db, upsertPosting(db, {
    source_id: second.id, key: "k2", external_id: "2", title: posting.title, company: posting.company,
    location: posting.location, remote: 0, department: null, url: "https://example.test/2",
    posted_at: posting.posted_at, posted_at_exact: 1, closes_at: null, description: posting.description,
  }))!;
  assert.equal(jobInputHash(posting, CTX), jobInputHash(twin, CTX), "same vacancy, same inference");

  const restricted = { ...twin, location: "United States only" };
  assert.notEqual(jobInputHash(posting, CTX), jobInputHash(restricted, CTX), "restrictions change the input");
  assert.notEqual(jobInputHash(posting, CTX), jobInputHash({ ...twin, description: "Different duties." }, CTX));
});

test("a description changed in flight is not stamped with the older verdict", async (t) => {
  const { db, source, posting } = fixture(t);
  const racing = (async () => {
    // Another writer updates the posting while the model request is in flight.
    db.prepare("UPDATE postings SET description='Rewritten while in flight.' WHERE id=?").run(posting.id);
    return ok();
  }) as unknown as () => Promise<Response>;
  const { fn } = transport([racing]);
  const result = await evaluatePosting(db, cfg(), CTX, "key", posting, { origin: "poller", source, filters: {} }, fn);

  assert.equal(result.status, "model_result", "the evaluation itself is recorded");
  const after = getPosting(db, posting.id)!;
  assert.equal(after.fit_version, null, "but the stale verdict must not become current");
  assert.equal(after.description, "Rewritten while in flight.");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM jev_evaluations WHERE status='model_result'").get() as { n: number }).n, 1);
});

/* -------------------------------------------------------- recovery --- */

test("an attempt interrupted by a restart is recovered as unknown, not as success or failure", (t) => {
  const { db, source, posting } = fixture(t);
  const old = Date.now() - 60 * 60_000;
  db.prepare(
    `INSERT INTO jev_evaluations (id, posting_id, posting_key, source_kind, origin, requested_at_ms,
       profile_hash, inference_version, policy_version, requested_model, status, fit_threshold, confidence_threshold)
     VALUES ('e1', ?, 'k1', 'greenhouse', 'poller', ?, 'p', 'i', 'pol', 'jev-test', 'pending', 75, 0.8)`,
  ).run(posting.id, old);
  db.prepare(
    `INSERT INTO jev_attempts (id, evaluation_id, attempt_number, input_hash, started_at_ms, state,
       requested_model, usage_status, request_bytes, profile_chars, description_chars, questions_chars)
     VALUES ('a1', 'e1', 1, 'h', ?, 'started', 'jev-test', 'missing', 10, 10, 10, 10)`,
  ).run(old);

  const recovered = recoverStaleAttempts(db, 10 * 60_000);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.evaluations, 1);

  const attempt = db.prepare("SELECT state, outcome, error_code, input_tokens, usage_status FROM jev_attempts WHERE id='a1'").get() as Record<string, unknown>;
  assert.equal(attempt.state, "unknown");
  assert.equal(attempt.outcome, null);
  assert.equal(attempt.error_code, "interrupted");
  assert.equal(attempt.input_tokens, null);
  assert.equal(attempt.usage_status, "missing");
  const evaluation = db.prepare("SELECT status, outcome, error_kind FROM jev_evaluations WHERE id='e1'").get() as Record<string, unknown>;
  assert.equal(evaluation.status, "interrupted");
  assert.equal(evaluation.outcome, null);
});

test("a young in-flight attempt is left alone: the other process may still own it", (t) => {
  const { db, posting } = fixture(t);
  db.prepare(
    `INSERT INTO jev_evaluations (id, posting_id, posting_key, source_kind, origin, requested_at_ms,
       profile_hash, inference_version, policy_version, requested_model, status, fit_threshold, confidence_threshold)
     VALUES ('e2', ?, 'k1', 'greenhouse', 'poller', ?, 'p', 'i', 'pol', 'jev-test', 'pending', 75, 0.8)`,
  ).run(posting.id, Date.now());
  db.prepare(
    `INSERT INTO jev_attempts (id, evaluation_id, attempt_number, input_hash, started_at_ms, state,
       requested_model, usage_status, request_bytes, profile_chars, description_chars, questions_chars)
     VALUES ('a2', 'e2', 1, 'h', ?, 'started', 'jev-test', 'missing', 10, 10, 10, 10)`,
  ).run(Date.now());
  assert.deepEqual(recoverStaleAttempts(db, 10 * 60_000), { attempts: 0, evaluations: 0 });
});

/* ------------------------------------------------------------- stats --- */

test("stats never invokes the provider and stays within Discord limits", (t) => {
  const { db, source, posting } = fixture(t);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("stats must not call the provider");
  }) as typeof fetch;
  try {
    ensureTelemetryStart(db);
    const window = statsWindow("24h", Date.now(), "Europe/Berlin", telemetryStartMs(db));
    const telemetry = jevTelemetry(db, window);
    const text = renderStatsReport({
      window, telemetry, inventory: jevStats(db, cfg(), CTX.version),
      extras: jevInventoryExtras(db, CTX.version), cfg: cfg(), view: "summary", nowMs: Date.now(),
    });
    assert.equal(calls, 0);
    assert.ok(text.length < 2000, `summary is ${text.length} chars`);
    assert.ok(!text.includes("NaN") && !text.includes("Infinity"));
    assert.match(text, /Cache hits: not enabled/);
    assert.match(text, /request budget: not configured/);
    assert.match(text, /Tracking began:/);
  } finally {
    globalThis.fetch = original;
  }
});

test("window boundaries use the configured timezone, including DST transitions", () => {
  // Spring forward (2026-03-29): local midnight is still CET (+1).
  assert.equal(new Date(startOfZonedDay(Date.parse("2026-03-29T12:00:00Z"), "Europe/Berlin")).toISOString(), "2026-03-28T23:00:00.000Z");
  // Fall back (2026-10-25): local midnight is still CEST (+2).
  assert.equal(new Date(startOfZonedDay(Date.parse("2026-10-25T12:00:00Z"), "Europe/Berlin")).toISOString(), "2026-10-24T22:00:00.000Z");
  // Ordinary day.
  assert.equal(new Date(startOfZonedDay(Date.parse("2026-09-23T12:00:00Z"), "Europe/Berlin")).toISOString(), "2026-09-22T22:00:00.000Z");
});

test("attempts are attributed to their start time and partial coverage is labelled", (t) => {
  const { db, source, posting } = fixture(t);
  const now = Date.now();
  const insert = (id: string, startedAt: number, outcome: string) =>
    db.prepare(
      `INSERT INTO jev_attempts (id, evaluation_id, attempt_number, input_hash, started_at_ms, finished_at_ms,
         duration_ms, state, outcome, requested_model, usage_status, input_tokens, output_tokens,
         request_bytes, profile_chars, description_chars, questions_chars)
       VALUES (?, ?, 1, 'h', ?, ?, 100, 'finished', ?, 'jev-test', 'reported', 10, 5, 1, 1, 1, 1)`,
    ).run(id, `ev-${id}`, startedAt, startedAt + 100, outcome);
  insert("old", now - 48 * 3_600_000, "success"); // outside a 24h window
  insert("in", now - 60_000, "success");
  insert("cross", now - 24 * 3_600_000 + 1, "success"); // started just inside the window

  const telemetryStart = now - 2 * 3_600_000; // tracking began two hours ago
  const window = statsWindow("24h", now, "Europe/Berlin", telemetryStart);
  assert.equal(window.partial, true);
  assert.equal(window.effectiveStartMs, telemetryStart);
  const telemetry = jevTelemetry(db, window);
  // Only the attempt started after tracking began is counted; the older two are
  // before coverage, not zero-usage rows.
  assert.equal(telemetry.attempts, 1);
  assert.equal(telemetry.validResponses, 1);

  const text = renderStatsReport({
    window, telemetry, inventory: jevStats(db, cfg(), CTX.version),
    extras: jevInventoryExtras(db, CTX.version), cfg: cfg(), view: "summary", nowMs: now,
  });
  assert.match(text, /tracking began/);
});

test("usage history survives unwatching the source", (t) => {
  const { db, source, posting } = fixture(t);
  db.prepare(
    `INSERT INTO jev_evaluations (id, posting_id, posting_key, source_kind, origin, requested_at_ms,
       profile_hash, inference_version, policy_version, requested_model, status, fit_threshold, confidence_threshold)
     VALUES ('e3', ?, 'k1', 'greenhouse', 'poller', ?, 'p', 'i', 'pol', 'jev-test', 'model_result', 75, 0.8)`,
  ).run(posting.id, Date.now());

  assert.equal(removeSource(db, source.kind, source.ident), true);
  const evaluation = db.prepare("SELECT posting_id, source_kind, status FROM jev_evaluations WHERE id='e3'").get() as Record<string, unknown>;
  assert.ok(evaluation, "the ledger row must survive");
  assert.equal(evaluation.posting_id, null, "the reference is cleared, not cascaded");
  assert.equal(evaluation.source_kind, "greenhouse");
});

test("an empty database renders readable zeros", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "eve-jev-empty-"));
  const db = openDb(join(dir, "empty.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const window = statsWindow("24h", Date.now(), "Europe/Berlin", telemetryStartMs(db));
  const telemetry = jevTelemetry(db, window);
  assert.ok(Object.values(telemetry).every((v) => typeof v !== "number" || Number.isFinite(v)));
  const text = renderStatsReport({
    window, telemetry, inventory: jevStats(db, cfg(), "v"),
    extras: jevInventoryExtras(db, "v"), cfg: cfg(), view: "summary", nowMs: Date.now(),
  });
  assert.ok(!text.includes("NaN") && !text.includes("Infinity"));
  assert.match(text, /no telemetry recorded yet/);
});

test("the errors and sources views stay bounded and name controlled codes", (t) => {
  const { db, source, posting } = fixture(t);
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    db.prepare(
      `INSERT INTO jev_attempts (id, evaluation_id, attempt_number, input_hash, started_at_ms, finished_at_ms,
         duration_ms, state, outcome, error_code, requested_model, usage_status,
         request_bytes, profile_chars, description_chars, questions_chars)
       VALUES (?, ?, 1, 'h', ?, ?, 5, 'finished', 'http_error', ?, 'jev-test', 'missing', 1, 1, 1, 1)`,
    ).run(`err-${i}`, `ev-err-${i}`, now - 1000, now, i % 2 ? "http_429" : "timeout");
  }
  const window = statsWindow("24h", now, "Europe/Berlin", now - 1000);
  const telemetry = jevTelemetry(db, window);
  assert.equal(telemetry.errors.length, 2);
  const report = {
    window, telemetry, inventory: jevStats(db, cfg(), CTX.version),
    extras: jevInventoryExtras(db, CTX.version), cfg: cfg(), nowMs: now,
  };
  const errors = renderStatsReport({ ...report, view: "errors" });
  assert.match(errors, /`timeout`: \*\*10\*\*/);
  assert.match(errors, /`http_429`: \*\*10\*\*/);
  assert.ok(errors.length < 2000);
  const sources = renderStatsReport({ ...report, view: "sources" });
  assert.ok(sources.length < 2000);
});
