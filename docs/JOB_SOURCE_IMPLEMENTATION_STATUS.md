# Job-source expansion: implementation status

**Implemented:** 22 September 2026. **Scope:** Phase 0 (shared transport and
scheduling) plus the Phase 1 feed batch from
[JOB_SOURCE_IMPLEMENTATION_HANDOFF.md](JOB_SOURCE_IMPLEMENTATION_HANDOFF.md).
Phases 2–4 and work packages D–G remain open; nothing here registers a source in
the live database.

## What changed

| Area | Files | What it does now |
|---|---|---|
| Bounded HTTP | `src/http.ts` | Per-domain concurrency caps, byte limits enforced while reading, conditional ETag/Last-Modified requests, hop-by-hop redirect validation (no credentials, no private/link-local hosts, caller allowlist), Retry-After parsing, bounded jittered retries, and a failure taxonomy: `blocked` / `http` / `network` / `oversized` / `redirect` / `malformed`. HTML at a JSON endpoint is `malformed`, never "zero jobs". |
| Domain cooldown | `src/db.ts`, `src/schema.sql`, `src/poller.ts` | A 429/403 records `domain_state.next_attempt_at`; every source whose adapter reports that domain is skipped until it expires. Applies to LinkedIn, Indeed, StepStone, XING, Bundesagentur and every new feed. Other domains keep polling. |
| Source backoff | `sources.next_attempt_at` | A throwing source is deferred (5m, 10m, 20m … capped at 6h by consecutive failures) instead of being retried every cycle. At `maxFailures` it is marked muted but still probed on that capped backoff, so a temporary outage recovers on its own; a success clears both the backoff and `fail_count`. Guard refusals defer by the first backoff step (one cycle). |
| Resumable discovery | `sources.cursor`, `FetchResult.cursor` | Adapters that walk paginated feeds can persist opaque state between polls. The poller stores it verbatim and never interprets it; `null` clears it. Himalayas uses it for its head-watermark + background walk. |
| Fair scoring queue | `src/db.ts` | `listUnscoredPostings(version)` splits the budget roughly 70% newest / 20% oldest waiting / 10% due retries, with at least one slot per bucket. Newest-first alone starves old work under continuous arrivals. |
| RSS parsing | `src/sources/rss.ts` | Shared RSS/Atom parser on `fast-xml-parser` (pinned 5.11.1): namespaces, `content:encoded`, CDATA, single-vs-array items, numeric character references, item-count cap (5,000), DOCTYPE refused outright, entity expansion bounded. |
| New adapters | `src/sources/{weworkremotely,remoteok,workingnomads,himalayas,arbeitnow}.ts` | See the evidence table below. All declare `complete: false`. |
| Config and hygiene | `config/boards.example.json`, `.gitignore` | Example refs for the validated feeds; `.env.*` backups are ignored (`.env.example` stays tracked). |

Tests: `npm test` (334 passing) and `npm run typecheck` are the gate.
`src/http.test.ts`, `src/feeds.test.ts` and `src/scheduling.test.ts` contain the
acceptance cases from handoff §12; no test touches the network or the live
database.

## Source release evidence

All observations were taken 2026‑09‑22 from the research files in
`docs/research/` and re-validated by a read-only smoke fetch; fixtures are
sanitized excerpts in `src/feeds.test.ts`.

| Source | Endpoint | Identity | Dates | Description coverage | Pagination | Cadence | Attribution / limitations |
|---|---|---|---|---|---|---|---|
| We Work Remotely | `weworkremotely.com/remote-jobs.rss` | `guid` | `pubDate` (RFC 2822) | full HTML in `description` (82/82) | single feed, 82 items | 30 min, ETag | footer credit + WWR link; rolling window, not an inventory. `type`/`skills` preserved in the parser but not yet stored (no column). |
| Remote OK | `remoteok.com/api` | `id` | `date`, else `epoch` | full HTML (99/99) | 100-element array, metadata row skipped structurally | 60 min | footer credit + listing URL; `apply_url` used only when `url` is absent. Salary fields deliberately unmapped (no column). |
| Working Nomads | `workingnomads.com/api/exposed_jobs/` | source URL (no provider ID) | `pub_date` with offset | full HTML (56/56) | 56-element array, no total | 60 min | footer credit; `tags` not stored. |
| Himalayas | `himalayas.app/jobs/api?limit=20` | `guid` | `pubDate` seconds (ISO/ms also accepted) | full HTML (200/200) | head walk to the previous watermark (fresh) + resumable background walk (500 jobs/day); repeated cursors detected | daily | hiring-country and UTC-offset restrictions kept, missing/malformed lists stay unknown; no deep-walk starvation, no head-only blind spot |
| Arbeitnow DE | `arbeitnow.com/api/job-board-api` | `slug` | `created_at` epoch seconds | full HTML (800/800) | `links.next`, 5 pages / 800 jobs per poll, next host validated | 60 min | credit + original link; blank locations stay unknown (the board carries non-German jobs). |
| Arbeitnow UK | `arbeitnow.co.uk/api/job-board-api` | `slug` | `created_at` epoch seconds | full HTML (500/500) | `links.next`, 5 pages / 500 jobs per poll | 60 min | blank locations stay null — a UK board listing is not a stated UK location, so blank non-remote rows are dropped rather than guessed. |

Filtered yield on the live profile rules (one dry-run cycle, no writes to the
live DB): WWR 25/82, Remote OK 54/99, Working Nomads 10/56, Himalayas 34/200,
Arbeitnow DE 290/800, Arbeitnow UK 212/500, Remotive 5/18. These are window
snapshots, not quotas.

## Deliberately not implemented

| Handoff item | Status | Why |
|---|---|---|
| Phase 2 (RemoteFirstJobs, 4dayweek, specialist RSS, registered Muse) | deferred | Needs a source-specific decision on category feeds and Muse app registration; the shared RSS parser and adapter contract are ready for it. |
| Phase 3 (HTML boards) | deferred | Each needs the §7 reverse-engineering record and a detail contract; none should be built from a 200 response alone. |
| Phase 4 (blocked sites, marketplaces) | deferred | Access-dependent (Upwork API approval, Glassdoor/CareerBuilder/SimplyHired partner routes, FlexJobs/Remote.co timeouts). |
| Employer ATS tenant growth (work package D) | partial | Existing Greenhouse/Lever/Ashby adapters are unchanged; tenant discovery from source records and the canonical-identity tables (§8.1/8.2) are not built yet. |
| Separate scoring worker (work package E) | not built | Fair queue selection landed; the process split, leases and token metrics are still open. Until then, scoring remains after the fetch loop in `runCycle`. |
| Canonical job identity and observation records (§8.1) | not built | The proposed `canonical_jobs` migration and the richer `SourceObservation` fields (salary, employment type, raw restriction text) need the cross-source dedupe policy first. |
| Repost/reopen alert policy, suppression counters, unknown-review scheduling (§11) | not built | Explicitly listed as audit work in the handoff; no policy was invented here. |

## Operating notes

- Register sources from `config/boards.example.json` (or a copy) with
  `node scripts/seed-boards.ts <file> --dry-run` first; seeding is silent and
  builds the baseline the next poll diffs against.
- New feeds never close postings: an absence from a feed is not a closure, so
  no mass-delist guard interaction and no false `vanished_while_claimed`.
- `RADAR_DB` must point at a test database when experimenting; the live
  `eve.db` was not touched by this work.
