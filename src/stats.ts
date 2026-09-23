import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";

/**
 * `/stats` has two halves that must never be confused:
 *
 *   - the **inventory snapshot** (`jevStats`): what the postings table says
 *     right now — how many open jobs have a current verdict, how many match,
 *     how many await assessment. This is not a request counter.
 *   - the **ledger** (`jevTelemetry`): what was actually asked of the model in
 *     a chosen time window, from `jev_evaluations`/`jev_attempts`. Attempts are
 *     attributed to their start time; logical evaluations to their request
 *     time. The two windows can legitimately disagree while requests are in
 *     flight, and the footer says so.
 *
 * Neither function ever calls the provider.
 */

/* ------------------------------------------------------------ windows --- */

export type StatsPeriod = "today" | "24h" | "7d" | "all";
export type StatsView = "summary" | "errors" | "sources";

export interface StatsWindow {
  period: StatsPeriod;
  timezone: string;
  /** Requested window, half-open [startMs, endMs). */
  startMs: number;
  endMs: number;
  /** Effective start after clamping to tracked coverage. */
  effectiveStartMs: number;
  /** Telemetry start, or null when nothing has been recorded yet. */
  telemetryStartMs: number | null;
  /** True when the requested window starts before tracking began. */
  partial: boolean;
  label: string;
}

function zonedParts(ms: number, timezone: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    // Some engines report midnight as hour "24" with hour12:false.
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

function tzOffsetMs(ms: number, timezone: string): number {
  const p = zonedParts(ms, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * UTC instant of local midnight in `timezone`.
 *
 * Two refinements, because the offset that applies at midnight is not always
 * the offset at noon: on a DST-transition day the first guess can land an hour
 * off, and the second pass uses the offset at the guessed instant itself.
 */
export function startOfZonedDay(nowMs: number, timezone: string): number {
  const p = zonedParts(nowMs, timezone);
  const dateStr = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const utcMidnight = Date.parse(`${dateStr}T00:00:00Z`);
  let guess = utcMidnight - tzOffsetMs(utcMidnight, timezone);
  guess = utcMidnight - tzOffsetMs(guess, timezone);
  return guess;
}

export function statsWindow(
  period: StatsPeriod,
  nowMs: number,
  timezone: string,
  telemetryStartMs: number | null,
): StatsWindow {
  const endMs = nowMs;
  let startMs: number;
  let label: string;
  switch (period) {
    case "24h":
      startMs = endMs - 24 * 3_600_000;
      label = "last 24 hours";
      break;
    case "7d":
      startMs = endMs - 7 * 24 * 3_600_000;
      label = "last 7 days";
      break;
    case "today":
      startMs = startOfZonedDay(nowMs, timezone);
      label = "today";
      break;
    case "all":
      startMs = telemetryStartMs ?? endMs;
      label = "since tracking began";
      break;
  }
  const effectiveStartMs = telemetryStartMs === null ? startMs : Math.max(startMs, telemetryStartMs);
  return {
    period, timezone, startMs, endMs, effectiveStartMs, telemetryStartMs,
    partial: telemetryStartMs !== null && telemetryStartMs > startMs,
    label,
  };
}

/* ---------------------------------------------------------- telemetry --- */

export interface JevTelemetry {
  attempts: number;
  retries: number;
  inFlight: number;
  validResponses: number;
  terminalFailures: number;
  inputTokens: number;
  outputTokens: number;
  usageReported: number;
  usageMissing: number;
  logical: number;
  uniqueInputs: number;
  cacheHits: number;
  localExclusions: number;
  evidenceDeferred: number;
  matches: number;
  rejected: number;
  reviewNeeded: number;
  completedResults: number;
  latency: { p50: number | null; p95: number | null; samples: number };
  errors: Array<{ code: string; n: number }>;
  bySource: Array<{ kind: string; attempts: number; matches: number; rejected: number; review: number; deferred: number }>;
}

function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  // Nearest-rank: index = ceil(p * n) - 1.
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function jevTelemetry(db: DatabaseSync, window: StatsWindow): JevTelemetry {
  const { effectiveStartMs: start, endMs: end } = window;

  const attemptRow = db.prepare(
    `SELECT
       COUNT(*) AS attempts,
       COALESCE(SUM(attempt_number > 1), 0) AS retries,
       COALESCE(SUM(state IN ('reserved', 'started')), 0) AS in_flight,
       COALESCE(SUM(state = 'finished' AND outcome = 'success'), 0) AS valid_responses,
       COALESCE(SUM(state = 'finished' AND outcome IS NOT NULL AND outcome != 'success'), 0) AS terminal_failures,
       COALESCE(SUM(CASE WHEN usage_status = 'reported' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
       COALESCE(SUM(CASE WHEN usage_status = 'reported' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
       COALESCE(SUM(usage_status = 'reported'), 0) AS usage_reported,
       COALESCE(SUM(state = 'finished' AND usage_status != 'reported'), 0) AS usage_missing
     FROM jev_attempts WHERE started_at_ms >= ? AND started_at_ms < ?`,
  ).get(start, end) as Record<string, number>;

  const evalRow = db.prepare(
    `SELECT
       COUNT(*) AS logical,
       COUNT(DISTINCT input_hash) AS unique_inputs,
       COALESCE(SUM(status = 'cache_hit'), 0) AS cache_hits,
       COALESCE(SUM(status = 'local_exclusion'), 0) AS local_exclusions,
       COALESCE(SUM(status = 'evidence_deferred'), 0) AS evidence_deferred,
       COALESCE(SUM(outcome = 'match'), 0) AS matches,
       COALESCE(SUM(outcome = 'rejected'), 0) AS rejected,
       COALESCE(SUM(outcome = 'review_needed'), 0) AS review_needed,
       COALESCE(SUM(outcome IS NOT NULL), 0) AS completed_results
     FROM jev_evaluations WHERE requested_at_ms >= ? AND requested_at_ms < ?`,
  ).get(start, end) as Record<string, number>;

  const durations = (
    db.prepare(
      `SELECT duration_ms FROM jev_attempts
        WHERE started_at_ms >= ? AND started_at_ms < ? AND state = 'finished' AND duration_ms IS NOT NULL
        ORDER BY duration_ms`,
    ).all(start, end) as unknown as Array<{ duration_ms: number }>
  ).map((r) => r.duration_ms);

  const errors = db.prepare(
    `SELECT error_code AS code, COUNT(*) AS n FROM jev_attempts
      WHERE started_at_ms >= ? AND started_at_ms < ? AND state = 'finished' AND outcome != 'success'
      GROUP BY error_code ORDER BY n DESC`,
  ).all(start, end) as unknown as Array<{ code: string; n: number }>;

  const bySource = db.prepare(
    `SELECT source_kind AS kind, COUNT(*) AS attempts,
            COALESCE(SUM(outcome = 'match'), 0) AS matches,
            COALESCE(SUM(outcome = 'rejected'), 0) AS rejected,
            COALESCE(SUM(outcome = 'review_needed'), 0) AS review,
            COALESCE(SUM(status = 'evidence_deferred'), 0) AS deferred
       FROM jev_evaluations WHERE requested_at_ms >= ? AND requested_at_ms < ?
      GROUP BY source_kind ORDER BY attempts DESC`,
  ).all(start, end) as unknown as Array<{ kind: string; attempts: number; matches: number; rejected: number; review: number; deferred: number }>;

  return {
    attempts: attemptRow.attempts ?? 0,
    retries: attemptRow.retries ?? 0,
    inFlight: attemptRow.in_flight ?? 0,
    validResponses: attemptRow.valid_responses ?? 0,
    terminalFailures: attemptRow.terminal_failures ?? 0,
    inputTokens: attemptRow.input_tokens ?? 0,
    outputTokens: attemptRow.output_tokens ?? 0,
    usageReported: attemptRow.usage_reported ?? 0,
    usageMissing: attemptRow.usage_missing ?? 0,
    logical: evalRow.logical ?? 0,
    uniqueInputs: evalRow.unique_inputs ?? 0,
    cacheHits: evalRow.cache_hits ?? 0,
    localExclusions: evalRow.local_exclusions ?? 0,
    evidenceDeferred: evalRow.evidence_deferred ?? 0,
    matches: evalRow.matches ?? 0,
    rejected: evalRow.rejected ?? 0,
    reviewNeeded: evalRow.review_needed ?? 0,
    completedResults: evalRow.completed_results ?? 0,
    latency: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      samples: durations.length,
    },
    errors,
    bySource,
  };
}

/* --------------------------------------------------------- inventory --- */

/** Snapshot of stored postings, not API calls or a lifetime event counter. */
export function jevStats(db: DatabaseSync, cfg: Pick<Config, 'fitThreshold' | 'fitConfidence'>, version: string) {
  return db.prepare(`
    WITH jobs AS (
      SELECT *,
        CASE WHEN json_valid(fit_details) THEN json_type(fit_details, '$.answers') = 'object' ELSE 0 END AS model_result,
        COALESCE(fit_version = ?, 0) AS current_result
      FROM postings
    )
    SELECT
      COUNT(*) AS stored,
      COUNT(CASE WHEN model_result THEN 1 END) AS evaluated,
      COUNT(CASE WHEN state = 'open' THEN 1 END) AS open,
      COUNT(CASE WHEN state = 'open' AND current_result AND model_result THEN 1 END) AS current_evaluated,
      COUNT(CASE WHEN state = 'open' AND current_result AND model_result
        AND fit_eligible = 1 AND fit_score >= ? AND fit_confidence >= ? THEN 1 END) AS matched,
      COUNT(CASE WHEN state = 'open' AND current_result AND fit_details = '{}' THEN 1 END) AS rule_excluded,
      COUNT(CASE WHEN state = 'open' AND NOT current_result THEN 1 END) AS pending,
      COUNT(CASE WHEN state = 'open' AND NOT current_result AND fit_retry_after > datetime('now') THEN 1 END) AS deferred
    FROM jobs
  `).get(version, cfg.fitThreshold, cfg.fitConfidence ?? 0.8) as {
    stored: number; evaluated: number; open: number; current_evaluated: number;
    matched: number; rule_excluded: number; pending: number; deferred: number;
  };
}

/** Inventory details the window ledger cannot answer (they are "now", not a period). */
export function jevInventoryExtras(db: DatabaseSync, version: string): {
  missingDescription: number;
  retryDelayed: number;
} {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(state = 'open' AND (fit_version IS NULL OR fit_version != ?)
                    AND (description IS NULL OR trim(description) = '')), 0) AS missing_description,
       COALESCE(SUM(state = 'open' AND (fit_version IS NULL OR fit_version != ?)
                    AND fit_retry_after IS NOT NULL AND fit_retry_after > datetime('now')), 0) AS retry_delayed
     FROM postings`,
  ).get(version, version) as { missing_description: number; retry_delayed: number };
  return { missingDescription: row.missing_description, retryDelayed: row.retry_delayed };
}

/* ---------------------------------------------------------- rendering --- */

const n = (value: number) => value.toLocaleString("en-US");

function fmtZoned(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

function fmtZonedFull(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

function ms(value: number | null): string {
  return value === null ? "—" : `${n(value)}ms`;
}

export interface StatsReportInput {
  window: StatsWindow;
  telemetry: JevTelemetry;
  inventory: ReturnType<typeof jevStats>;
  extras: ReturnType<typeof jevInventoryExtras>;
  cfg: Pick<Config, "fitThreshold" | "fitConfidence">;
  view: StatsView;
  nowMs: number;
}

const MAX_LINES_PER_LIST = 12;

export function renderStatsReport(input: StatsReportInput): string {
  const { window: w, telemetry: t, inventory: inv, extras, cfg, view } = input;
  const lines: string[] = [];

  if (view === "errors") {
    lines.push(`**Jev errors — ${w.label}**`);
    lines.push(`Window: ${fmtZoned(w.effectiveStartMs, w.timezone)} → ${fmtZoned(w.endMs, w.timezone)} ${w.timezone}`);
    lines.push("");
    if (t.errors.length === 0) lines.push("No failed or invalid attempts in this window.");
    for (const e of t.errors.slice(0, MAX_LINES_PER_LIST)) {
      lines.push(`\`${e.code ?? "unknown"}\`: **${n(e.n)}**`);
    }
    if (t.errors.length > MAX_LINES_PER_LIST) lines.push(`…and ${t.errors.length - MAX_LINES_PER_LIST} more codes`);
    lines.push("");
    lines.push(`In flight/unknown attempts: ${n(t.inFlight)} · missing usage: ${n(t.usageMissing)}`);
    lines.push(`_A timeout is not a rejection and a missing description is not a model error._`);
    return lines.join("\n");
  }

  if (view === "sources") {
    lines.push(`**Jev by source — ${w.label}**`);
    lines.push(`Window: ${fmtZoned(w.effectiveStartMs, w.timezone)} → ${fmtZoned(w.endMs, w.timezone)} ${w.timezone}`);
    lines.push("");
    if (t.bySource.length === 0) lines.push("No logical evaluations in this window.");
    for (const s of t.bySource.slice(0, MAX_LINES_PER_LIST)) {
      lines.push(
        `\`${s.kind}\`: ${n(s.attempts)} evaluations · ${n(s.matches)} match · ${n(s.rejected)} rejected · ${n(s.review)} review · ${n(s.deferred)} deferred`,
      );
    }
    if (t.bySource.length > MAX_LINES_PER_LIST) lines.push(`…and ${t.bySource.length - MAX_LINES_PER_LIST} more sources`);
    lines.push("");
    lines.push(`Unique model inputs: ${n(t.uniqueInputs)} of ${n(t.logical)} logical evaluations`);
    return lines.join("\n");
  }

  lines.push(`**Jev stats — ${w.label}**`);
  const coverage =
    w.telemetryStartMs === null
      ? "no telemetry recorded yet"
      : `${fmtZoned(w.effectiveStartMs, w.timezone)} → ${fmtZoned(w.endMs, w.timezone)} ${w.timezone}` +
        (w.partial ? ` (tracking began ${fmtZonedFull(w.telemetryStartMs, w.timezone)})` : "");
  lines.push(`Coverage: ${coverage}`);
  lines.push("");

  lines.push("**API activity**");
  lines.push(`HTTP attempts: **${n(t.attempts)}** · retries: ${n(t.retries)} · in flight/unknown: ${n(t.inFlight)}`);
  lines.push(`Valid responses: **${n(t.validResponses)}** · failed/invalid: ${n(t.terminalFailures)}`);
  lines.push(`Logical evaluations: **${n(t.logical)}** · unique inputs: ${n(t.uniqueInputs)}`);
  lines.push(
    `Cache hits: not enabled · local exclusions: ${n(t.localExclusions)} · evidence deferrals: ${n(t.evidenceDeferred)}`,
  );
  lines.push("");

  lines.push("**Usage**");
  lines.push(`Input tokens: **${n(t.inputTokens)}** · output tokens: **${n(t.outputTokens)}**`);
  const terminal = t.usageReported + t.usageMissing;
  lines.push(`Usage available: ${n(t.usageReported)}/${n(terminal)} terminal attempts`);
  lines.push(`Cost: unavailable — no rates configured · request budget: not configured`);
  lines.push("");

  lines.push("**Evaluation outcomes (window)**");
  lines.push(`Matches: **${n(t.matches)}** · rejected: ${n(t.rejected)} · review-needed: ${n(t.reviewNeeded)}`);
  lines.push(`(${n(t.completedResults)} completed result evaluations; includes cache hits)`);
  lines.push("");

  lines.push("**Current inventory (now, independent of the period)**");
  lines.push(`Open awaiting assessment: ${n(inv.pending)} · missing descriptions: ${n(extras.missingDescription)}`);
  lines.push(`Retry-delayed: ${n(extras.retryDelayed)} · current open matches: ${n(inv.matched)}`);
  lines.push("");

  lines.push(`Latency: p50 ${ms(t.latency.p50)} · p95 ${ms(t.latency.p95)} (${n(t.latency.samples)} samples)`);
  lines.push(
    `Match threshold: ${cfg.fitThreshold}/100 fit · ${Math.round((cfg.fitConfidence ?? 0.8) * 100)}% confidence · all mandatory requirements satisfied`,
  );
  lines.push(
    `Tracking began: ${w.telemetryStartMs === null ? "not started" : fmtZonedFull(w.telemetryStartMs, w.timezone)} · ` +
      `historical usage before tracking is unavailable.`,
  );
  return lines.join("\n");
}

/** Legacy renderer, kept for the existing tests and any caller that wants the snapshot alone. */
export function renderJevStats(stats: ReturnType<typeof jevStats>, cfg: Pick<Config, 'fitThreshold' | 'fitConfidence'>): string {
  const fmt = (value: number) => value.toLocaleString('en-US');
  return [
    '**Jev job stats**',
    `Jobs with a saved Jev evaluation: **${fmt(stats.evaluated)}** / ${fmt(stats.stored)} stored postings`,
    '',
    '**Open jobs · current profile and rules**',
    `Evaluated by Jev: **${fmt(stats.current_evaluated)}**`,
    `Matches: **${fmt(stats.matched)}**`,
    `Filtered out by Jev: **${fmt(stats.current_evaluated - stats.matched)}** (includes uncertain results)`,
    `Excluded by local rules: **${fmt(stats.rule_excluded)}**`,
    `Waiting for evaluation: **${fmt(stats.pending)}** (${fmt(stats.deferred)} waiting for retry)`,
    `Match threshold: ${cfg.fitThreshold}/100 fit · ${Math.round((cfg.fitConfidence ?? 0.8) * 100)}% confidence · all mandatory requirements satisfied`,
    '',
    '_Live database snapshot, not lifetime API calls. Rescores count once per posting; the same job on different boards may count separately. Removed postings leave these counts._',
  ].join('\n');
}
