# Eve: Jev usage diagnostics, optimization, and Discord `/stats` handoff

**Prepared:** 2026-09-23  
**Audience:** Mahesh's implementation partner and their coding agent  
**Repository:** `/run/media/maheshk/New Volume1/MK-solutions/eve`  
**Status:** Implementation specification. The telemetry, cache, and budget features below are proposals, not features already shipped.

## 1. The requested outcome

Eve discovers remote jobs worldwide and jobs in configured geographic areas, checks their fit against Mahesh's profile using TypeSafe's Jev model, and delivers suitable jobs to Discord. Preserve that product behavior and the existing geographic, eligibility, language, and seniority rules unless Mahesh explicitly approves a policy change.

The next implementation must make model usage measurable and visible in the **existing `/stats` Discord command**, eliminate demonstrably redundant inference, and provide bounded spending. The user should be able to answer:

- How many actual Jev HTTP attempts happened today, in the last 24 hours, or since tracking started?
- How many succeeded, failed, timed out, or retried?
- How many input and output tokens did TypeSafe report?
- How many distinct postings and distinct model inputs were evaluated?
- How many jobs matched, were rejected, or need more evidence?
- How many evaluations were served from the cache?
- Is the queue waiting on the model, missing descriptions, retry timers, or budgets?
- What usage is known, estimated, or unavailable?
- Are usage and matching improving over time?

Deliver telemetry and `/stats` first. Do not bundle a silent threshold reduction or a new matching policy into the accounting work. Do not increase the scoring budget to compensate for zero matches.

## 2. Verified baseline and limits of the evidence

These figures were collected during the 2026-09-23 diagnostic session. They are a historical snapshot, **not guaranteed current values** and not a billing report. Reproduce the queries before using them for a before/after comparison.

| Diagnostic | Observed value | Interpretation |
|---|---:|---|
| Stored postings | 7,940 | Includes closed and older postings |
| Postings with a saved Jev answer object | 4,369 | Latest saved result per posting; not all requests ever sent |
| Current-version, open postings with Jev results | 4,347 | Current matching population |
| Current open postings satisfying all mandatory checks | 147 | Does not imply relevance or confidence passes |
| Current open postings with relevance at least 75/100 | 7 | Separate, overlapping subset |
| Current open postings passing combined confidence at least 0.8 | 19 | Minimum confidence across all six answers |
| Current open postings passing all gates | 0 | Needs quality investigation |
| Extra evaluated rows sharing a posting key | 973 | Candidate duplication, not proof of identical input |
| Extra evaluated rows sharing identical model-relevant fields and version | 854 | 19.5% of evaluated rows; strong cache opportunity |
| Pending open postings | 2,404 | Includes deferred and missing-evidence work |
| Pending open postings missing descriptions | 2,403 | Primarily enrichment backlog, not active inference |
| Serialized selected profile | 7,397 characters | Characters, not token count |
| Serialized questions | 3,665 characters | Six questions together |
| Median / p95 description length | 3,555 / 7,208 characters | Across evaluated postings |
| Configured queue selection budget | 100 per cycle | Not a daily request or money cap |
| Scoring concurrency | 3 | Worker count |
| Model | `jev-1.13.0` | Verify actual returned model as well as requested model |

The duplicate-input diagnostic compared title, company, location, remote flag, description, and stored scoring version. Current profile and questions are represented by that version. These duplicate rows suggest avoidable work, but do **not** establish 19.5% of the historical invoice: previous attempts, failures, rescores, provider caching, and billing details were not retained.

The available journal output queried for the preceding 24 hours contained 65 completed-cycle summaries with 1,571 entries counted as `scored`, and no logged `TypeSafe HTTP ...` errors. This is not a complete request ledger. The scoring counter can include locally produced results after description enrichment, retryable statuses are not all logged, and journal coverage must be verified. Do not turn this number into billed API calls.

Latest saved model-result timestamps fell on September 22 and 23 (SQLite dates are UTC). Repeated evaluations overwrite those timestamps. They do not reconstruct the overnight request count.

### 2.1 Quality findings

Among 4,347 current open evaluations:

- 3,791 had `technology: contradicted`.
- 895 had `eligibility: unknown`.
- Only 453 had eligibility confidence at least 0.8.
- Only 19 passed the minimum-confidence gate across all dimensions.

Possible explanations include unsuitable discovered jobs, incomplete candidate evidence, overly strict question wording, model mistakes, and threshold calibration. The counts alone cannot distinguish them. Investigate with labeled examples instead of assuming the model is broken or lowering every threshold.

## 3. Current implementation map

Read the current checkout before editing; another contributor may have changed it.

| File | Current responsibility | Planned work |
|---|---|---|
| `src/jev.ts` | Questions, profile/version construction, HTTP retries, response validation, matching | Instrument actual HTTP attempts; expose usage; split version responsibilities |
| `src/poller.ts` | Discovery, enrichment, local exclusions, bounded scoring workers, notification queueing | Use one shared evaluation service; record logical outcomes and deferrals |
| `src/db.ts` | SQLite open/migration, stored posting results, scoring queue | Add idempotent migrations and transactional accounting helpers |
| `src/schema.sql` | Base schema | New tables/indexes for fresh installations |
| `src/stats.ts` | Current database-snapshot aggregation and text rendering | Add time-window telemetry while retaining current inventory |
| `src/bot.ts` | Slash command registration/dispatch, manual `/fit`, delivery loop | Extend `/stats`; route `/fit` through the same accounted evaluation path |
| `src/config.ts` | Environment parsing and defaults | Validated cap, timezone, and optional pricing settings |
| `src/delivery.ts` | Discord notification delivery | Preserve matching and notification deduplication |
| `src/profile.test.ts` | Jev and profile behavior tests | Regression coverage for instrumented evaluation and caching |
| `src/stats.test.ts` | Existing stats tests | Historical windows, accounting invariants, rendering |
| `src/db-contention.test.ts` | Startup/read behavior under a writer lock | Preserve this protection with new migrations |
| `README.md` | Operator documentation | Explain commands, limits, setup, and accounting semantics |

At handoff time several changes were uncommitted, including `/stats` and the database-contention fix. Preserve them. `measure.tmp.ts` was an unrelated untracked file; do not overwrite or delete it.

### 3.1 Existing behavior to understand

- `scoreJev()` makes one request containing five Choice questions plus one Score question.
- It attempts some failures up to three times and uses a 30-second timeout per attempt.
- Local role-rule failures return an in-process result with `details: "{}"`; they do not call TypeSafe.
- Missing descriptions and oversized descriptions can return without calling TypeSafe.
- `parseJev()` currently retains answers and model but discards provider `usage`.
- `setJevFit()` overwrites the latest result on a posting. It is not a historical event store.
- `jevContext()` hashes the selected profile, model, questions, role labels, role-rule version, and entire discovery-filter configuration.
- Changes to title/location/remote/description invalidate a posting result in `upsertPosting()`.
- Discovery-filter changes can invalidate all model results even when the actual inference inputs are unchanged.
- Threshold changes currently reuse saved inference. Preserve this good behavior.
- Notification deduplication occurs after scoring, so it does not avoid duplicate model work.
- Both polling and manual `/fit` can evaluate jobs. Accounting must cover both paths.
- The existing `/stats` is a current-posting snapshot. It must never be relabeled as a historical request counter.

## 4. Source documentation and verification requirements

Official references checked during diagnostics:

- Index: <https://docs.typesafe.ai/llms.txt>
- HTTP API: <https://docs.typesafe.ai/api>
- Confidence semantics: <https://docs.typesafe.ai/confidence>
- Models: <https://docs.typesafe.ai/models>
- Parallel-question pattern: <https://docs.typesafe.ai/patterns/fan-out>

The API documents `usage.input_tokens` and `usage.output_tokens` in responses. Persist these values when valid. Confidence summarizes the distribution of an answer; it is not the probability that the whole workflow is correct.

Recheck live documentation before implementation. Do not invent token prices, account limits, billable-error behavior, idempotency support, or a provider billing endpoint. This handoff contains no verified current pricing schedule. Confirm Discord command/interaction and message-size limits in current official Discord documentation when implementing the expanded response.

Do not copy API keys, Discord tokens, full profiles, or raw job descriptions into this document, tests, logs, commits, or telemetry exports.

## 5. Accounting vocabulary: settle this before writing counters

Use separate units. Ambiguous counters will recreate the current confusion.

| Unit | Exact meaning |
|---|---|
| Posting | A source-specific database row; the same vacancy can have multiple postings |
| Logical evaluation | One requested assessment of one posting against a fixed input and policy snapshot |
| Unique input | A canonical model-input hash, independent of source row identity |
| HTTP attempt | One invocation of the TypeSafe request transport; includes retries |
| Successful inference | A response with a fully validated answer set |
| Provider-reported tokens | Valid usage values actually present in received responses |
| Cache hit | A logical evaluation fulfilled from an existing validated result, with no new inference request |
| Local exclusion | Code rejected the posting before any model call |
| Evidence deferral | No inference occurred because necessary evidence was unavailable |
| Budget deferral | No inference occurred because the admission budget disallowed it |
| Match | A validated result passing the recorded policy at evaluation time |
| Review-needed | An inference with insufficient/ambiguous evidence or confidence under the chosen reporting policy |
| Confirmed rejection | An inference with a documented disqualifier under the reporting policy |
| In-flight/unknown attempt | Started locally but no terminal response was durably recorded |

A timeout is not a rejection. A 429 is not a filtered job. A missing description is not a model error. A cache hit is not a fresh successful HTTP call.

For phase one, preserve current notification gates. You may add reporting categories such as `review_needed` without changing what reaches Discord. Store independent reason flags; if using mutually exclusive headline categories, document their precedence. Suggested reporting precedence: explicit mandatory contradiction → rejected; otherwise missing evidence or insufficient confidence → review-needed; otherwise relevance below threshold → rejected; otherwise match. Also retain the raw flags so operators can inspect overlapping causes.

## 6. Proposed data model

The schema below is a design contract, not a copy-and-paste replacement for the existing schema. Use additive migrations. Prefer UUID/text IDs generated in application code so retrying a database write does not duplicate an event.

### 6.1 `jev_evaluations`: logical requests

Suggested fields:

```text
id TEXT PRIMARY KEY
posting_id INTEGER NULL
posting_key TEXT NOT NULL
source_kind TEXT NOT NULL
source_ident_hash TEXT NULL
origin TEXT NOT NULL                 -- poller | manual_fit
requested_at_ms INTEGER NOT NULL
completed_at_ms INTEGER NULL
input_hash TEXT NULL                -- absent if no complete model input exists
profile_hash TEXT NOT NULL
inference_version TEXT NOT NULL
policy_version TEXT NOT NULL
requested_model TEXT NOT NULL
result_model TEXT NULL
status TEXT NOT NULL
  -- pending | model_result | cache_hit | local_exclusion |
  -- evidence_deferred | budget_deferred | error | interrupted
outcome TEXT NULL                    -- match | rejected | review_needed
reason_codes_json TEXT NOT NULL     -- controlled codes only
fit_score REAL NULL
confidence REAL NULL
eligible INTEGER NULL
fit_threshold REAL NOT NULL
confidence_threshold REAL NOT NULL
cache_entry_hash TEXT NULL
error_kind TEXT NULL
```

Keep source/posting identifiers sufficient for attribution, but avoid copying title, description, or profile into this ledger. If `posting_id` references postings, use `ON DELETE SET NULL`, not cascade. Historical usage must survive `/unwatch` and posting cleanup. Preserve a source-kind snapshot even if the source disappears.

Write one logical row for a scheduler selection, not one row every time `/stats` scans pending jobs. Repeated evidence deferrals may be recorded per actual attempt to enrich; do not generate millions of rows merely by observing the queue. If using counters for repeated no-work deferrals, specify their aggregation interval.

### 6.2 `jev_attempts`: actual transport attempts

```text
id TEXT PRIMARY KEY
evaluation_id TEXT NOT NULL
attempt_number INTEGER NOT NULL
input_hash TEXT NOT NULL
started_at_ms INTEGER NOT NULL
finished_at_ms INTEGER NULL
duration_ms INTEGER NULL
state TEXT NOT NULL                 -- reserved | started | finished | unknown
http_status INTEGER NULL
outcome TEXT NULL
  -- success | http_error | timeout | transport_error | invalid_response
error_code TEXT NULL                -- sanitized controlled value
retry_after_ms INTEGER NULL
provider_request_id TEXT NULL       -- only if supplied by documented response
requested_model TEXT NOT NULL
returned_model TEXT NULL
input_tokens INTEGER NULL
output_tokens INTEGER NULL
usage_status TEXT NOT NULL          -- reported | missing | invalid
request_bytes INTEGER NOT NULL
profile_chars INTEGER NOT NULL
description_chars INTEGER NOT NULL
questions_chars INTEGER NOT NULL
rate_version TEXT NULL
estimated_cost_microunits INTEGER NULL
UNIQUE(evaluation_id, attempt_number)
```

Use a clearly defined currency unit if storing cost. A generic `cost` float is insufficient. Money estimates should use integer arithmetic or a decimal library and explicit rounding.

`NULL` usage means unknown, not zero. A valid provider usage object must be captured even if answer validation fails. Non-2xx responses may or may not carry usage; record any documented, valid usage without assuming billing semantics.

There is no atomic transaction spanning SQLite and the remote service. A crash after the provider receives a request can leave a locally incomplete row. Document this uncertainty rather than promising exact billing. Request IDs help reconciliation if the provider exposes them; do not fabricate them.

### 6.3 `jev_result_cache`: validated reusable inference

```text
input_hash TEXT PRIMARY KEY
inference_version TEXT NOT NULL
profile_hash TEXT NOT NULL
requested_model TEXT NOT NULL
returned_model TEXT NOT NULL
answers_json TEXT NOT NULL
created_at_ms INTEGER NOT NULL
origin_attempt_id TEXT NULL
expires_at_ms INTEGER NULL
```

Store raw validated answers sufficient to reapply thresholds without inference. Do not cache timeouts, partial responses, invalid JSON, or network errors as successful results. Cache retention is independent from telemetry retention.

### 6.4 Coordination and budget state

For cross-process duplicate suppression, use an input lease table with `input_hash`, owner ID, lease expiry, and creation time. An in-memory Promise map only deduplicates workers inside one process; it does not coordinate `/fit` with the poller.

For budgets, store daily counters/reservations keyed by provider and UTC budget day (or a deliberately selected consistent timezone). Use a short `BEGIN IMMEDIATE` transaction to check the cap and reserve one request slot. Network calls must happen **after commit**.

For tracking boundaries, keep metadata including `telemetry_started_at_ms`, schema version, and earliest retained raw event. Do not reset the tracking start on restart or upgrade.

### 6.5 Indexes

At minimum index attempts by `started_at_ms`, evaluations by `requested_at_ms`, attempts by `evaluation_id`, evaluations by `input_hash`, and cache/lease primary keys. Add source/outcome composite indexes only when actual query plans justify them. Do not scan every historical JSON answer on every `/stats` call.

## 7. Instrumentation flow and failure handling

Create a shared evaluation service, for example `src/jev-service.ts`, used by the poller and `/fit`. Keep pure response parsing and the low-level HTTP adapter in `src/jev.ts` or a clearly separated client module.

Recommended flow:

```text
receive posting + context + policy + origin
  -> re-read/check posting is still valid
  -> record logical evaluation
  -> local rules
       excluded -> record local_exclusion; finish; no HTTP attempt
  -> obtain sufficient description
       unavailable -> evidence_deferred; finish; no HTTP attempt
  -> canonicalize evidence and compute input hash
  -> look up validated cache
       hit -> reapply current policy; record cache_hit; update posting conditionally
  -> acquire cross-process input lease
       another owner -> wait/defer without spending an HTTP attempt
  -> recheck cache after acquiring lease
  -> for each allowed transport attempt:
       reserve request budget + persist attempt intent
       commit DB transaction
       mark attempt started immediately before transport
       call TypeSafe with timeout
       read/validate usage independently of answer validity
       finish attempt accounting
       success -> cache validated answers, record logical outcome,
                  conditionally update posting, release lease
       retryable failure -> respect backoff and budget; next attempt gets its own row
       terminal failure -> record logical error and schedule eligible retry
  -> release lease in finally (with owner check)
```

### 7.1 Preserve result correctness during concurrent changes

If a job description or profile changes while inference is in flight, the response belongs to the old input. Retain its telemetry and cache entry, but do not stamp the newer posting as current with it. Re-read or use a conditional update comparing the expected evidence/version before updating latest-fit columns.

A late response must not overwrite a newer `/fit` result. Both paths must use the same conditional update contract.

### 7.2 Safe telemetry failure semantics

- If the initial reservation/attempt record cannot be durably written, defer inference. Do not spend untracked requests by falling through to fetch.
- If a response arrives but accounting persistence temporarily fails, retry persistence with the **same attempt ID**. Do not resend the model request merely to recover a database write.
- Keep write transactions short and synchronous. Never hold one across `await fetch`, sleep, enrichment, or Discord sends.
- On restart, expired pending attempts become `unknown/interrupted`, not fabricated HTTP failures or zero-token successes.
- Reservations associated with unknown remote outcomes remain conservatively consumed until reconciled or the budget day rolls over.
- An abandoned pre-dispatch reservation can be released only when the system can establish it never reached transport. Otherwise preserve uncertainty.
- Do not claim exactly-once remote inference unless documented provider idempotency actually supports it.

### 7.3 Retry classification

Persist a reason for retries: rate limit, temporary service failure, timeout, network exception, or another explicitly documented category. Keep maximum attempts bounded and apply jittered backoff. Preserve longer `Retry-After` instructions through the persisted schedule rather than blocking the poller.

Do not endlessly retry authentication failures or malformed requests every six hours. Surface a provider/configuration problem and stop that failing category until configuration changes or an explicit operator retry. No automatic model fallback that silently changes cost or matching behavior.

## 8. Cache identity and invalidation

Separate three concepts:

1. **Inference version:** model, question definitions, profile evidence, preferred roles supplied to the model, and request-normalization version.
2. **Evidence/input hash:** inference version plus the exact canonical job fields sent to the model.
3. **Policy/discovery version:** geographic rules, local exclusions, delivery eligibility rules, and thresholds.

Changing a display threshold or discovery-source list should not cause another model request when inference inputs are identical. Re-run local rules and recompute outcomes from saved answers.

Use stable recursive key ordering before hashing structured objects. Normalize only meaning-preserving differences such as line endings and explicitly understood HTML extraction artifacts. Do not erase numbers, negations, country restrictions, language requirements, or work-authorization details to improve cache hit rates.

An input hash should include:

```text
normalization version
requested model / resolved model policy
canonical question definitions
selected candidate evidence
preferred role labels actually supplied
job title, company, location, remote flag, full usable description
```

Do not include source row ID or tracking URL unless that information is actually part of the judgment. Do not use only the existing posting key: it may combine postings with different descriptions or restrictions.

Pinning a model version makes cache semantics clearer. If using a moving alias, define model-resolution and cache-expiry behavior explicitly. Never assume an alias is unchanged forever.

For simultaneous identical inputs, only the lease owner spends inference. Other callers should reuse its result or remain deferred. They should not all retry at lease expiry without an atomic new ownership claim. Size leases above normal call/retry duration or renew them safely; release with an owner comparison so an old worker cannot release a replacement worker's lease.

## 9. `/stats` specification: make the accounting visible

Extend the existing command; do not require a second bot or a dashboard to see the essentials.

### 9.1 Command shape

Suggested options:

```text
/stats
/stats period:today
/stats period:24h
/stats period:7d
/stats period:all
/stats period:24h view:errors
/stats period:24h view:sources
```

Default to `period:24h`, `view:summary`. Label `all` as **since tracking began**, not lifetime. If raw data has been pruned, report the retained coverage or use durable daily aggregates for the older period.

Use an enumerated choice list, not arbitrary SQL-like user input. Bind all SQL parameters.

### 9.2 Time-window semantics

- Store epoch milliseconds or one consistent UTC timestamp format.
- `24h`: rolling 24 hours ending at one captured `asOf` instant.
- `7d`: rolling seven days ending at that instant.
- `today`: midnight in `Europe/Berlin` to `asOf`, unless configured otherwise.
- `all`: telemetry start to `asOf`, subject to retention coverage.
- Use half-open intervals `[start, end)` throughout.
- Berlin calendar days around daylight-saving transitions can contain 23 or 25 hours. Do not implement local midnight by subtracting a fixed UTC offset.
- Display timezone and explicit boundaries, at least in the footer/details.
- Clamp the effective start to the telemetry start and label partial coverage. Do not show the untracked part of today as zero usage.

Attribute HTTP attempts to their start timestamp. An attempt started before the window and finished inside it remains in the earlier start window. Explain that token totals for a start window may increase when in-flight requests finish. Attribute logical evaluations consistently to requested time; keep this distinct from attempt counts.

Capture query results in one short read snapshot where necessary, then close it before formatting/sending to Discord. Do not hold a read transaction through network operations.

### 9.3 Example response (illustrative values, not real usage)

```text
Jev stats — last 24 hours
Coverage: 23 Sep 14:00–16:00 Europe/Berlin (tracking began 2h ago)

API activity
HTTP attempts: 240 | retries: 18 | in flight/unknown: 2
Valid responses: 215 | failed/invalid: 23
Logical evaluations: 300 | unique inputs: 260
Cache hits: 60 | local exclusions: 40 (outside the 300 inference evaluations)

Usage
Input tokens: 720,000 | output tokens: 18,000
Usage available: 218/238 terminal attempts
Estimated reported-usage cost: unavailable — rates not configured
Request budget today: 240/500 | remaining slots: 260

Evaluation outcomes in this window
Matches: 8 | rejected: 190 | review-needed: 77
(275 completed result evaluations; includes cache hits)

Current inventory — now, independent of selected period
Open jobs awaiting assessment: 2,404
Missing descriptions: 2,403 | ready evidence: 1
Retry-delayed: 2,171 (overlaps those evidence categories)
Current open matches: 8

Latency: p50 420ms | p95 1,100ms
Telemetry began: 23 Sep 2026 14:00 Europe/Berlin
Historical usage before tracking: unavailable
```

The example deliberately distinguishes overlapping dimensions. Its logical count convention excludes local/evidence/budget exclusions from the displayed “inference evaluations” subtotal even though the ledger stores them. Implementers must choose and document one convention; do not present numbers that appear to sum when they do not. Prefer explicit parenthetical subtotals or separate fields.

To simplify the implementation, the summary may instead show total logical selections and a mutually exclusive breakdown by terminal status. Whichever presentation is selected, include a test asserting reconciliation from fixtures.

### 9.4 Required summary fields

The first shipped telemetry release must expose:

- Selected time range and actual tracked coverage.
- Attempt count, retry count, successes, failures, and in-flight/unknown count.
- Provider-reported input/output tokens and missing-usage count.
- Cache hits once caching exists; show “not enabled” before that phase, not a misleading zero saving claim.
- Logical-result match/rejection/review counts.
- Current pending inventory and missing-description count.
- Budget state once budgets exist; show “not configured” otherwise.
- Telemetry start and a clear historical-data disclaimer.

Additional views can show status-code/error breakdown, origin (poller/manual), source attribution, model version, and latency percentiles. A raw provider error body does not belong in Discord.

### 9.5 Metric formulas

```text
attempts = count of started HTTP attempt rows in the start-time window
retries = count where attempt_number > 1 among those rows
valid responses = count where outcome = success
terminal failures = count of terminal outcomes other than success
in flight/unknown = started attempts without a confirmed terminal outcome
reported input tokens = sum(non-null validated input_tokens)
reported output tokens = sum(non-null validated output_tokens)
missing usage = terminal attempts with usage_status != reported
unique inputs = count(distinct non-null input_hash) in the chosen logical window
cache hit rate = cache hits / (cache hits + logical evaluations requiring HTTP)
```

Treat a zero denominator as `—`/not applicable. Explain whether a cached caller that waited on a lease is a cache hit; recommended: yes, because it incurred no separate inference.

Compute p50/p95 over completed attempt durations with a documented percentile convention, not over logical evaluations that include cache hits. Exclude unresolved attempts and show sample count in detailed output.

### 9.6 Discord reliability requirements

The bot recently failed to respond because startup took an unnecessary SQLite writer lock. Preserve the fix that skips a role-migration write transaction when there are no stale rows. The bot currently opens SQLite with a short busy timeout to avoid blocking its event loop.

- Acknowledge/defer the interaction immediately, inside error handling.
- Run no model requests from `/stats`.
- Keep aggregation bounded and indexed.
- If storage is busy, return a clear temporary error after deferral; never silently swallow it.
- Catch acknowledgement failures without causing an unhandled rejection.
- Keep the response within current Discord limits; use multiple bounded embeds or a details view instead of truncating essential warnings.
- Disable unwanted mentions in generated content.
- Re-register slash commands when adding options; restarting alone does not update command definitions.
- Verify a Discord-ready log after restart. A systemd `active` state alone is not sufficient.

## 10. Usage caps and cost reporting

Start with a daily HTTP-attempt cap because it is enforceable before a request and independent of unknown token usage. Every retry and manual `/fit` must consume the same shared budget. Cache hits and local exclusions do not.

Suggested configuration names (new, proposed):

```text
RADAR_JEV_DAILY_REQUEST_LIMIT
RADAR_JEV_DAILY_INPUT_TOKEN_LIMIT
RADAR_JEV_DAILY_OUTPUT_TOKEN_LIMIT
RADAR_STATS_TIMEZONE=Europe/Berlin
RADAR_JEV_TELEMETRY_RETENTION_DAYS
```

Reject invalid/negative/non-integer request limits. Define `0` explicitly: recommended “disable fresh inference,” not “unlimited.” Represent unlimited with an absent setting or an explicit named value, and display that clearly.

A token threshold checked after a response is a **soft threshold**: the last request and concurrently in-flight requests can overshoot it. A hard pre-request token cap requires a documented tokenizer/upper bound and reservations, which this handoff does not assume. Do not advertise a strict dollar cap based on a character-to-token estimate.

If optional pricing is added:

- Configure verified input/output rates, currency, model, and effective date.
- Preserve the rate version applied to an attempt.
- Distinguish estimated cost from provider invoice totals.
- Show unknown cost when rates or usage are missing.
- Do not count an unknown timeout as free.
- Do not invent cache-discount behavior or include it without documented provider usage fields.

Budget exhaustion should defer scoring until the next budget window while allowing scraping, stats, and cache reuse to continue. Do not turn every pending job into an error or repeatedly visit it on each poll without a meaningful next-eligible timestamp.

## 11. Reduce payload only after measurement

The current profile includes `resume`, `work_eligibility`, and `application_answers`. Relevant candidate evidence must remain intact. Application-answer keys such as `how_did_you_hear`, `pronouns`, `why_this_company`, and generic cover-letter text are candidates for removal from the matching representation.

Create a dedicated matching-profile projection rather than modifying the shared profile file used by other applications. Preserve skills, projects, actual experience, education, spoken languages, work authorization, sponsorship needs, and relevant availability constraints. Do not infer missing authorization from location preferences.

Measure byte/character reduction, provider tokens, decision stability, and false negatives on a labeled fixture set. Minifying JSON alone is not a substitute for selecting relevant evidence. Do not blindly truncate descriptions; decisive constraints may appear near the end.

Keep the six independent questions batched initially. A two-stage relevance-first classifier may reduce work on unsuitable jobs, but it introduces another request for survivors and can lose good candidates. Treat it as a later measured experiment. Compare total tokens, latency, precision, and recall against the existing batched approach before adopting it.

## 12. Calibration and quality evaluation

Build a small private benchmark of 30–50 representative postings. Include clear matches, clear mismatches, unfamiliar-but-relevant titles, sparse descriptions, uncertain authorization, language restrictions, degree mismatches, and cross-board duplicates.

For each example, record a human label and evidence supporting it. Allow “insufficient information” as a real label. Split examples into a tuning set and a holdout set; do not tune and claim success on the same examples.

Evaluate:

- Match precision: of jobs sent as matches, how many are genuinely useful?
- Match recall: of labeled suitable jobs, how many survive the system?
- Review-needed fraction and dominant missing-evidence reasons.
- Per-dimension disagreement with human labels.
- Differences caused by threshold versus evidence/question changes.
- Tokens and latency per useful surfaced job, when there are useful surfaced jobs.

Do not divide by zero when no matches occur; report cost-per-useful-match as unavailable. Do not assert a confidence of 0.8 means 80% precision. Do not automatically approve uncertain authorization to improve headline recall.

Any production threshold/question change should include a before/after report and Mahesh's explicit policy decision. This handoff authorizes a specification, not an automatic change to whom the bot recommends.

## 13. Migration and historical-data policy

1. Back up the live SQLite database using SQLite's backup mechanism or a coordinated stopped-service procedure. A raw copy of only the `.db` file while WAL writers are active can omit recent data.
2. Add telemetry tables and indexes idempotently.
3. Create the tracking-start marker once.
4. Leave old posting results available for the existing inventory snapshot.
5. Do **not** create fake attempt rows from old `fit_scored_at` timestamps.
6. If importing a historical baseline, store it separately and label it “latest saved results before tracking.” It contains no verified token or request counts.
7. Do not invalidate every fit result merely because telemetry was introduced.
8. Cache seeding from old results is optional and requires proof of exact compatible input identity. If that proof is unavailable, leave old results in place and populate the cache from new evaluations.
9. Never erase historical usage when a source is unwatched or a posting is deleted.

For retention, a practical initial proposal is 90 days of raw attempts with daily aggregates retained longer. This is a design choice, not an existing requirement. Aggregates must retain unknown-usage counts and model/rate attribution. Do not promise exact arbitrary rolling windows outside raw retention unless the aggregate resolution supports them; label coverage or restrict available periods.

## 14. Implementation order and independently reviewable milestones

### Milestone A — Accounting plus `/stats` (ship first)

- Add attempts/evaluations/metadata migrations.
- Capture provider usage independently of answer validation.
- Instrument both poller and manual `/fit` through one service.
- Retain current matching behavior and latest-posting snapshot.
- Add `/stats` period selection, coverage, requests, retries, failures, tokens, and outcomes.
- Add controlled-error categories and in-flight/unknown recovery.
- Acceptance: mocked scenarios reconcile exactly; restart preserves counts; stats makes zero provider calls.

### Milestone B — Shared result cache

- Add canonical input hashing, validated-result storage, and leases.
- Reuse identical inputs across source rows and processes.
- Separate inference identity from discovery and delivery policy.
- Acceptance: concurrent poller/manual requests for identical input produce one inference and correct individual posting results.

### Milestone C — Budgets

- Add atomic daily request reservation and visible budget state.
- Count retries and manual calls; allow cache hits after exhaustion.
- Add optional soft token thresholds and accurately labeled cost estimates.
- Acceptance: concurrent workers cannot exceed the configured request admission cap.

### Milestone D — Evidence and quality improvements

- Build labeled examples and inspect zero-match causes.
- Project a smaller matching profile without losing relevant evidence.
- Fix missing-description handling in a separately scoped change.
- Consider staged inference only if measured results justify it.
- Acceptance: benchmark report includes quality and usage tradeoffs; no unapproved notification-policy changes.

Avoid introducing Redis, a separate analytics service, a new web dashboard, or a distributed task platform for this single-machine installation. SQLite plus careful transactions and indexed queries is sufficient for the proposed first implementation.

## 15. Required tests

Use injected transport and a fake clock. No real API key or live Jev calls in automated tests.

| Scenario | Required assertion |
|---|---|
| Successful response with usage | One logical result, one attempt, exact reported token values |
| 429 then success | Two attempts, one retry, one logical result; statuses retained |
| Timeout after dispatch | Attempt recorded with unknown/missing usage; never treated as rejection |
| HTTP 200 with invalid answer schema and valid usage | Invalid-response outcome; usage still counted |
| Missing or malformed usage | Explicit unknown/invalid usage; no invented zeros |
| Local rule exclusion | No transport invocation, no HTTP attempt |
| Missing description | Evidence deferral; no transport invocation |
| Oversized description | Controlled reason, no transport invocation |
| Same posting evaluated twice | Two logical requests; second may be cached; inventory still one posting |
| Same exact input on two sources | Shared cache; no second inference |
| Same posting key but different restrictions | Different input hashes, no unsafe cache reuse |
| Three workers request the same input | One lease owner; one inference |
| Poller and `/fit` race | Cross-process protection works |
| Changed threshold | Recompute result; no inference invalidation |
| Changed source discovery filters | Reapply local policy; reuse unchanged inference |
| Changed profile/questions/model/evidence | Correct cache miss |
| Profile/job changes during fetch | Old response cannot mark new evidence current |
| Persistence fails after response | Retry same accounting write; do not issue another model request |
| Process stops mid-attempt | Recovery reports unknown/interrupted, not zero cost |
| Request cap almost exhausted with concurrent workers | Atomic admission never exceeds cap |
| Retry occurs at cap | Retry denied/deferred; attempt count remains correct |
| Manual `/fit` at cap | No bypass |
| Cache hit at cap | Still usable with zero new request slots |
| Today around Berlin DST changes | Correct local-day boundaries |
| Attempts cross window boundaries | Consistent start-time attribution |
| Tracking started halfway through today | Partial coverage displayed |
| Source/posting deleted | Usage history remains |
| Empty database or zero denominator | Readable zeros/unknown, no NaN/Infinity |
| Large counts and long error breakdown | Response stays within Discord limits |
| Read under another writer lock | Stats remains responsive or gives handled temporary failure |
| Current DB opened without migration work | No unnecessary startup writer transaction |
| Repeated migration invocation | Idempotent; tracking start unchanged |

Run `npm run typecheck`, scoped tests while developing, then `npm test` before delivery. Apply the local code-health skill if available. Preserve existing tests, including stats persistence and database-contention regressions.

## 16. Rollout and operational verification

This is a local NANI deployment, not a VPS. The project sits on an NTFS-mounted volume. Do not change filesystem placement or services unrelated to Eve as part of this work.

Known units:

```text
eve-bot.service
eve-dashboard.service
eve-poll.service
eve-poll.timer
```

Implementation partner checklist:

1. Inspect `git status`, current instructions, unit definitions, and actual configuration without printing secrets.
2. Record a before-change inventory snapshot and migration backup.
3. Complete code/tests before modifying live services.
4. Coordinate a short pause of the poll timer and any active poll if migration requires it; remember a timer stop alone does not stop an already-running oneshot.
5. Apply the migration once and verify idempotence.
6. Register the updated command options using the repository's existing registration path, with the environment loaded locally.
7. Restart affected Eve services and restore the timer's original enabled/active state.
8. Verify the bot logs `ready as ...`; inspect for startup exceptions.
9. Have Mahesh invoke `/stats`, then `/stats period:today` and `/stats period:all`.
10. Observe one naturally occurring scoring cycle. Avoid artificial spending merely to demonstrate telemetry.
11. Verify counts across restart, and verify a cache hit with a controlled mocked test or an authorized natural duplicate.
12. Check request-budget behavior with injected transport before enabling a live cap.
13. Review logs for lock contention, duplicate notifications, and unhandled interaction errors.

Example existing commands (verify paths and scripts before execution):

```sh
npm run typecheck
npm test
node --env-file=.env src/bot.ts --register
systemctl --user restart eve-bot.service
systemctl --user is-active eve-bot.service
journalctl --user -u eve-bot.service --since '5 minutes ago' --no-pager
```

Do not put secrets into command-line arguments or paste `.env` contents. Do not restart logind, the display manager, or unrelated network services.

### Rollback

Keep additive telemetry tables intact when rolling back application code, unless a verified migration defect requires restoring the database backup. Disable new inference admission if accounting correctness is uncertain; preserve scraping and cache reads where safe. Record the interruption interval so `/stats` does not suggest complete telemetry coverage. Never reset counters to make a failed rollout look clean.

## 17. Acceptance checklist for Mahesh

The implementation is complete when all of these are true:

- [ ] `/stats` clearly separates selected-period activity from current job inventory.
- [ ] Requests, retries, successes, failures, tokens, and missing usage are visible in Discord.
- [ ] The tracking start and any partial coverage are visible.
- [ ] Poller and manual `/fit` use the same accounting and budget paths.
- [ ] Local exclusions and missing descriptions never count as model calls.
- [ ] Stats never invokes Jev.
- [ ] Identical model inputs can share a result across sources and processes.
- [ ] Threshold/discovery-only changes do not unnecessarily rerun inference.
- [ ] Historical accounting survives source deletion and restarts.
- [ ] Unknown remote outcomes remain visibly unknown.
- [ ] Request caps are atomic and token/cost thresholds are honestly labeled.
- [ ] Current matching rules remain unchanged unless separately approved.
- [ ] Tests pass, commands are registered, and the bot is confirmed connected.
- [ ] The handover includes changed files, validation results, migration/rollback notes, and remaining limitations.

## 18. Copyable instruction for the implementation partner

> Read this handoff and the current Eve repository before editing. Implement Milestone A first: durable Jev request/outcome/token telemetry and its presentation through the existing Discord `/stats` command. Preserve current matching policy, existing uncommitted work, and the database-contention fix. Use a single evaluation path for the poller and manual `/fit`; capture provider usage independently of answer validation; do not fabricate historical requests or token totals. Then implement shared exact-input caching and atomic daily request budgets as separately reviewable milestones. Use mocked provider responses for tests, never expose credentials, and do not make live model calls merely to test the feature. Deliver tests, migrations, registration/rollout steps, and clear evidence that the bot is connected and `/stats` reports tracked time windows honestly. Treat quality calibration and threshold changes as a separate decision supported by labeled examples.
