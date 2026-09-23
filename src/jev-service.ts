import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import type { Config } from "./config.ts";
import { deferFit, getPosting, setJevFit } from "./db.ts";
import { matches, specFor, type FilterConfig } from "./filter.ts";
import {
  buildJevRequest,
  jobInputHash,
  requestJev,
  retryDecision,
  type JevAttempt,
  type JevContext,
  type JevResult,
} from "./jev.ts";
import { passesRoleRules } from "./roles.ts";
import type { PostingRow, SourceRow } from "./types.ts";

/**
 * The one accounted path to a Jev evaluation.
 *
 * Both the poller and the manual `/fit` command come through here, so every
 * real request is recorded exactly once, in the same shape, with the same
 * failure vocabulary. The ledger is deliberately separate from the
 * `postings.fit_*` snapshot: the snapshot answers "what is the current verdict
 * for this job", the ledger answers "what did we ask the model, when, and what
 * came back" — including for postings that were later closed or unwatched.
 *
 * Milestone A scope: evaluations, attempts, usage, outcomes, recovery. No
 * cross-process cache or budget yet; those are additive later milestones and
 * `/stats` says so instead of pretending they exist.
 *
 * Failure discipline (see the handoff's §7.2):
 *   - an attempt row is written and committed *before* the request goes out, so
 *     a crash leaves a recoverable "unknown" attempt rather than an invisible
 *     request;
 *   - usage is read from the response independently of answer validity, so a
 *     200 with a broken answer set still accounts for the tokens it billed;
 *   - NULL usage stays unknown; it is never turned into zero;
 *   - a late response never overwrites a newer posting state (conditional
 *     update on the exact model input hash).
 */

export type EvaluationOrigin = "poller" | "manual_fit";

export type EvaluationStatus =
  | "pending"
  | "model_result"
  | "cache_hit"
  | "local_exclusion"
  | "evidence_deferred"
  | "budget_deferred"
  | "error"
  | "interrupted";

export type EvaluationOutcome = "match" | "rejected" | "review_needed";

export interface EvaluationResult {
  status: EvaluationStatus;
  outcome: EvaluationOutcome | null;
  result: JevResult | null;
  errorKind: string | null;
  reasonCodes: string[];
  attempts: number;
  /** A configuration-level failure (auth/bad request): stop the current batch. */
  configError: boolean;
}

export interface EvaluateOptions {
  origin: EvaluationOrigin;
  source: SourceRow;
  filters: FilterConfig;
  /** Used when the posting has no usable description (the poller enriches; /fit does not). */
  enrich?: (posting: PostingRow) => Promise<string | null>;
  now?: () => number;
}

/* ------------------------------------------------------------- meta --- */

/** Written once, never reset: `/stats` coverage must survive restarts. */
export function ensureTelemetryStart(db: DatabaseSync, nowMs = Date.now()): void {
  db.prepare("INSERT OR IGNORE INTO jev_meta (key, value) VALUES ('telemetry_started_at_ms', ?)").run(String(nowMs));
  db.prepare("INSERT OR IGNORE INTO jev_meta (key, value) VALUES ('telemetry_schema', '1')").run();
}

export function telemetryStartMs(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT value FROM jev_meta WHERE key = 'telemetry_started_at_ms'").get() as
    | { value: string }
    | undefined;
  const parsed = row ? Number(row.value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Close out attempts/evaluations left open by a crash or kill.
 *
 * Only rows older than `staleMs` are touched: the poller and the bot both write
 * to this ledger, and a young `started` row may well belong to the other live
 * process. A recovered attempt is `unknown`, not a fabricated failure or a
 * zero-token success, and its reserved budget (when budgets exist) stays spent.
 */
export function recoverStaleAttempts(
  db: DatabaseSync,
  staleMs = 10 * 60_000,
  nowMs = Date.now(),
): { attempts: number; evaluations: number } {
  const cutoff = nowMs - staleMs;
  const attempts = db
    .prepare(
      `UPDATE jev_attempts
          SET state = 'unknown', finished_at_ms = ?, duration_ms = ? - started_at_ms, error_code = 'interrupted'
        WHERE state IN ('reserved', 'started') AND started_at_ms < ?`,
    )
    .run(nowMs, nowMs, cutoff);
  const evaluations = db
    .prepare(
      `UPDATE jev_evaluations
          SET status = 'interrupted', completed_at_ms = ?, error_kind = 'interrupted'
        WHERE status = 'pending' AND requested_at_ms < ?`,
    )
    .run(nowMs, cutoff);
  return { attempts: Number(attempts.changes), evaluations: Number(evaluations.changes) };
}

/* -------------------------------------------------------- reason codes --- */

const DIMENSIONS = ["experience", "education", "language", "eligibility", "technology"] as const;

/**
 * Controlled reason codes for the ledger. The raw answers stay in
 * `postings.fit_details`; this is the queryable summary.
 */
export function reasonCodesFor(result: JevResult, cfg: Pick<Config, "fitThreshold" | "fitConfidence">): string[] {
  const codes: string[] = [];
  let answers: Record<string, { choice?: string }> = {};
  try {
    answers = (JSON.parse(result.details) as { answers?: Record<string, { choice?: string }> }).answers ?? {};
  } catch {
    /* details without answers: only the score/confidence codes below apply */
  }
  for (const dimension of DIMENSIONS) {
    const choice = answers[dimension]?.choice;
    if (choice === "contradicted" || choice === "unknown") codes.push(`${dimension}_${choice}`);
  }
  if (result.confidence < (cfg.fitConfidence ?? 0.8)) codes.push("low_confidence");
  if (result.score < cfg.fitThreshold) codes.push("low_relevance");
  if (result.eligible && codes.length === 0) codes.push("match");
  return codes;
}

/**
 * Reporting precedence, applied without changing what reaches Discord:
 * explicit mandatory contradiction -> rejected; otherwise missing evidence or
 * insufficient confidence -> review-needed; otherwise relevance below
 * threshold -> rejected; otherwise match.
 */
export function outcomeFor(result: JevResult, cfg: Pick<Config, "fitThreshold" | "fitConfidence">): EvaluationOutcome {
  const codes = reasonCodesFor(result, cfg);
  if (codes.some((c) => c.endsWith("_contradicted"))) return "rejected";
  if (codes.some((c) => c.endsWith("_unknown") || c === "low_confidence")) return "review_needed";
  if (codes.includes("low_relevance")) return "rejected";
  return "match";
}

/* -------------------------------------------------------------- rows --- */

interface EvaluationRow {
  id: string;
  posting_id: number | null;
  posting_key: string;
  source_kind: string;
  source_ident_hash: string | null;
  origin: EvaluationOrigin;
  requested_at_ms: number;
  completed_at_ms: number | null;
  input_hash: string | null;
  profile_hash: string;
  inference_version: string;
  policy_version: string;
  requested_model: string;
  result_model: string | null;
  status: EvaluationStatus;
  outcome: EvaluationOutcome | null;
  reason_codes_json: string;
  fit_score: number | null;
  confidence: number | null;
  eligible: number | null;
  fit_threshold: number;
  confidence_threshold: number;
  cache_entry_hash: string | null;
  error_kind: string | null;
}

function identHash(source: SourceRow): string {
  return createHash("sha256").update(`${source.kind}:${source.ident}`).digest("hex");
}

function insertEvaluation(db: DatabaseSync, row: EvaluationRow): void {
  db.prepare(
    `INSERT INTO jev_evaluations (
       id, posting_id, posting_key, source_kind, source_ident_hash, origin,
       requested_at_ms, completed_at_ms, input_hash, profile_hash, inference_version,
       policy_version, requested_model, result_model, status, outcome, reason_codes_json,
       fit_score, confidence, eligible, fit_threshold, confidence_threshold,
       cache_entry_hash, error_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.posting_id, row.posting_key, row.source_kind, row.source_ident_hash, row.origin,
    row.requested_at_ms, row.completed_at_ms, row.input_hash, row.profile_hash, row.inference_version,
    row.policy_version, row.requested_model, row.result_model, row.status, row.outcome, row.reason_codes_json,
    row.fit_score, row.confidence, row.eligible, row.fit_threshold, row.confidence_threshold,
    row.cache_entry_hash, row.error_kind,
  );
}

function finishEvaluation(
  db: DatabaseSync,
  id: string,
  patch: {
    status: EvaluationStatus;
    outcome?: EvaluationOutcome | null;
    result?: JevResult | null;
    returnedModel?: string | null;
    reasonCodes?: string[];
    errorKind?: string | null;
  },
  nowMs: number,
): void {
  db.prepare(
    `UPDATE jev_evaluations
        SET completed_at_ms = ?, status = ?, outcome = ?, result_model = ?, reason_codes_json = ?,
            fit_score = ?, confidence = ?, eligible = ?, error_kind = ?
      WHERE id = ?`,
  ).run(
    nowMs,
    patch.status,
    patch.outcome ?? null,
    patch.returnedModel ?? null,
    JSON.stringify(patch.reasonCodes ?? []),
    patch.result?.score ?? null,
    patch.result?.confidence ?? null,
    patch.result ? Number(patch.result.eligible) : null,
    patch.errorKind ?? null,
    id,
  );
}

function insertAttempt(db: DatabaseSync, attempt: {
  id: string; evaluationId: string; attemptNumber: number; inputHash: string;
  startedAtMs: number; requestedModel: string; requestBytes: number;
  profileChars: number; descriptionChars: number; questionsChars: number;
}): void {
  db.prepare(
    `INSERT INTO jev_attempts (
       id, evaluation_id, attempt_number, input_hash, started_at_ms, state,
       requested_model, usage_status, request_bytes, profile_chars, description_chars, questions_chars
     ) VALUES (?, ?, ?, ?, ?, 'started', ?, 'missing', ?, ?, ?, ?)`,
  ).run(
    attempt.id, attempt.evaluationId, attempt.attemptNumber, attempt.inputHash, attempt.startedAtMs,
    attempt.requestedModel, attempt.requestBytes, attempt.profileChars, attempt.descriptionChars,
    attempt.questionsChars,
  );
}

function finishAttempt(db: DatabaseSync, id: string, attempt: JevAttempt, nowMs: number): void {
  db.prepare(
    `UPDATE jev_attempts
        SET finished_at_ms = ?, duration_ms = ?, state = 'finished', http_status = ?, outcome = ?,
            error_code = ?, retry_after_ms = ?, returned_model = ?, input_tokens = ?, output_tokens = ?,
            usage_status = ?
      WHERE id = ?`,
  ).run(
    nowMs, attempt.durationMs, attempt.httpStatus, attempt.outcome, attempt.errorCode, attempt.retryAfterMs,
    attempt.returnedModel, attempt.usage.inputTokens, attempt.usage.outputTokens, attempt.usage.status, id,
  );
}

/* ---------------------------------------------------------- evaluate --- */

/**
 * Evaluate one posting, recording the logical evaluation and every transport
 * attempt. Returns what happened; never throws for provider failures.
 */
export async function evaluatePosting(
  db: DatabaseSync,
  cfg: Config,
  context: JevContext,
  apiKey: string,
  posting: PostingRow,
  options: EvaluateOptions,
  request: typeof fetch = fetch,
): Promise<EvaluationResult> {
  const now = options.now ?? Date.now;
  const requestedAt = now();
  const baseRow: EvaluationRow = {
    id: randomUUID(),
    posting_id: posting.id,
    posting_key: posting.key,
    source_kind: options.source.kind,
    source_ident_hash: identHash(options.source),
    origin: options.origin,
    requested_at_ms: requestedAt,
    completed_at_ms: null,
    input_hash: null,
    profile_hash: context.profileHash,
    inference_version: context.inferenceVersion,
    policy_version: context.policyVersion,
    requested_model: context.model,
    result_model: null,
    status: "pending",
    outcome: null,
    reason_codes_json: "[]",
    fit_score: null,
    confidence: null,
    eligible: null,
    fit_threshold: cfg.fitThreshold,
    confidence_threshold: cfg.fitConfidence ?? 0.8,
    cache_entry_hash: null,
    error_kind: null,
  };

  const localFinish = (reasonCode: string, reason: string): EvaluationResult => {
    insertEvaluation(db, { ...baseRow, status: "local_exclusion", completed_at_ms: now(), outcome: "rejected", reason_codes_json: JSON.stringify([reasonCode]) });
    applyFit(db, posting, context, { score: 0, confidence: 1, eligible: false, reason, details: "{}" });
    return { status: "local_exclusion", outcome: "rejected", result: null, errorKind: null, reasonCodes: [reasonCode], attempts: 0, configError: false };
  };

  // Local rules first: a title/seniority/language exclusion or a discovery-rule
  // miss costs no request, and must never appear as a model call in /stats.
  if (!passesRoleRules(posting.title, posting.description)) {
    return localFinish("role_rules_excluded", "Existing seniority, experience or language exclusion");
  }
  const spec = specFor(options.filters, options.source.kind, options.source.ident);
  const discoveryMatch = matches({
    externalId: posting.external_id, title: posting.title, company: posting.company,
    location: posting.location, remote: posting.remote === null ? null : posting.remote === 1,
    department: posting.department, url: posting.url,
    postedAt: posting.posted_at_exact ? posting.posted_at : null,
    closesAt: posting.closes_at, description: posting.description,
  }, spec);
  if (!discoveryMatch) {
    return localFinish("discovery_excluded", "Excluded by current discovery rules");
  }

  // Evidence: a missing description is a deferral, not a rejection and not a
  // model error. The poller enriches; /fit has no enrichment path.
  let description = posting.description?.trim() ? posting.description : null;
  if (!description && options.enrich) {
    description = await options.enrich(posting);
    if (description) db.prepare("UPDATE postings SET description=? WHERE id=?").run(description, posting.id);
  }
  if (!description) {
    insertEvaluation(db, { ...baseRow, status: "evidence_deferred", completed_at_ms: now(), reason_codes_json: JSON.stringify(["missing_description"]) });
    deferFit(db, posting.id);
    return { status: "evidence_deferred", outcome: null, result: null, errorKind: null, reasonCodes: ["missing_description"], attempts: 0, configError: false };
  }
  if (description.length > 60_000) {
    insertEvaluation(db, { ...baseRow, status: "evidence_deferred", completed_at_ms: now(), reason_codes_json: JSON.stringify(["oversized_description"]) });
    deferFit(db, posting.id);
    return { status: "evidence_deferred", outcome: null, result: null, errorKind: null, reasonCodes: ["oversized_description"], attempts: 0, configError: false };
  }

  const current: PostingRow = { ...posting, description };
  const inputHash = jobInputHash(current, context);
  insertEvaluation(db, { ...baseRow, input_hash: inputHash });

  let attemptNumber = 0;
  let lastError: string | null = null;
  let configError = false;
  for (;;) {
    attemptNumber++;
    const prepared = buildJevRequest(current, context);
    const attemptId = randomUUID();
    // Persist intent and commit before dispatch. If this write fails, the
    // caller's try/catch defers the posting; no untracked request is sent.
    insertAttempt(db, {
      id: attemptId, evaluationId: baseRow.id, attemptNumber, inputHash,
      startedAtMs: now(), requestedModel: context.model,
      requestBytes: prepared.requestBytes, profileChars: prepared.profileChars,
      descriptionChars: prepared.descriptionChars, questionsChars: prepared.questionsChars,
    });

    const attempt = await requestJev(current, context, apiKey, request, prepared);
    finishAttempt(db, attemptId, attempt, now());

    if (attempt.result) {
      const reasonCodes = reasonCodesFor(attempt.result, cfg);
      const outcome = outcomeFor(attempt.result, cfg);
      finishEvaluation(db, baseRow.id, {
        status: "model_result", outcome, result: attempt.result, returnedModel: attempt.returnedModel, reasonCodes,
      }, now());
      applyFit(db, current, context, attempt.result, inputHash);
      return { status: "model_result", outcome, result: attempt.result, errorKind: null, reasonCodes, attempts: attemptNumber, configError: false };
    }

    lastError = attempt.errorCode;
    const decision = retryDecision(attempt, attemptNumber);
    if (decision.retry) {
      await delay(decision.delayMs);
      continue;
    }
    // Auth and malformed-request failures are configuration problems: record
    // them, stop this batch, and let the persisted retry schedule hold the
    // posting rather than re-attempting the same broken request every cycle.
    configError = attempt.errorCode === "http_4xx";
    break;
  }

  finishEvaluation(db, baseRow.id, { status: "error", errorKind: lastError }, now());
  deferFit(db, posting.id, configError ? 24 : 6);
  if (configError) {
    console.error(`[jev] configuration-level failure (${lastError}); pausing this scoring batch`);
  }
  return { status: "error", outcome: null, result: null, errorKind: lastError, reasonCodes: [], attempts: attemptNumber, configError };
}

/**
 * Stamp the posting with the result only if its model input still matches what
 * was evaluated. A description or title that changed while the request was in
 * flight belongs to the newer input; the older verdict is recorded in the
 * ledger and cache (when it exists) but must not become the posting's current
 * state.
 */
function applyFit(db: DatabaseSync, posting: PostingRow, context: JevContext, result: JevResult, expectedHash?: string): void {
  if (expectedHash !== undefined) {
    const fresh = getPosting(db, posting.id);
    if (!fresh || jobInputHash(fresh, context) !== expectedHash) return;
    setJevFit(db, posting.id, result, context.version);
    return;
  }
  // Local exclusions are policy, not inference: they may be stamped directly.
  setJevFit(db, posting.id, result, context.version);
}
