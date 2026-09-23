<h1 align="center">eve</h1>
<p align="center">A live job feed aggregator: it polls company boards and job searches, dedupes, and shows every new posting on one page the moment it is found.</p>

<p align="center">
  <img alt="Node 26+" src="https://img.shields.io/badge/node-%E2%89%A526-5FA04E?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="discord.js 14" src="https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white">
  <img alt="SQLite via node:sqlite" src="https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-lightgrey">
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="#what-it-does">What</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#configuration">Config</a> ·
  <a href="#deployment">Deploy</a> ·
  <a href="#api-behaviour-worth-knowing">Gotchas</a>
</p>

<!-- HERO: replace with a GIF of a high_fit alert landing in the channel -->

## What it does

You `/watch greenhouse:stripe`. From then on, new postings, closures, reposts and high-fit matches arrive in one Discord channel on their own.

This is the sibling of [issue-radar](https://github.com/MaheshBhushan/oasis), and the same two-process split exists for the same reasons — but the data source inverts the whole design. GitHub serves a *delta*: "what changed since T", and silence means nothing happened. A job board serves a **full snapshot** of what is open right now — no cursor, no timeline, no "closed" notification. So a posting's **absence from the snapshot is the close event**, the diff is a set-difference against everything stored rather than a field comparison against what arrived, and snapshot completeness becomes safety-critical: a truncated fetch is indistinguishable from a company closing every req it has, and acting on it would wipe the claims and alerts the bot exists to raise. Most of the defensive code in this repo exists for that one reason (see the mass-delist guard, below).

Three processes share one SQLite file:

- **poller** — one-shot, run by a systemd timer. Fetches each board, diffs it against storage, scores fit, queues events. Never talks to Discord.
- **dashboard** — long-lived HTTP server. Serves the live feed (below) straight from the database. Needs no Discord credentials.
- **bot** — long-lived gateway client, optional. Drains the queue, serves slash commands. Never talks to a job board except to validate a `/watch`.

Split so a Discord outage cannot lose events — they sit in the queue and drain on reconnect — and a poller crash cannot take the gateway down. Events are only marked delivered after Discord confirms.

## Live dashboard

```bash
npm run dashboard          # http://127.0.0.1:8787
```

One page, newest discovery first. Each card shows title, company, location, the source it came from, when the board says it was posted (only when the board actually stated a date), and when eve first saw it. Postings found in the last hour carry a **NEW** badge. The page holds a Server-Sent Events connection and re-renders itself within a few seconds of the poller writing new rows, so it can stay open all day without a refresh.

`first_seen` is the field that matters here. `posted_at` is whatever the board claims, and many boards only give a relative "3 days ago" or nothing at all; `first_seen` is the moment eve actually discovered the posting, which is what decides whether you were early.

The dashboard binds to loopback by default (`RADAR_DASHBOARD_BIND`, `RADAR_DASHBOARD_PORT`) and has no authentication. To reach it from another machine, expose it over your tailnet (`tailscale serve`) rather than binding to a public interface.

## Quickstart

Requires **Node 26+**. It runs the TypeScript directly via native type stripping and uses the built-in `node:sqlite`, so there is no build step and no native dependency to compile.

```bash
git clone https://github.com/MaheshBhushan/eve.git eve
cd eve
npm install
cp .env.example .env      # fill in tokens, see Configuration
npm run register          # publish slash commands (once)
npm run bot                # expect: [bot] ready as <name>
```

Then in Discord: `/watch greenhouse:stripe`.

> [!IMPORTANT]
> Invite the bot with **both** the `bot` and `applications.commands` scopes, or the slash commands never appear. It also needs **Read Message History** — without it the bot cannot fetch its own embeds to edit, and every update reposts instead.
>
> `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=84992`

Run the poller once by hand to see a board seeded and diffed before wiring up the timer:

```bash
npm run poll
```

## Commands

| Command | What it does |
|---|---|
| `/watch <board>` | Start tracking. `greenhouse:stripe`, `personio:pitch`, `arbeitsagentur:werkstudent@berlin+25`, or a board URL. Seeds the board silently first — see below. |
| `/unwatch <board>` | Stop tracking and forget its postings. |
| `/boards` | Every tracked board, its open count, and poll health (`ok`, `never polled`, failing, or `MUTED`). |
| `/stats [period] [view]` | Jev usage and outcomes for `24h` (default), `today`, `7d` or `all`, in `summary`, `errors` or `sources` view. Period activity is a request ledger; the current-inventory block is a posting snapshot. Never calls the model. |
| `/status [mine]` | Open postings, ranked by fit. `mine` restricts to postings you've claimed or applied to. |
| `/posting <id>` | Full detail for one posting, including its stored description. |
| `/claim <id> [release]` | Mark a posting as one you intend to apply to, or drop the claim. |
| `/applied <id> [undo]` | Mark a posting as applied. Stops stale nudges and downgrades a later delisting to quiet. |
| `/fit <id>` | Score (or rescore) a posting against your profile on demand. |

`/watch` **does** seed the board silently, the opposite of issue-radar, which deliberately skips backfill on registration. Here it's required: closure is inferred from absence in the *next* snapshot, so without a complete baseline the very first poll would read every pre-existing posting on the board as brand new. Seeded postings can't trigger the freshness alert — see `posted_at_exact` below.

## The four alerts (everything else is a news feed)

| Event | Fires when |
|---|---|
| `vanished_while_claimed` | You `/claim`ed a posting and it came off the board before you `/applied`. The race-warning analogue from issue-radar — it reports something you can no longer act on, so the lesson is about pace. |
| `fresh_opening` | A newly found posting whose *stated* publish time is within `RADAR_FRESH_PING_HOURS`. No fit score needed — this is the be-first-to-apply ping, and it works on the search sources (LinkedIn, StepStone, XING) that ship no description. |
| `high_fit` | A posting scores at/above `RADAR_FIT_THRESHOLD` and is still younger than `RADAR_FRESH_HOURS`. |
| `deadline` | A stated application deadline is within `RADAR_DEADLINE_DAYS`. |
| `posting_reposted` | A role you'd seen before is relisted under a new ATS id — the search reopened, or a previous hire fell through. |

Plus a quiet `stale` nudge for a claim you never acted on. Alerts post fresh with a ping and are never batched; more than `RADAR_DIGEST_THRESHOLD` quiet postings updated in one cycle collapse into a single fit-ranked digest instead of flooding the channel one embed at a time.

### Jev usage accounting

`/stats` separates two things that used to be confused: what the **postings table** says right now (how many open jobs have a current verdict, how many match, how many await assessment) and what was actually **asked of the model** in a time window. The window numbers come from two additive tables: `jev_evaluations` (one row per logical assessment, whatever its outcome) and `jev_attempts` (one row per HTTP attempt, including retries). Units are kept distinct on purpose:

- an **attempt** is a physical request; it is attributed to the window it *started* in, so a request that crosses the boundary stays in the earlier window;
- a **logical evaluation** is one posting assessed against one fixed input and policy snapshot, attributed to when it was requested;
- **local exclusions** (seniority/language rules, discovery filters) and **evidence deferrals** (missing or oversized descriptions) cost no request and are never counted as model calls;
- `NULL` token usage means *unknown* — a timeout is not zero tokens and not a rejection. A 200 with a broken answer set still records whatever usage the provider reported;
- an attempt left open by a crash becomes `unknown/interrupted` on the next start; it is never fabricated into a success or a failure.

Both the poller and manual `/fit` go through the same accounted path (`src/jev-service.ts`). The first request-budget milestone is not implemented yet, so `/stats` says "request budget: not configured" and "cache hits: not enabled" rather than implying savings it cannot prove. `RADAR_STATS_TIMEZONE` (default `Europe/Berlin`) controls the `today` window; DST-transition days are computed from the actual offset, not a fixed one.

A new posting's stated age decides what, if anything, it becomes: within `RADAR_FRESH_PING_HOURS` it is a `fresh_opening` alert; within `RADAR_ALERT_MAX_AGE_HOURS` it is a quiet `posting_opened`; older than that it is stored and shown on the dashboard but queues **no Discord event**. That last bucket exists because ranked search pages churn — a week-old posting drifting back into the visible window is not news, and before this gate roughly two thirds of LinkedIn "new" alerts were days old. A posting with no stated publish date is always a quiet opening: it can never claim to be fresh, and it is never silenced either.

## Fit scoring

Eve supports the existing Claude CLI scorer and profile-driven TypeSafe Jev matching.

For Jev, set `TYPESAFE_API_KEY` in your local `.env` and keep `RADAR_PROFILE` pointing at your existing profile. Run:

```bash
npm run enable-profile
```

This validates the key and profile, backs up `.env` and the database, retains existing sources, registers broad software searches for Germany, India, the UK and Worldwide plus `remotive:all`, and restarts active bot/dashboard user services. The next scheduled poll performs classification. No Discord messages are sent by the activation script itself.

`config/filters.profile.json` preserves the existing geography and remote exclusions but sets `targeting: "profile"`. Unknown titles now reach Jev. The five existing role families remain preferences; seniority, experience and language exclusions remain hard rules. Regional restrictions on remote jobs are still enforced: an employer being international does not establish candidate eligibility.

Jev judges required experience, education, language, work eligibility and mandatory technologies separately, then scores duties against the profile. Discord match delivery requires **all requirements satisfied**, **fit ≥ `RADAR_FIT_THRESHOLD` (75/100 by default)**, and **confidence ≥ `RADAR_FIT_CONFIDENCE` (0.8 by default)**. Confidence is the minimum reported confidence across the six answers, a conservative policy threshold rather than a calibrated probability of employment. These defaults require evaluation on real labeled jobs.

Missing evidence remains unknown. Search postings without descriptions get bounded enrichment attempts using job-specific structured data or LinkedIn's guest description. Blocked, absent and oversized evidence stays unscored and retries after six hours. Unknown/rejected decisions are retained without notifications. Changes to profile, pinned model, questions or posting content invalidate cached assessments; threshold changes reuse stored assessments. At most `RADAR_FIT_BUDGET` candidates are attempted per poll, with `RADAR_FIT_CONCURRENCY` workers (default 3).

Matches-only mode replaces raw fresh/opening/repost notifications with one profile-match alert per deduplication key. Personal lifecycle reminders for claimed jobs remain. Matches may have an unknown publication date or be older than the freshness window; they are labeled as profile matches, never as newly published. This deliberately allows useful older open jobs to surface. Other age/location constraints in the filter file still apply. Discord failures retain pending match events for retry; a crash between Discord accepting a message and SQLite recording it can still cause a duplicate.

The Remotive feed includes descriptions and original Remotive links/source credit, has a documented 24-hour publication delay, and is polled at most once every six hours. It broadens discovery beyond title searches, but no source combination promises every job worldwide. Country searches retain their existing page caps. See [Remotive API documentation](https://github.com/remotive-com/remote-jobs-api) and [TypeSafe API](https://docs.typesafe.ai/api).

The default `RADAR_FIT_PROVIDER=claude` preserves the legacy CLI scorer. Only capability-related profile sections (`resume`, `work_eligibility`, `application_answers`) are sent to either provider; the top-level `identity` section is excluded. Do not place contact details in capability sections.

## Sources

| adapter | reference | snapshot |
|---|---|---|
| `greenhouse` | `greenhouse:stripe` | complete |
| `lever` | `lever:spotify` | complete |
| `ashby` | `ashby:ramp` | complete |
| `personio` | `personio:pitch` | complete |
| `smartrecruiters` | `smartrecruiters:BoschGroup` | complete |
| `workday` | `workday:nvidia.wd5/NVIDIAExternalCareerSite` | complete |
| `successfactors` | `successfactors:jobs.sap.com` | complete, or it throws |
| `arbeitsagentur` | `arbeitsagentur:werkstudent@münchen+25` | complete, or it throws |
| `stepstone` | `stepstone:werkstudent ki@münchen` | **never complete** |
| `indeed` | `indeed:werkstudent@nürnberg` | **never complete** |
| `xing` | `xing:machine learning@nürnberg` | **never complete** |
| `linkedin` | `linkedin:werkstudent machine learning@nürnberg` | **never complete** |
| `browser` | `linkedin:rust engineer@berlin` (only if the direct adapters are removed) | **never complete** |
| `remotive` | `remotive:all` | **never complete** |
| `weworkremotely` | `wwr:all` or `weworkremotely:all` | **never complete** |
| `remoteok` | `remoteok:all` | **never complete** |
| `workingnomads` | `workingnomads:all` | **never complete** |
| `himalayas` | `himalayas:all` | **never complete** |
| `arbeitnow` | `arbeitnow:de`, `arbeitnow:uk` | **never complete** |

The first five are per-employer boards on public, unauthenticated JSON APIs — one request per board (SmartRecruiters paginates), each a genuine complete snapshot.

**Workday** (`workday`) is the same shape behind a POST: an unauthenticated JSON search per tenant, 20 per page, paginated to the total the first page reports (later pages report `total: 0`, so it is captured once). The board only states relative publish times, so `posted_at_exact` is always 0 for it. The reference is `tenant.wdN/site`; paste the career-site URL and the adapter derives it.

**SuccessFactors** (`successfactors`) is HTML, not JSON: the standard `/search/?startrow=N` listing, 25 rows per page, total read from the results table's `aria-label`. Paginated to the total and it throws on a short snapshot, exactly like SmartRecruiters. Some tenants sit behind SSO (Infineon); those redirect off-host and the adapter throws rather than returning an empty board. No publish date on the listing.

**Bundesagentur für Arbeit** (`arbeitsagentur`) is different in kind: a national *search* rather than one employer's board, and by a wide margin the highest-yield source for the German market. It is *conditionally* complete — paginable to `maxErgebnisse` for a narrow search, hopeless for `praktikum` nationwide (33,487 results). Rather than claim a completeness it doesn't have, it **throws** above an 800-result cap and tells you to narrow the search, which costs exactly one request. It tolerates a small shortfall against the promised total, because paginating a live search is racy and demanding an exact match makes every large search fail permanently — that is not hypothetical, it killed a 439-of-440 search during development.

Measured yield is lopsided enough to be worth stating plainly: one city search (`werkstudent@münchen+25`) returns **121** matching student roles, while the entire Bosch board — 4,727 postings, ~48 requests per cycle — returns **48**. Company boards are for employers you specifically care about, not for volume.

**The four board searches** (`stepstone`, `indeed`, `xing`, `linkedin`) talk to each site over plain HTTP with a browser user agent and no session, and read whatever structured data the search page already carries: StepStone's server-rendered cards, Indeed's embedded job-card JSON, XING's inlined GraphQL cache, LinkedIn's unauthenticated guest search fragment. Each fetches page 1 only (LinkedIn: up to four pages of the last seven days, newest first) and declares itself `complete: false`, so the poller never reads an absence as a closure. Only LinkedIn and Indeed state a publish date. Indeed sits behind Cloudflare and intermittently answers with a challenge page; the adapter throws on it and the failure counter mutes the source until it recovers. None of these do pagination that robots.txt disallows, and none do any evasion — a block is a signal to stop, not a problem to route around.

**The remote feeds** (`remotive`, `weworkremotely`, `remoteok`, `workingnomads`, `himalayas`, `arbeitnow`) are public JSON/RSS endpoints with full job descriptions, and they all declare `complete: false`: a feed is a discovery window, so a posting falling out of it is never read as a closure. Each keeps the source's eligibility evidence rather than flattening it — WWR's `region`/`country`/`state`, Himalayas' hiring-country and UTC-offset restrictions, Arbeitnow's board-specific location — because the location filter and Jev both read that field. Missing eligibility data is never promoted to permission: a missing or malformed restriction list stays explicitly unknown, and only a valid, empty restriction array means "Worldwide". A blank location is stored as null, never inferred from the board's country. All are parsed by pure functions with fixtures (`src/feeds.test.ts`), and the RSS parser refuses DOCTYPE declarations and caps item counts rather than trusting the feed. Cadences are per source (`RADAR_*` overrides are not needed): WWR every 30 minutes with conditional requests, Remote OK/Working Nomads/Arbeitnow hourly, Himalayas daily.

**Himalayas** is the one source whose window is much smaller than its volume: a measured 200-job window covered 4.2 hours (~1,150 new jobs a day), so a fixed head-only walk would miss most arrivals. Each daily poll instead does two bounded walks resumed from an opaque per-source cursor: a head walk that stops at the previous poll's watermark (fetching exactly what is new, up to 1,600 jobs) and a 500-job background walk that covers the historical tail a slice at a time and restarts when it reaches the end. Nothing is permanently unreachable, and the fresh slice is never buried by backfill.

Every network source now goes through `src/http.ts`: per-domain concurrency caps, byte limits enforced while reading, conditional requests, redirects validated hop by hop (no credentials, no private/link-local destinations — including IPv4-mapped IPv6 forms — and a caller allowlist), and a failure taxonomy that distinguishes blocked from malformed from not-modified. A 429/403 records a **domain cooldown** in `domain_state`, so every query source on a throttled host pauses together while other domains keep polling; a failed source gets a bounded per-source backoff (`sources.next_attempt_at`). At `RADAR_MAX_FAILURES` the source is marked muted, but it is still probed on the capped 6-hour backoff, so an outage recovers on its own instead of needing a manual re-add.

Plus an opt-in browser-driven adapter (`src/sources/browser.ts`, via [browser-use](https://github.com/browser-use/browser-use)), now a fallback behind the direct adapters above — disabled unless `RADAR_BROWSER_USE_DIR` is configured. Scraping those sites likely breaches their terms of service, and a driven browser signed into your own account can get it rate-limited, challenged or flagged; there is no evasion built in (no proxy rotation, no fingerprint spoofing, no CAPTCHA solving) — a block is meant to fail loudly so the poller's failure counter mutes the source, not to be worked around.

## Filtering

Every ingestion path applies the deterministic five-family classifier in `src/roles.ts` before storage: AI / LLM (priority 1), Backend / Platform, Developer Tools and Industrial AI (priority 2), and ML Systems (priority 3). Titles and available descriptions supply evidence; senior titles, explicit experienced-professional requirements and mandatory C1/C2 German are excluded. Missing seniority is allowed; three years is left to the existing profile scorer. No classification LLM calls or additional detail requests are made.

Locations are worldwide, with India, US, UK, Germany and the European Union explicitly covered in search configuration. A location match does not establish visa or work-authorization eligibility. German regional sources remain useful alongside international searches. `RADAR_FILTERS` supplies optional additional constraints; leaving it unset cannot disable role targeting.

Accepted rows store `roleFamily`, `rolePriority`, `matchedSignals` and `secondaryRoleFamilies`. Existing rows are classified on database migration: irrelevant history is retained but excluded from the dashboard, bot feed, pending delivery and scoring backlog. The existing 0–100 fit scorer remains unchanged; its queue and dashboard put higher-priority families first. The dashboard includes a family selector. Descriptionless search cards rely on titles; unusual roles without either sufficient title evidence or an available description cannot be classified reliably.


```jsonc
{
  "default": {
    "titleAny":    ["werkstudent", "praktikum", "praxissemester", "|intern|", "|thesis"],
    "titleNone":   ["senior", "lead", "principal", "manager", "head of"],
    "locationAny": ["berlin", "munchen", "muenchen", "munich", "deutschland"],
    "remote": "include",
    "maxAgeDays": 30
  },
  "perSource": { "arbeitsagentur:*": { "maxAgeDays": 7 } }
}
```

`perSource` keys are `kind:ident` or `kind:*`, merged over `default` by whole field (never concatenated), so an override can *narrow*.

Matching is normalised substring by default, which is the right call for German: `werkstudent` has to match `Werkstudentin` and `Werkstudent:in`, and `praktikum` has to match `Pflichtpraktikum`. But plain substring would make `intern` match `International`, so a term can opt into precision with `|`: `|intern|` whole word, `|intern` word start, `intern|` word end. Case and diacritics fold (`München` = `MUNCHEN` = `Munchen`), but transliteration and translation never happen — `Muenchen` and `Munich` are separate config entries, because inferring them would make the config lie about what it matches.

Two consequences worth knowing:

- **Filtered-out postings are never stored**, so they cost no scoring budget. With 33,487 Praktikum postings nationwide, that is the difference between a working bot and a runaway LLM bill.
- **Filters run before the diff, so changing one needs a re-baseline.** Since absence means closure, tightening a filter would otherwise mass-close live postings — destroying claims and firing false `vanished_while_claimed` alerts — and widening one would flood the channel. So `sources.filter_hash` records the spec in force at the last poll; when it changes, the poller runs one cycle that refreshes rows, closes nothing, skips the mass-delist guard, and stores the new hash.

## Seeding a board list

`/watch` one board at a time, or seed many at once:

```bash
node scripts/seed-boards.ts config/boards.json --dry-run   # resolve + fetch, write nothing
node scripts/seed-boards.ts config/boards.json             # register and seed
```

`config/searches.example.json` holds the board-search side: focused family searches on LinkedIn for India, US, UK, the European Union and worldwide, plus German searches on StepStone, XING and Indeed. Seed it the same way.

`config/boards.example.json` is a **verified** starting set for the German student-role case — every entry was fetched live and its yield measured, with the ones that don't work recorded so nobody re-checks them. It needs no Discord credentials, skips already-watched boards, carries on past failures, and seeds silently: no events are queued, because seeding builds the baseline the next poll diffs against.

Seeding applies the same filter the poller does, and records the same hash. That matters more than it sounds: seeding unfiltered would store thousands of irrelevant postings, send every one of them to the fit scorer, and then close them all on the next filtered poll.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | |
| `DISCORD_CHANNEL_ID` | — | Single channel for all watched boards |
| `DISCORD_APP_ID` | derived from token | Only needed if `--register` can't derive it |
| `RADAR_DB` | `eve.db` | Use an absolute path; both processes open it |
| `RADAR_PROFILE` | — | Path to job-pipeline's `profile.json`. Unset disables fit scoring and `high_fit` |
| `RADAR_FIT_MODEL` | `sonnet` | Model run through the `claude` CLI |
| `RADAR_FIT_THRESHOLD` | `75` | Score at or above this pings you |
| `RADAR_FRESH_HOURS` | `48` | A posting only counts as fresh this long after its *stated* publish date |
| `RADAR_FIT_BUDGET` | `25` | Max LLM scorings per poll cycle |
| `RADAR_FRESH_PING_HOURS` | `3` | A new posting published within this many hours pings as `fresh_opening` |
| `RADAR_ALERT_MAX_AGE_HOURS` | `24` | A new posting older than this (stated time) is dashboard-only, no Discord event |
| `RADAR_PING` | `@here` | Discord user id for actionable alerts, or `@here` |
| `RADAR_DIGEST_THRESHOLD` | `5` | Quiet postings updated in one cycle before they collapse into one digest |
| `RADAR_STALE_DAYS` | `7` | Claimed but not applied this long -> a nudge |
| `RADAR_DEADLINE_DAYS` | `3` | Ping this many days before a stated deadline |
| `RADAR_MAX_FAILURES` | `5` | Consecutive poll failures before a board mutes itself |
| `RADAR_MASS_DELIST_RATIO` | `0.5` | Refuse a cycle that loses more than this fraction of a board's open postings at once |
| `RADAR_BROWSER_USE_DIR` | — | Path to a browser-use checkout. Unset disables the LinkedIn/Indeed/StepStone adapter |
| `RADAR_BROWSER_USE_PYTHON` | `python3` | Interpreter with browser-use and Playwright's Chromium installed |
| `RADAR_BROWSER_TIMEOUT_MIN` | `10` | Max minutes one browser-driven search may run before being killed |
| `RADAR_DASHBOARD_PORT` | `8787` | Live dashboard port |
| `RADAR_DASHBOARD_BIND` | `127.0.0.1` | Dashboard bind address. Keep loopback and expose over the tailnet |

## Posting identity

No job board hands you a stable id the way GitHub hands you `owner/repo#number`. An ATS id (a Greenhouse job id, a Lever or Ashby uuid) is stable only while the posting is live — close a search and reopen it weeks later and the same role comes back with a brand-new id. Keying on the ATS id would report every repost as a fresh opening, which is both the loudest possible source of false alerts and the death of the `posting_reposted` signal, one of the four things this bot exists to raise.

So identity (`src/key.ts`) is synthesised from the three things a human uses to decide two listings are the same job — company, role, place — hashed: `sha256(company ∥ title ∥ location)` truncated to 12 hex chars, joined with NUL bytes so a company name ending in the words a title starts with can't shift the boundary and alias two postings together.

- **Titles** shed gender markers (`(m/w/d)`, `all genders`), employment type, urgency words (`urgent`, `hiring now`) and requisition numbers — but **keep seniority**. Merging "Senior Backend Engineer" into "Backend Engineer" would silently eat a real opening; a wrong split costs one duplicate alert, a wrong merge hides a job forever, and the whole function is biased toward the cheaper mistake.
- **Locations** fold every spelling of a city together and collapse every flavour of remote (`remote`, `wfh`, `anywhere`, `home office`) to one token — but **hybrid is checked before remote**, because "Berlin (Hybrid)" implies a specific office you have to be near, and that's the stronger claim; collapsing it into the global remote bucket would key it as the same job as a fully remote role in São Paulo.
- **Companies** have their legal suffix (`GmbH`, `Inc`, `Ltd`, `& Co. KG`, ...) stripped from the tail, repeatedly, so "Acme GmbH" on a careers page and "Acme" on an aggregator match.

Deliberately **not** handled: seniority synonyms (`Sr.` vs `Senior`, `Engineer II`), multi-city postings (the first city listed wins), cross-language titles. If you ever change this function, every stored key mismatches on the next poll and every board looks 100% delisted — the mass-delist guard below will (correctly) refuse every cycle. Delete the database and re-seed rather than fight it; this was observed live during development.

## Repository structure

```
src/
  bot.ts             gateway client, slash commands
  poller.ts          poll cycle, mass-delist guard, fit-scoring budget
  diff.ts            snapshot set-difference: new / reposted / updated / closed / vanished
  key.ts             posting identity: company + title + location -> hash
  filter.ts          config-driven matching + filter hashing for the re-baseline
  events.ts          diff -> queued events; the four alerts, stale and deadline sweeps
  fit.ts             shells out to `claude -p`, scores against job-pipeline's profile.json
  delivery.ts        queue drain, edit-in-place vs post-fresh, alerts-before-digest
  render.ts          embeds
  db.ts              storage layer
  dashboard.ts       live feed: HTTP + SSE over the same SQLite file
  schema.sql         tables
  config.ts          env parsing
  types.ts           shared types
  sources/
    index.ts         Adapter interface, shared fetch/HTML/date helpers
    registry.ts       adapter lookup, /watch reference parsing
    rss.ts            shared RSS/Atom parser (bounded, DOCTYPE-refusing)
    greenhouse.ts     Greenhouse Job Board API adapter
    lever.ts          Lever Postings API adapter
    ashby.ts          Ashby job-board API adapter
    personio.ts       Personio per-tenant board adapter
    smartrecruiters.ts SmartRecruiters postings API adapter
    workday.ts        Workday per-tenant JSON search adapter
    successfactors.ts SAP SuccessFactors career-site HTML adapter
    arbeitsagentur.ts Bundesagentur fuer Arbeit national search
    stepstone.ts      StepStone search, direct HTTP, complete: false
    indeed.ts         Indeed search, direct HTTP, complete: false
    xing.ts           XING search, direct HTTP, complete: false
    linkedin.ts       LinkedIn guest search, direct HTTP, complete: false
    remotive.ts       Remotive JSON feed, complete: false
    weworkremotely.ts WWR RSS feed, complete: false
    remoteok.ts       Remote OK JSON API, complete: false
    workingnomads.ts  Working Nomads exposed_jobs JSON, complete: false
    himalayas.ts      Himalayas browse API (cursor pages), complete: false
    arbeitnow.ts      Arbeitnow DE/UK API (links.next pages), complete: false
    browser.ts        opt-in browser-use fallback, complete: false
  http.ts             bounded HTTP: domain caps, byte limits, redirect checks
  *.test.ts           test suite, no network
config/
  filters.example.json  what to track; copy to filters.json
  boards.example.json   verified starting set of sources, with measured yields
scripts/
  seed-boards.ts     batch /watch from a board list, no Discord needed
  board_search.py    browser-use driven search, called by sources/browser.ts
deploy/              systemd units (poll, dashboard, bot) + timer
```

## Deployment

```bash
mkdir -p ~/.config/systemd/user
cp deploy/*.service deploy/*.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now eve-dashboard.service eve-poll.timer
systemctl --user enable --now eve-bot.service     # optional, Discord alerts
loginctl enable-linger "$USER"     # or user units die on logout
```

The timer fires every 5 minutes. The search sources state publish times to the hour or better (LinkedIn's "3 hours ago" card text, StepStone's `datePosted` in the page's preloaded state, XING's `refreshedAt`), and the `fresh_opening` ping exists to beat the applicant queue, so the interval is the ceiling on how early that ping can land. A full cycle over ~70 sources takes about two minutes.

Polling that often stays cheap because the expensive part is scoring, not fetching: Greenhouse and Ashby honour `If-None-Match`, so an unchanged board costs one 304 and does no work. Only genuinely new postings reach the LLM, and `RADAR_FIT_BUDGET` caps how many per cycle regardless of interval — a tighter interval drains a scoring backlog faster, it does not raise the ceiling.

The poll unit is a `oneshot` with `TimeoutStartSec=900`. Fit scoring shells out to `claude` once per new posting, so a cycle working through a backlog can outlast the 10-minute interval. That is safe: systemd will not run a second instance of a oneshot unit that is still active, so cycles serialise and a firing during a long cycle is skipped. The timeout stays well under an hour so a genuinely wedged cycle is killed rather than blocking every subsequent firing.

## API behaviour worth knowing

Recorded because each one cost real debugging time.

- **Greenhouse double-escapes its JD.** `content` contains literal `&lt;h2&gt;` rather than a real tag, so HTML entities must be decoded *before* tags are stripped — run the tag-stripper first and it never matches anything, and the visible JD ends up full of `&lt;/p&gt;` litter.
- **Lever answers a typo'd slug with HTTP 200** and `{"ok":false,"error":"Document not found"}`, not a 404. Without an explicit non-array check on the response body, `/watch` would silently register a board that returns nothing, forever.
- **Ashby lists one role in several locations** via `secondaryLocations`; flattening those into separate postings makes one job look like three, so only the primary `location` feeds identity and the rest is folded into a "(+N more)" display suffix. Ashby titles also carry a leading space in the raw feed, and `isListed:false` means the board itself is hiding the posting — as good as closed, so it's filtered out of the snapshot.
- **A short snapshot is indistinguishable from a mass delisting.** A board erroring out mid-pagination returns a short list that looks exactly like a company closing every req it has. **This is the most important safety property in the system**: the poller refuses any cycle where more than `RADAR_MASS_DELIST_RATIO` of a board's open postings would vanish at once, changing no rows and counting a failure instead of acting on it (boards under 4 open postings are exempt — losing 2 of 3 is a Tuesday, not a catastrophe, and a tiny board could otherwise never close anything). Its real-world corollary: **if you ever change the identity function in `key.ts`, every stored key mismatches and every board looks 100% delisted on the next poll.** The guard catches exactly that — this was observed live during development — but the fix is to delete the database and re-seed, not to fight the guard.
- **Scraped search pages are not snapshots.** Pagination is capped, results re-rank between pages and promoted rows get injected, so reaching "the last page" means the site stopped talking, not that every open role was seen. The browser adapter therefore declares `complete: false`, and the poller never infers closure from an absence in an incomplete source — otherwise a posting falling off page 1 between two searches would close a live job and fire a false `vanished_while_claimed` alert.
- **XING's publish time is `refreshedAt`.** Live search results carry no activated/published field, only `refreshedAt` and `activeUntil`. XING bumps `refreshedAt` when an employer re-boosts a listing, so an old role that was just refreshed will look fresh. That is a known trade-off: without it XING could never state a date at all.
- **A board that states no publish date can never fire the freshness alert.** When a board omits it, `posted_at` falls back to first-sighting and `posted_at_exact` is recorded as 0. On the first poll after `/watch`, first-sighting is *now* for the board's entire back catalogue — without that flag, adding a source would ping its whole history as breaking news on day one.
- **A delisted posting can never be refetched**, so the JD is captured on first sighting (Greenhouse is fetched with `content=true` for exactly this reason) and a later cycle returning a shorter or null description must never erase what's already stored.
- **A deferred Discord interaction dies after 15 minutes.** `/fit` shells out to `claude` and can take up to its own 90-second timeout, well inside that window, but it's the reason the interaction is deferred immediately on receipt rather than answered synchronously.

## Tests

```bash
npm test          # 172 tests, no network
npm run typecheck
```

A live cold poll against real boards: Stripe (Greenhouse) 529 open postings, Spotify (Lever) 103, Ramp (Ashby) 121. A second identical cycle produced zero events, with Greenhouse and Ashby both returning 304s.

## License

MIT

To replace already registered broad searches, run `node scripts/retarget-searches.ts` after copying the example configurations to their live filenames. It backs up the database, mutes obsolete search registrations without deleting history, and registers the focused searches without fetching or sending notifications. Restart long-running dashboard/bot processes after upgrading; the poller loads code each cycle.
