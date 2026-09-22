# eve — project handout

*Status as of 2026-09-06. Repo: github.com/MaheshBhushan/eve, MIT.*

## One-line summary

eve is a live job-feed aggregator. It polls company job boards and job-search sites every 5 minutes, dedupes postings across sources, and surfaces every new posting on a web dashboard and (optionally) in a Discord channel the moment it is found.

## The problem it solves

Applying early matters for working-student and internship roles in Germany. Job boards only show a snapshot of what is open right now. They offer no "what changed" feed and no closure notice. eve turns those snapshots into a change stream: opened, closed, reposted, fresh, high-fit, deadline approaching.

## Architecture

Three processes share one SQLite file (`eve.db`, via built-in `node:sqlite`).

| Process | Lifetime | Role |
|---|---|---|
| poller | one-shot, systemd timer every 5 min | fetch each source, diff against storage, filter, score fit, queue events |
| dashboard | long-lived HTTP server on :8787 | live feed over Server-Sent Events, read-only on the DB |
| bot | long-lived Discord gateway client, optional | drains the event queue, serves slash commands |

The split means a Discord outage loses nothing (events sit in the queue) and a poller crash never takes the dashboard or bot down.

## Key design ideas

- **Absence is the close event.** A posting missing from the next snapshot is treated as closed. This makes snapshot completeness safety-critical.
- **Mass-delist guard.** A cycle that would close more than half of a board's open postings is refused and counted as a failure. A truncated fetch looks identical to a company closing every role.
- **Synthesised identity.** No board gives a stable id across reposts. Identity is `sha256(company ∥ title ∥ location)` after normalising titles, cities, remote flavours and legal suffixes. This is what makes repost detection possible.
- **Complete vs. incomplete sources.** Employer APIs (Greenhouse, Lever, Ashby, Personio, SmartRecruiters, Workday, SuccessFactors) are complete snapshots. Search scrapers (LinkedIn, StepStone, XING, Indeed) declare `complete: false`, so their absences never close anything.
- **Filters run before storage.** Irrelevant postings are never stored and never cost LLM budget. Changing the filter triggers a one-cycle re-baseline instead of mass-closing.
- **Fit scoring via the claude CLI.** New postings are scored 0–100 against a profile.json owned by the sibling job-pipeline repo. Capped at 25 scorings per cycle. Personal identity fields never enter the prompt.
- **No evasion, by policy.** Scrapers use plain HTTP, page 1 only, no proxies or CAPTCHA solving. A block mutes the source after 5 consecutive failures.

## Sources supported

13 adapters: greenhouse, lever, ashby, personio, smartrecruiters, workday, successfactors, arbeitsagentur (Bundesagentur für Arbeit), stepstone, indeed, xing, linkedin, plus an opt-in browser-use fallback. Arbeitsagentur is by far the highest-yield source for German student roles.

## Tech stack

Node 26+ running TypeScript directly (native type stripping, no build step), `node:sqlite`, discord.js 14. One runtime dependency. About 10,000 lines of TypeScript plus one Python helper.

## Current live state on NANI

| Metric | Value |
|---|---|
| Sources tracked | 67 |
| Postings stored / open | 2,368 / 2,193 |
| Events generated | 2,321 (1,731 opened, 363 fresh, 198 closed, 23 reposted, 6 deadline) |
| Undelivered events | 0 |
| Muted sources (5+ failures) | 10 |
| Tests | 213 passing, no network |
| Services | dashboard, poll timer, bot all active |

Muted sources worth noting: all 7 Arbeitsagentur searches are muted. Since that is the highest-yield source, this is the main open issue. Also muted: ashby:proxima-fusion, greenhouse:flix, and one XING search. An earlier note records the BA API returning 403 since 2026-08-03.

## Timeline

- 2026-07-30: scaffold, storage contract, identity, diff and the four alerts, all in one day.
- August: source adapters expanded from 3 to 13, filters, dashboard, seeding scripts.
- 2026-09-02: last commit. Cloudflare Tunnel hosting was added then reverted in favour of tailnet-only access.
- 33 commits total, single author.

## How to run

```bash
npm install
cp .env.example .env        # tokens, RADAR_* settings
npm run poll                # one poll cycle
npm run dashboard           # http://127.0.0.1:8787
npm run register && npm run bot   # optional Discord side
npm test
```

Deployment is via user systemd units in `deploy/`. Enable linger so they survive logout.

## Known limitations

- Dashboard has no authentication. Keep it on loopback or the tailnet.
- Search scrapers only read page 1 and may breach site terms of service.
- XING's publish date is really `refreshedAt`, so re-boosted old listings look fresh.
- Changing the identity function invalidates every stored key. The fix is to delete the DB and re-seed.
- Seniority synonyms, multi-city postings and cross-language titles are not merged.

## Related repos

- job-pipeline: owns `profile.json` used for fit scoring.
- oasis (issue-radar): the GitHub-issue sibling with the same poller/bot split.
