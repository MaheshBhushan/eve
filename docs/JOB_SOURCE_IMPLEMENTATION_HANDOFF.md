# Eve: 74-source job discovery and Jev matching — implementation handoff

**Prepared:** 22 September 2026. **Audience:** the developer extending Eve. **Repository:** [MaheshBhushan/eve](https://github.com/MaheshBhushan/eve).

## 1. What to build

Collect broadly from the requested job sites, retain worldwide remote roles and the existing target regions, evaluate each usable job description against the existing candidate profile with TypeSafe Jev, and deliver qualifying matches to the connected Discord bot.

Preserve the existing rules: target regions are Germany, India and the United Kingdom; remote roles remain subject to their actual hiring-country/time-zone restrictions. Preserve seniority, experience and language exclusions. Keep the five existing role families as preferences: AI/LLM applications, backend/platform, developer tools, industrial AI and ML systems. Do not turn a source's specialty into a new requirement or silently broaden the user's profile.

**Deliverable status:** this is a researched implementation specification, not 74 newly deployed scrapers. All 74 supplied URLs are included below and in the accompanying candidate catalog. This research did not register new production sources, modify matching thresholds or send Discord messages. Eve already has adapters for some of the sites; the rest require the work described here.

The desired pipeline is:

```text
Public API / RSS / public job pages / verified employer ATS boards
                       |
              bounded source scheduler
                       |
            validated source observations
                       |
       canonical job identity + duplicate merging
                       |
          current geographic / hard-rule filters
                       |
        description enrichment when evidence is missing
                       |
           persistent, fair scoring work queue
                       |
    Jev: mandatory requirements + duties/profile relevance
                       |
         pass / reject / unknown / retryable error
                       |
       deduplicated Discord outbox -> connected bot
```

Do not wait for a worldwide scrape to “finish.” Sources update continuously and provide different coverage windows. Process jobs incrementally. Never promise every job worldwide.

## 2. What was actually researched

Each supplied URL received a bounded unauthenticated HTTP request and a robots.txt check. Selected published or plausible data endpoints were separately probed. No login sessions, browser challenge bypass, applications, subscriptions or partner credentials were used. JavaScript was not executed; HTML technology markers are hints for subsequent investigation, not a completed browser/network reverse-engineering exercise.

The first URL pass returned **60 HTTP 200 responses, seven 403s, four 429s, one 404 and two timeouts**. A 200 response may be marketing HTML, an empty page, a blog feed or a login shell. A 403/429/timeout from this machine does not establish permanent unavailability. Robots observations are not a blanket access or licensing determination.

Evidence files, all relative to this guide:

- [Source catalog](research/job-source-catalog.json): all 74 requested URLs, redirects, proposed routes and priorities. It is an inventory, **not** a `seed-boards.ts` input.
- [Initial URL observations](research/job-source-observations.json): statuses, page titles, detected markers, discovered links and robots excerpts.
- [Endpoint observations](research/job-endpoint-observations.json): endpoint status, format, field names and limited pagination metadata.
- [Follow-up observations](research/job-source-followups.json): checks that resolved ambiguous feeds, data types and response-size issues.

**Evidence labels used below:** “validated” means a response was fetched and its basic shape inspected on this date. It does not mean a production adapter, exhaustive pagination, reuse permission or sustained availability has been established. “Candidate” or “investigation” means further work is explicitly outstanding. Item counts are snapshots, not quotas or guarantees.

The Markdown is self-contained enough to share by itself. The JSON files provide the reproducible audit trail; include them when your friend wants exact observations.

## 3. Existing Eve implementation: reuse these parts

Paths in this section are relative to the repository root; the links resolve from this document.

| File | Current responsibility | Extension point |
|---|---|---|
| [src/sources/index.ts](../src/sources/index.ts) | `Adapter`, `FetchedPosting` helpers, HTML stripping, optional source polling interval | Shared bounded HTTP and parser helpers; explicit discovery completeness |
| [src/sources/registry.ts](../src/sources/registry.ts) | Parses references and resolves adapter instances | Register validated adapters only |
| [src/types.ts](../src/types.ts) | `SourceKind`, job/event row types | Add actual new kinds; preserve provenance and structured restrictions |
| [src/filter.ts](../src/filter.ts) | Geography, explicit exclusions, role/profile targeting, filter hashes | Preserve profile mode and re-baseline behavior |
| [src/roles.ts](../src/roles.ts) | Five role families and hard exclusions | Keep hard rules separate from semantic preferences |
| [src/enrich.ts](../src/enrich.ts) | Bounded job-description extraction on a small host allowlist | Add provider-specific detail extraction and measured size limits |
| [src/jev.ts](../src/jev.ts) | Typed questions, request retries, response validation, profile/version fingerprint | Preserve typed decisions; instrument token usage and rejected/unknown reasons |
| [src/poller.ts](../src/poller.ts) | Sequential source polling, snapshot diffing, scoring after fetches | Decouple scoring and enforce per-domain scheduling before large expansion |
| [src/db.ts](../src/db.ts), [src/schema.sql](../src/schema.sql) | SQLite storage, migrations, work selection, event outbox | Fair work queue, canonical identity and observation records |
| [src/delivery.ts](../src/delivery.ts), [src/render.ts](../src/render.ts) | Matches-only delivery, claimed-job reminders, embeds | Source attribution, duplicate resistance and bounded notification bursts |
| [scripts/seed-boards.ts](../scripts/seed-boards.ts) | Fetch/register known adapter references and seed quietly | Use only after adapters and reference formats exist |
| [scripts/enable-profile.ts](../scripts/enable-profile.ts) | Validates credentials/profile and enables existing Jev mode | Not a generic importer for these 74 URLs |
| [config/filters.profile.json](../config/filters.profile.json) | Existing geography with profile-based targeting | Keep as the authoritative discovery rules |

The project uses Node 26+, native TypeScript execution, SQLite and discord.js. Keep that stack for the first expansion. A distributed queue or database migration is not required just because the source catalog is large.

Current matching behavior:

- `RADAR_FIT_PROVIDER=typesafe`; pinned Jev version is configured through `RADAR_JEV_MODEL`.
- `RADAR_FIT_THRESHOLD=75`: duties/profile fit is a 0–100 score.
- `RADAR_FIT_CONFIDENCE=0.8`: the minimum reported confidence across the five requirement answers and the relevance answer must pass.
- All five mandatory dimensions must return `satisfied`; `unknown` and `contradicted` do not trigger match alerts.
- `RADAR_MATCHES_ONLY=true`: raw opening/repost alerts are suppressed; personal reminders for claimed jobs remain.
- Profile matches are not automatically described as freshly published. An older or undated open job can still be useful.
- `RADAR_FIT_BUDGET` defaults to 25 attempted candidates per polling cycle; `RADAR_FIT_CONCURRENCY` defaults to three.

Do not relabel the minimum confidence as “80% chance of employment” or “80% objectively correct.” It is a conservative decision policy applied to model outputs. Evaluate it against labeled jobs.

## 4. Build order

| Phase | Scope | Exit condition |
|---|---|---|
| 0 | Source scheduling, shared fetch bounds, fixtures, queue fairness, attribution | A slow or blocked source cannot hold up matching or other domains |
| 1 | WWR, Remote OK, Working Nomads, Himalayas, Arbeitnow DE/UK; retain Remotive; grow verified ATS tenants | Useful descriptions arrive without browser automation; reruns do not repeat alerts |
| 2 | RemoteFirstJobs, 4dayweek, selected specialist feeds, registered Muse API | Feed variants, namespaces, pagination and eligibility fields pass fixtures |
| 3 | Public HTML/embedded-data boards with high measured incremental yield | One tested detail contract and pagination contract per source |
| 4 | Blocked sites, account-dependent networks and opt-in freelance marketplaces | Explicit working access route, appropriate opportunity type, maintenance owner |

P1 is the recommended first implementation batch, not a claim that every site is equally valuable. Specialist sources can be easy technically but have low fit for the existing profile. Rank the next source by **new useful jobs after cross-source deduplication**, not raw posting count.

## 5. Complete source inventory

IDs preserve the user's input order. `EXISTING` means code already exists, not that this research verified every live search path. `HOLD` means an implementation prerequisite is missing. `P1-REGISTER` requires production API registration; `P3-OPT-IN` is a separate freelance opportunity lane. HTTP status below is for the supplied URL, not necessarily its data endpoint.

### 5.1 Remote boards and broad discovery

| ID / requested source | Page HTTP | Priority / route | Observed evidence and implementation instruction |
|---|---|---|---|
| 01. [We Work Remotely](https://weworkremotely.com/) | 200 | P1 · RSS | Validated RSS: 82 items. Preserve region/country/state, skills, employment type and expiry tags; split Company: Role only when the title actually uses that format. Link back to WWR. A feed window is not a complete snapshot. |
| 02. [Remote OK](https://remoteok.com/) | 200 | P1 · JSON | Validated /api array: 100 elements including a metadata/legal row. Skip that row; preserve id, position, tags, location and description. The tested RSS URL returned 410, so use JSON. Retain source attribution. |
| 03. [NoDesk](https://nodesk.co/remote-jobs/) | 200 | P2 · HTML investigation | Jobs index returned HTML. Inspect listing links and one detail page for JobPosting or semantic selectors, then establish pagination. No public API/feed was validated; do not invent one. |
| 04. [Remotive](https://remotive.com/) | 200 | EXISTING · JSON | Existing remotive adapter; public endpoint returned 18 jobs. Keep the existing six-hour cadence and source link. Its documented publication delay is 24 hours. The limit=1 probe returned 18 rows, so do not rely on that parameter being honored. |
| 05. [Jobspresso](https://jobspresso.co/) | 200 | P2 · HTML investigation | WordPress detected. Both advertised feeds returned valid RSS with zero items, so they are not yet useful discovery sources. Inspect actual job listing/detail pages; do not equate an empty blog feed with zero open jobs. |
| 06. [Working Nomads](https://workingnomads.com/) | 200 | P1 · JSON | The homepage links /api/exposed_jobs/; the live response contained 56 job objects. No stable numeric ID was observed: use the source URL. Preserve pub_date, location, tags and description; do not infer global completeness from the array. |
| 07. [JustRemote](https://justremote.co/) | 200 | P2 · HTML investigation | Homepage returned HTML. Separate public job listings from premium search features; inspect a public detail page and pagination. No stable job-data endpoint was validated. |
| 08. [Dynamite Jobs](https://dynamitejobs.com/) | 200 | P2 · HTML investigation | Advertised RSS contained 138 items, but the first item was a /blog/ URL. Treat it as editorial until proven otherwise. Locate the actual jobs listing and description requests instead of importing blog posts as jobs. |
| 09. [Remote100K](https://remote100k.com/) | 200 | P2 · HTML investigation | Homepage returned HTML. Inspect job cards, details and salary qualifiers. Treat the site's salary-focused branding as a source characteristic, not a new minimum salary requirement for this user. |
| 10. [Remote.io](https://remote.io/) | 200 | P2 · HTML investigation | Homepage mixes jobs and employer/EOR services. Find the actual job-results route and detail template first; preserve geographic restrictions rather than inferring worldwide eligibility from the site's name. |
| 11. [RemoteFirstJobs](https://remotefirstjobs.com/) | 200 | P1 · RSS | /rss is documentation HTML, not the feed. /rss/jobs/software-development.rss returned 100 RSS items. Discover other category feed URLs from the published guide, preserve location/expiry evidence, and deduplicate overlapping feeds. |
| 12. [Remote Habits](https://remotehabits.com/) | 200 | P3 · HTML investigation | /jobs/ returned a job-board page; homepage also contains remote-work stories. Confirm current posting dates and job-detail links before enabling. Keep interviews and editorial articles out of job storage. |
| 13. [Remote3](https://remote3.co/) | 200 | P2 · RSS | The linked /api/rss returned 8 job items. The homepage title looked older than the feed's dates, so assess freshness from individual records. Web3 is a source focus, not evidence that every role fits the profile. |
| 14. [4dayweek](https://4dayweek.io/remote-jobs) | 200 | P1 · RSS then JSON | /feed returned 50 jobs. A candidate /api/jobs?page=1 returned 25 items and has_more but no description field in list items. Prefer the linked feed initially; use the observed JSON route only with validation and detail enrichment. Remote and reduced-hours are separate attributes. |
| 15. [SkipTheDrive](https://www.skipthedrive.com/) | 200 | P2 · HTML investigation | WordPress homepage returned HTML. A guessed /feed/ URL returned HTML rather than RSS. Inspect real category/job links; validate whether they lead to source listings or external employer pages. |
| 16. [Rat Race Rebellion](https://ratracerebellion.com/) | 200 | P3 · Editorial discovery | The feed returned one article linking a role. An article may contain multiple jobs or advice; resolve actual employer opportunities before creating job records. Do not score article introductions as full descriptions. |
| 17. [PowerToFly](https://powertofly.com/jobs) | 200 | P2 · HTML investigation | Public jobs page returned HTML. Inspect search-result/detail requests and geographic fields. No API contract was validated; login-only features need a separate access decision. |
| 18. [The Muse](https://www.themuse.com/search/remote) | 200 | P1-REGISTER · Documented JSON | /api/public/jobs?page=0 returned 20 results, page_count and full contents. Official docs require app registration beyond testing. Use registered access for production and validate remote/location filters before a broad crawl. |
| 19. [Built In](https://builtin.com/jobs/remote) | 200 | P2 · HTML investigation | Remote results returned HTML. Inspect job detail JSON-LD and next-page links. Capture the remote eligibility region; a remote label is not a worldwide hiring promise. Treat results as incomplete. |
| 20. [Himalayas](https://himalayas.app/jobs) | 403 | P1 · Documented JSON | Jobs UI returned 403 but the documented browse API returned valid JSON. Use cursor pagination, max 20 per page, and daily cadence. Preserve locationRestrictions/timezoneRestrictions. Observed dates are epoch seconds despite inconsistent documentation examples; inspect types. |
| 21. [Hiring Cafe](https://hiring.cafe/) | 403 | HOLD · Access investigation | The supplied domain redirected to hiringcafe.com and returned 403. Resolve current public entry points and inspect an ordinary working browser session before designing an adapter. No internal search endpoint was verified here. |
| 22. [Startup.jobs](https://startup.jobs/) | 403 | HOLD · Access investigation | The supplied page returned 403. Do not claim a working scraper. Investigate a supported public feed, partner route or accessible listing path; retain as a candidate until real detail and pagination fixtures exist. |
| 23. [Remotivated](https://remotivated.com/) | 429 | HOLD · Cooldown/research | The supplied page and robots request returned 429. Pause automated exploration and reassess later; do not classify this as a dead domain or increase retry traffic. No extraction contract validated. |
| 24. [Virtual Vocations](https://www.virtualvocations.com/jobs) | 429 | HOLD · Access investigation | Jobs URL returned 429. Validate accessible listing metadata, description access and any account/subscription boundary before implementation. Do not assume a public index exposes full job descriptions. |
| 25. [RemoteFront](https://www.remotefront.com/) | 429 | HOLD · Cooldown/research | The supplied page and robots request returned 429. No feed or job-detail contract validated. Keep disabled until a later bounded check or a supported data route succeeds. |

### 5.2 Language and specialist boards

| ID / requested source | Page HTTP | Priority / route | Observed evidence and implementation instruction |
|---|---|---|---|
| 26. [LaraJobs](https://larajobs.com/) | 200 | P2 · RSS | The linked /feed returned 10 items with namespaced company, location, job type, salary and tags plus content:encoded. Preserve these fields. Laravel/PHP focus does not justify changing the user's existing role preferences. |
| 27. [VueJobs](https://vuejobs.com/) | 200 | P2 · RSS | The linked app.vuejobs.com/feed/posts returned 985 items. Deduplicate before enrichment/scoring and parse full descriptions. Many frontend roles will fail current preferences; never widen the user's profile just to raise yield. |
| 28. [React Job Board](https://reactjobboard.com/) | 200 | P3 · HTML investigation | WordPress page returned HTML, but a guessed /feed/ returned 404. Inspect real job cards/details. Keep as a low-priority source unless role overlap produces useful matches. |
| 29. [Golangprojects](https://golangprojects.com/) | 200 | P2 · RSS | The linked rss.xml returned 14 items with guid, title, link and description; the first item had no pubDate. Leave publish time unknown instead of inventing freshness. Preserve remote-region evidence. |
| 30. [Python Jobs HQ](https://www.pythonjobshq.com/) | 200 | P2 · RSS watch/HTML fallback | The linked jobs.rss returned valid RSS with zero items. Confirm whether that is a temporarily empty window or discontinued feed; inspect the HTML board before enabling alerts. Empty RSS must not close stored jobs. |
| 31. [DevOpsJobs](https://devopsjobs.io/) | 200 | P2 · RSS | jobs.rss is real RSS: a follow-up read parsed 1,000 items and approximately 7.9 MB. The initial 5 MB cap truncated it. Use a bounded streaming parser or an explicitly larger per-source limit; never treat truncated XML as an empty board. |
| 32. [RustJobs](https://www.rustjobs.dev/) | 429 | HOLD · Cooldown/research | The supplied URL and robots request returned 429. No endpoint was validated. Keep disabled and revisit after cooldown; use the user's systems preference when evaluating eventual Rust roles. |
| 33. [AI-Jobs.net](https://ai-jobs.net/) | 200 | P2 · Redirect/API investigation | The domain now redirects to foorilla.com/hiring/. Its linked /api/list/ is an HTML API index, not a validated job JSON endpoint. Research Foorilla's current contract and access requirements; preserve ai-jobs.net as an alias. |
| 34. [AIMLJobs](https://www.aimljobs.com/) | 200 | HOLD · Domain verification | The supplied HTTPS URL redirected to http://www.aijobsdb.com/. Nuxt markers were detected, but no job-data API was validated. Confirm the current canonical HTTPS site and ownership before building a new adapter. |
| 35. [DeepLearningJobs](https://deeplearningjobs.com/) | 200 | P2 · Embedded JSON investigation | Public HTML contains __NEXT_DATA__. Inspect its job-related fields and one detail page, then test next-page behavior. Build-ID routes are implementation details and must not be hard-coded from a single session. |

### 5.3 Freelance marketplaces and talent networks

| ID / requested source | Page HTTP | Priority / route | Observed evidence and implementation instruction |
|---|---|---|---|
| 36. [Upwork](https://www.upwork.com/) | 200 | P3-ACCESS · Approved API integration | Official Upwork guidance requires approved API access and OAuth. Check current eligibility and scopes before work. Freelance projects need a separate opt-in lane; do not use an account's private browser cookies as a scraping API. |
| 37. [Freelancer](https://www.freelancer.com/) | 200 | P3-OPT-IN · RSS/API | The homepage-linked rss.xml returned 20 project items with categories and dates. These are freelance projects, not necessarily salaried jobs. Keep opt-in; use official developer access for richer project details if needed. |
| 38. [Fiverr](https://www.fiverr.com/) | 200 | P3-MANUAL · Marketplace workflow | The public homepage is a service marketplace. Seller gigs are not vacancies for the user. No buyer-job feed was validated. Model any authorized opportunity workflow separately from ordinary employment listings. |
| 39. [Toptal](https://www.toptal.com/) | 200 | P3-MANUAL · Talent-network workflow | The public page markets access to a vetted talent network. No global candidate-opportunity feed was validated. Keep network enrollment/private matching distinct from scraping Toptal's own corporate careers. |
| 40. [Arc](https://arc.dev/) | 200 | P2/P3 · Public jobs + network | The /remote-jobs route returned HTML. Investigate public job cards/details first; treat private vetted-network opportunities as a separate integration. No reusable job-data API was validated. |
| 41. [Gun.io](https://gun.io/) | 200 | P3-MANUAL · Talent-network workflow | Public WordPress marketing site returned HTML. Identify an actual public candidate-job board before writing a scraper; otherwise support a manual/approved talent-network workflow. |
| 42. [Lemon.io](https://www.lemon.io/) | 200 | P3-MANUAL · Talent-network workflow | The www domain redirected to lemon.io and the page is WordPress-based. No public job feed was validated. Separate joining its talent pool from jobs at Lemon.io itself. |
| 43. [Crossover](https://www.crossover.com/) | 200 | P2 · HTML investigation | Public site explicitly presents remote jobs. Inspect role details, compensation units, hours and hiring-country restrictions. Preserve qualification/assessment requirements; do not automate applications as part of discovery. |
| 44. [Contra](https://contra.com/) | 200 | P3-OPT-IN · Marketplace investigation | Public homepage returned HTML, but no opportunity endpoint was validated. Separate project opportunities from freelancer profiles and portfolios. Confirm public detail access before registering any source. |
| 45. [Braintrust](https://usebraintrust.com/) | 200 | P2/P3 · Public jobs/access investigation | Root domain redirected to www.usebraintrust.com. The candidate app /jobs/ probe returned marketing HTML, not validated job JSON. Find the current public opportunities route before choosing a parser or auth flow. |

### 5.4 Startups and regional boards

| ID / requested source | Page HTTP | Priority / route | Observed evidence and implementation instruction |
|---|---|---|---|
| 46. [YC Work at a Startup](https://www.workatastartup.com/) | 200 | P2 · HTML investigation | Public site returned startup/job discovery HTML. Inspect public job detail links and source application destinations; account-specific matching is a separate feature. Persist startup identity for ATS discovery. |
| 47. [Wellfound](https://wellfound.com/jobs) | 200 | P2 · Embedded JSON investigation | Public jobs page returned HTML with __NEXT_DATA__. Inspect what data is actually public and whether descriptions/pagination require login. Do not assume every field in a logged-in response is public. |
| 48. [StepStone Germany](https://www.stepstone.de/) | 200 | EXISTING · Maintain adapter | Eve already has a bounded, incomplete search adapter. Homepage availability does not verify current search/detail health. Keep Germany coverage; capture real listing and detail fixtures and honor source-wide cooldowns. |
| 49. [XING](https://www.xing.com/jobs) | 200 | EXISTING · Maintain adapter | The supplied /jobs URL redirected to the homepage. Existing Eve uses its own query/embedded-data flow; preserve that instead of parsing this landing page. Reverify refresh dates and job-description availability. |
| 50. [Arbeitsagentur](https://www.arbeitsagentur.de/jobsuche/) | 200 | EXISTING · Maintain adapter | The jobsuche frontend loaded. Eve already uses a v4 search/detail endpoint, but frontend HTTP 200 does not establish API health. Keep bounded result-cap behavior and distinguish query disappearance from actual job closure. |
| 51. [EnglishJobs.de](https://englishjobs.de/) | 200 | P2 · HTML/sitemap investigation | Public homepage and a sitemap link were observed. Inspect city/category pagination and employer detail links. English-speaking does not establish sponsorship or that German is unnecessary for every role. |
| 52. [Arbeitnow](https://www.arbeitnow.com/) | 200 | P1 · Documented JSON | Germany API returned 250 jobs; its documented UK counterpart returned 100. Follow links.next, retain remote and full description, and attribute the source. Response metadata says hourly updates; use that as an initial cadence. |
| 53. [DevTalents.eu](https://devtalents.eu/) | 200 | HOLD · Domain/content verification | HTTP 200 returned an empty visible-text result with no useful links. This is not evidence of a functioning job board. Verify in a browser and inspect the actual content before allocating adapter work. |
| 54. [EuroTechJobs](https://eurotechjobs.com/) | 200 | P2 · HTML investigation | The site redirects to www.eurotechjobs.com and returns a tech-jobs page. Inspect location/category lists and job-detail selectors. Country-specific office roles must still pass the existing location filter. |
| 55. [Landing.jobs](https://landing.jobs/) | 200 | P2 · HTML investigation | The homepage is WordPress-related but /jobs is the relevant job-results page. Homepage RSS links point to editorial content. Inspect actual job details, contract types, location and work-permit statements. |
| 56. [Otta](https://www.otta.com/) | 200 | P2-ALIAS · Redirect investigation | otta.com redirects to uk.welcometothejungle.com, which identifies itself as formerly Otta. Record the alias. Do not assume its UK/app data contract is identical to the main Welcome to the Jungle site. |
| 57. [Cord](https://cord.co/) | 200 | P2-ALIAS · Redirect investigation | cord.co redirects to cord.com:443. Confirm the current public search/detail flow and any login boundary. Keep the old domain as an alias so imports do not create a duplicate source identity. |
| 58. [Welcome to the Jungle](https://www.welcometothejungle.com/) | 200 | P2 · Public frontend investigation | The homepage redirects to /en, contains Next.js flight markers and links /api/env. That link is configuration, not proof of a jobs API. Inspect actual public search requests; do not publish or hard-code transient client keys. |
| 59. [No Fluff Jobs](https://nofluffjobs.com/) | 200 | P2 · Frontend investigation | HTML returned 200 and included challenge-related markers; that alone neither proves a challenge nor proves usable results. Verify actual job cards and detail data. Preserve salary currency, period, contract and remote rules. |
| 60. [Just Join IT](https://www.justjoin.it/) | 200 | P2 · Frontend investigation | www redirects to justjoin.it; Next.js flight markers were observed. Inspect public job JSON/detail requests and cursor/filter parameters. Preserve experience, employment type, salary and workplace fields separately. |
| 61. [Bulldogjob](https://bulldogjob.com/) | 200 | P2 · Embedded JSON investigation | The homepage contains __NEXT_DATA__. Identify job-result and detail fields using actual public pages, then verify pagination. Do not treat a static homepage payload as a complete job inventory. |
| 62. [EU-Startups](https://www.eu-startups.com/) | 200 | P3 · Editorial/board investigation | Homepage is WordPress; the probed /jobs/ page returned the title Jobs In Education. Verify that the current board is relevant and active before coding. Homepage news RSS is not a vacancy feed. |
| 63. [JobsinNetwork](https://www.jobsinnetwork.com/) | 200 | P2 · HTML/network investigation | www redirects to jobsinnetwork.com. Inspect country/city network boards and outbound job links; deduplicate syndicated postings across network domains. Do not infer work eligibility from English-language presentation. |

### 5.5 General boards and employer ATS platforms

| ID / requested source | Page HTTP | Priority / route | Observed evidence and implementation instruction |
|---|---|---|---|
| 64. [LinkedIn](https://www.linkedin.com/jobs) | 200 | EXISTING · Maintain adapter | Eve already has a capped guest-search adapter and description enrichment. The homepage loaded, but this does not override observed search rate limits. A domain-wide cooldown must cover all query sources on a 429. |
| 65. [Indeed](https://www.indeed.com/) | 403 | EXISTING-BLOCKED · Maintain/reassess | Homepage returned 403 in this probe; Eve already has a search adapter. Validate its exact configured locale/query path separately. Treat blocks as access failures, not empty results or a reason to rotate identities. |
| 66. [Glassdoor](https://www.glassdoor.com/) | 403 | HOLD · Access investigation | The supplied page returned 403. No public job feed was verified. Keep as a candidate for a supported partner route or user-authorized workflow; do not promise a production scraper. |
| 67. [ZipRecruiter](https://www.ziprecruiter.com/) | 200 | P2-LOCALE · Locale/feed investigation | The .com URL redirected to ziprecruiter.de from this machine, and the page links jobs.rss. That feed was not probed. Make locale explicit; do not mistake a German redirect for worldwide search coverage. |
| 68. [SimplyHired](https://www.simplyhired.com/) | 403 | HOLD · Access investigation | The supplied page and robots request returned 403. No data route was verified. Revisit only through a supported public or partner integration; keep the operational source disabled meanwhile. |
| 69. [CareerBuilder](https://www.careerbuilder.com/) | 403 | HOLD · Access investigation | The supplied page returned 403. No current redirect or working job-data contract was established. Investigate current site ownership/entry points and supported access rather than relying on old scraper recipes. |
| 70. [FlexJobs](https://www.flexjobs.com/) | timeout | HOLD · Timeout/access investigation | The initial page read timed out while robots.txt loaded. This does not prove closure or blocking. Verify current public versus account-accessible job details and source terms in a normal browser before implementation. |
| 71. [Remote.co](https://remote.co/) | timeout | HOLD · Timeout investigation | The initial page read timed out while robots.txt loaded. No job-data endpoint was validated. Retry a bounded check later and inspect public job-detail routes; never convert a timeout into an empty snapshot. |
| 72. [Greenhouse](https://boards.greenhouse.io/) | 200 | EXISTING-ATS · Employer-specific JSON | The root redirects to marketing. Use verified employer board tokens with boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true. Existing Eve adapter can be reused. There is no global token that lists every employer. |
| 73. [Lever](https://jobs.lever.co/) | 200 | EXISTING-ATS · Employer-specific JSON | The root redirects to marketing. Use api.lever.co/v0/postings/{site}?mode=json; preserve EU-host variants when discovered. Existing adapter can be reused after checking pagination/description behavior for the target tenant. |
| 74. [Ashby](https://jobs.ashbyhq.com/) | 404 | EXISTING-ATS · Employer-specific JSON | The root returned 404, which does not invalidate tenant boards. Use api.ashbyhq.com/posting-api/job-board/{boardName}, optionally includeCompensation=true. Existing adapter supports employer-specific boards; discover actual board slugs first. |

## 6. Concrete contracts for the first adapters

### 6.1 We Work Remotely

Use the [published all-jobs RSS feed](https://weworkremotely.com/remote-jobs.rss), documented on the [official RSS page](https://weworkremotely.com/remote-job-rss-feed). Source credit and a link back are requested. The feed currently includes job-specific extensions; a generic RSS reader that drops them loses useful eligibility evidence.

Observed fields: `guid`, `link`, `title`, `description`, `pubDate`, `expires_at`, `region`, `country`, `state`, `skills`, `category`, `type`.

Implementation: use `guid` as source identity, normalize the original link, preserve the description and extensions, and parse timestamps explicitly. Do not assume company always has a dedicated field. Set `complete: false`: the recent feed is not every open role. A job disappearing from the feed is not a closure. Suggested initial cadence: 30–60 minutes, conditional requests when supported; this is an engineering default, not a published allowance.

### 6.2 Remote OK

The [JSON endpoint](https://remoteok.com/api) responded with an array. Its first element contains update/legal metadata rather than a job. Filter by a valid job ID and expected fields; do not create a posting for metadata. Job mapping: `id` → external ID, `position` → title, `company`, `location`, `description`, `date`/`epoch`, `url`, and optional salary fields.

The payload requests attribution and links back; render these. Prefer the original listing URL over an arbitrary application redirect. The tested `remote-jobs.rss` route returned 410. Start with JSON, `complete: false`, and a 60-minute engineering cadence. Validate nonzero salary values and units instead of interpreting missing/zero as an actual zero salary.

### 6.3 Working Nomads

The [homepage](https://www.workingnomads.com/jobs) links its [exposed jobs endpoint](https://www.workingnomads.com/api/exposed_jobs/). The observed array contains `url`, `title`, `description`, `company_name`, `category_name`, `tags`, `location` and `pub_date`. Use the stable source URL when no provider ID exists. Do not manufacture an ID from array position.

Treat the response as an incomplete discovery feed unless its complete-snapshot semantics are independently established. A 60–120 minute initial cadence is an implementation proposal, not a provider quota.

### 6.4 Himalayas

Use the [documented browse API](https://himalayas.app/api) and [API reference](https://himalayas.app/docs/remote-jobs-api). The UI's 403 did not prevent API access. Follow opaque `nextCursor` values with `limit` at most 20. The provider describes daily cached updates; use daily discovery, with resumable pages. Preserve hiring-country and time-zone restrictions and source attribution.

Observed response: `jobs`, `nextCursor`, `totalCount`, `updatedAt`, `limit`, `offset`. Observed item fields include `guid`, `title`, `companyName`, `companySlug`, `description`, `applicationLink`, `locationRestrictions`, `timezoneRestrictions`, `seniority`, `employmentType`, salary fields and publication/expiry dates.

**Date trap:** the live sample returned `pubDate=1790080189`, a seconds-scale Unix integer. Documentation prose/examples disagree about ISO strings versus milliseconds. Normalize from the validated response type and plausible magnitude; support explicit ISO strings too. Do not blindly multiply an already-millisecond value. Add fixtures for all accepted formats and reject implausible dates. See the follow-up evidence file.

The observed `totalCount` was 104,772. At 20 per page, that is 5,239 requests for a full walk. Do not put that inside one five-minute polling cycle. Persist the cursor and restart a new walk periodically so updated jobs moving ahead of the cursor are rediscovered. Use `complete: false` for bounded discovery; a full pagination walk alone does not make this aggregator authoritative for employer closures.

### 6.5 Arbeitnow Germany and UK

The [official API article](https://www.arbeitnow.com/blog/job-board-api) links public Germany and UK endpoints:

- [Germany job API](https://www.arbeitnow.com/api/job-board-api)
- [UK job API](https://www.arbeitnow.co.uk/api/job-board-api)

Observed shape: `data`, `links`, `meta`; follow `links.next` rather than constructing an unverified stop condition. Job fields: `slug`, `company_name`, `title`, `description`, `remote`, `url`, `tags`, `job_types`, `location`, `created_at`.

Use `slug` within the specific host's namespace. Validate the `next` URL host before requesting it. Metadata in the response says hourly refreshes; hourly discovery is a reasonable starting point. Preserve original source links. `remote: true` still needs country eligibility checks.

### 6.6 RemoteFirstJobs and specialist RSS

[RemoteFirstJobs' RSS guide](https://remotefirstjobs.com/rss) describes category/skill feeds. `/rss` itself is HTML. A [software-development feed](https://remotefirstjobs.com/rss/jobs/software-development.rss) returned 100 items. Choose a small set of broad categories aligned with the existing profile; overlapping category feeds must share canonical deduplication.

Other validated feeds:

| Source | Endpoint | Observed size | Parsing concern |
|---|---|---|---|
| 4dayweek | [feed](https://4dayweek.io/feed) | 50 jobs | Remote scope and reduced hours are separate properties |
| LaraJobs | [feed](https://larajobs.com/feed) | 10 jobs | Namespaced fields and `content:encoded`; retain salary/location |
| VueJobs | [posts feed](https://app.vuejobs.com/feed/posts) | 985 jobs | Large backlog; many roles may fail current preferences |
| Golangprojects | [RSS](https://www.golangprojects.com/rss.xml) | 14 jobs | Missing publication date in sampled item |
| DevOpsJobs | [RSS](https://devopsjobs.io/jobs.rss) | 1,000 jobs | Approximately 7.9 MB; initial smaller response cap truncated XML |
| Remote3 | [RSS](https://www.remote3.co/api/rss) | 8 jobs | Preserve actual dates and restrictions, not homepage-title date |
| Freelancer | [RSS](https://www.freelancer.com/rss.xml) | 20 projects | Optional freelance lane; project terms differ from employment |

Do not automatically subscribe to every possible tag permutation. Poll once per source/feed and reuse the data locally. All these recent feeds should start as `complete: false`.

### 6.7 The Muse

The [official v2 developer page](https://www.themuse.com/developers/api/v2) documents a [jobs endpoint](https://www.themuse.com/api/public/jobs?page=0). A test returned 20 results with `contents`, `name`, `publication_date`, `id`, `locations`, `categories`, `levels`, `refs` and `company`, plus `page_count`.

The documentation requires app registration for use beyond testing. Use registered credentials and read rate-limit response headers. Do not crawl all 20,649 observed pages on every cycle. Validate location/remote filter semantics, then persist pagination and stop on known records only when the sort contract supports that optimization.

### 6.8 Employer ATS expansion

Reuse existing adapters after confirming their tenant-specific limits. The following are templates; replace placeholders with verified identifiers:

```text
Greenhouse: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
Lever:      https://api.lever.co/v0/postings/{site}?mode=json
Lever EU:   https://api.eu.lever.co/v0/postings/{site}?mode=json
Ashby:      https://api.ashbyhq.com/posting-api/job-board/{board_name}?includeCompensation=true
```

Public Greenhouse GET endpoints expose employer job-board data; the root marketing page is not a discovery API. Decode encoded description markup properly and retain job IDs. See [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html).

Lever supports tenant-scoped postings, optional `skip`/`limit` pagination and global/EU instances. Assemble the actual description from the fields returned rather than dropping requirements stored in separate lists. See the [official Lever repository](https://github.com/lever/postings-api).

Ashby's posting API is likewise employer-specific. Preserve listed status, locations, job URL and description; use compensation only when returned. See [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api).

Discover tenants from employer careers links and application destinations found in validated source records. Validate tenant URLs against known host/path patterns, fetch them read-only, then add a verified tenant registry entry. Store the original aggregator observation too. Do not brute-force company names or infer that every ATS root is one board.

## 7. Reverse-engineering procedure for unresolved sites

Do this per source. A site-specific evidence record is a deliverable, not optional notes.

1. **Resolve identity.** Record requested URL, redirect chain, canonical domain and actual jobs route. Distinguish corporate hiring, candidate opportunities, editorial posts and talent enrollment.
2. **Read the published surface.** Inspect site documentation, RSS links, robots/sitemaps and relevant access/attribution terms. Identify any account or partner requirement. Avoid treating a reachable internal endpoint as a supported public API.
3. **Inspect ordinary public navigation.** In a normal browser, open results, one job detail, the next results page and one location filter. In DevTools Network, record only requests caused by these public actions. Filter to Fetch/XHR and inspect structured page state. Do not send job applications or change account state.
4. **Find the smallest stable contract.** Prefer official JSON, then advertised RSS/Atom, then job-specific JSON-LD, server-rendered HTML, embedded page data, and only then ordinary rendered-browser extraction. Browser use is not a reason to work around a block.
5. **Record the request shape.** Method, host/path, public parameters, cursor/page semantics, response keys, source ID, canonical URL and timestamps. For POST search, establish that it is a read-only search operation before replaying it.
6. **Test evidence availability.** Does the list include a full description? If not, inspect one detail request. Make country/time-zone eligibility, employment type and seniority explicit. A snippet is not a full JD.
7. **Test bounds and failures.** Second page, final page, repeated cursor, empty results, invalid ID, changed filter, HTTP 429, timeout and challenge HTML. Never report a blocked page as an empty successful scrape.
8. **Save sanitized fixtures.** Store minimal representative response data and schema notes. Remove cookies, authorization headers, personal data and transient client keys. Record a schema fingerprint and check date.
9. **Implement a pure parser.** Separate network fetch from parsing. Validate output fields before writing rows; do not make Jev repair arbitrary broken parser output.
10. **Shadow-run before enabling alerts.** Measure extracted descriptions, useful new jobs and duplicates. Promote only after the source-specific acceptance tests pass.

`__NEXT_DATA__`, Next.js flight markers, Nuxt state and WordPress markers observed in this research are starting points. They do not establish a stable endpoint. Do not hard-code a Next.js build ID, a rotating search key or a webpack bundle filename from one capture. Do not collect unrelated analytics requests.

For HTML JobPosting extraction, inspect `@graph` and array forms as well as a single object. Preserve `hiringOrganization`, `identifier`, `datePosted`, `validThrough`, `jobLocation`, `jobLocationType`, `applicantLocationRequirements`, `employmentType` and description when present. These are standard concepts, not guaranteed fields on every site; see [Schema.org JobPosting](https://schema.org/JobPosting).

Use a maintained XML parser for feeds and a DOM parser for HTML instead of growing regex-based parsers. [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) and [Cheerio](https://cheerio.js.org/docs/basics/loading/) are candidates; select a maintained compatible release, review security configuration and pin the lockfile when implementing. Preserve XML namespaces and arrays. Reject unsafe entity expansion/DOCTYPE behavior, and bound bytes, depth and item count. Do not install both if only one format is in the first implementation batch.

For Upwork, start with [official API access requirements](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork) and [OAuth guidance](https://support.upwork.com/hc/en-us/articles/115015933448-API-authentication-and-security). For Freelancer, use its [developer portal](https://developers.freelancer.com/) if the observed public RSS is insufficient. Approval, scopes and opportunity semantics are implementation prerequisites; do not pretend the existing TypeSafe key grants access to other providers.
## 8. Data and adapter contracts

### 8.1 Keep source observations separate from canonical jobs

The existing database has `UNIQUE(source_id, key)`. That is useful within a source, but does not merge multiple source rows into one cross-source job. The high-fit event path has a key-based duplicate check; it is not a full provenance-aware identity system.

Use this incremental migration plan:

1. Keep `postings` and current source IDs working.
2. Add a canonical-job reference to postings and a small `canonical_jobs` table. Backfill only high-confidence links initially.
3. Preserve one observation per provider ID/URL, including its original source link, last seen time, description hash and canonical reference.
4. Cache semantic assessments by canonical job content hash, profile fingerprint, model version and question version.
5. Route notifications through the canonical reference; retain source links for attribution and fallback.

Suggested future metadata, not fields already implemented:

```ts
interface SourceObservation {
  sourceId: number;
  externalId: string;
  sourceUrl: string;
  employerApplyUrl: string | null;
  canonicalJobId: number | null;
  fetchedAt: string;
  publishedAt: string | null;
  publishedAtPrecision: "exact" | "date-only" | "relative" | "unknown";
  expiresAt: string | null;
  descriptionText: string | null;
  descriptionHash: string | null;
  remoteMode: "remote" | "hybrid" | "onsite" | "unknown";
  eligibleCountries: string[] | null;
  timezoneRestrictions: string[] | null;
  employmentType: string | null;
  salary: { min: number | null; max: number | null;
            currency: string | null; period: string | null } | null;
  completeness: "discovery-window" | "employer-snapshot";
}
```

`null` means unknown. An empty country list means worldwide only where the provider explicitly documents that convention. Do not generalize that interpretation across sources. Keep exact original restriction text alongside normalized data when the meaning cannot be losslessly represented.

### 8.2 Canonical identity rules

Use this precedence:

1. Same validated ATS tenant + provider job ID.
2. Same canonical employer job URL after removing known tracking parameters.
3. Same provider-specific stable identity.
4. Company/title/location similarity as a **possible duplicate**, with corroborating description or requisition evidence.

Never merge different requisitions solely because a company advertises the same title twice. Never discard source query parameters indiscriminately: some contain the actual job ID. Treat redirect resolution as a bounded fetch with an allowlist and public-network checks; do not follow arbitrary application URLs into local/private services.

When two records disagree, prefer employer-authored description and restrictions, but retain conflict evidence. A worldwide label from an aggregator must not overwrite “US residents only” on the employer's posting.

### 8.3 Use the existing adapter interface for small feeds

Eve's current adapter returns `{ postings, etag }`. `postings: null` means not modified. `postings: []` means a successful empty result. Throwing means failure. These are different outcomes.

A new RSS/aggregator adapter must explicitly set `complete: false`. Register its new `SourceKind`, adapter instance and parser/reference format together. Do not put all 74 homepages into the existing seed file: most are not supported references.

A proposed WWR reference is `weworkremotely:all`; this is **not implemented by this document**. The implementation steps are:

```text
src/types.ts                       add the new SourceKind
src/sources/weworkremotely.ts       fetch feed + pure parse function
src/sources/registry.ts             register adapter and parse supported reference
src/weworkremotely.test.ts          feed fixtures, metadata and closure tests
config/boards.example.json         add the new reference after tests pass
```

For large paginated APIs, do not force an entire backfill into the current one-call snapshot contract. Add persistent discovery cursor state and commit one bounded page/batch at a time. Keep the cursor opaque. Mark the run partial until complete; never let a page cap trigger deletions.

### 8.4 One HTTP layer, source-specific parsers

Implement a reusable request wrapper that provides:

- Per-domain concurrency and a shared domain cooldown, independent of how many query sources exist.
- Timeout/abort support and response-byte limits enforced while reading, not after buffering everything.
- Conditional ETag/Last-Modified requests when supported; no invented validators.
- Content-type and body-shape checks so HTML/login/challenge responses are not parsed as job JSON.
- `Retry-After` handling for seconds or an HTTP date; bounded retries with jitter.
- Redirect host validation on every hop; reject non-HTTP(S), credentials-in-URL and private/link-local destinations.
- Separate results for blocked, malformed, incomplete, not-modified, successful-empty and successful-data.
- Request metrics that redact credentials and sensitive query parameters.

Source response limits should be measured. The DevOpsJobs RSS observation shows why a universal 2 MB cap is insufficient. A 10 MB feed-specific cap or streaming parse can fit that source; keep a strict ceiling and explicit overflow error. Do not remove all limits to accommodate one feed.

## 9. Scheduling and throughput

### 9.1 Poll on source cadence, not one universal interval

Recommended starting values below are engineering choices unless a provider cadence is explicitly documented. Reduce frequency when rate-limit responses or unchanged-data measurements justify it.

| Source family | Initial cadence | Notes |
|---|---|---|
| Small employer ATS boards | 15–60 minutes | Conditional requests; prioritize companies with useful matches |
| WWR / Remote OK / Working Nomads | 30–120 minutes | Recent discovery windows; measure changes |
| Remotive | Every six hours | Existing implementation; provider advises at most four requests/day |
| Himalayas public API | Daily | Provider describes daily cached data |
| Arbeitnow | Hourly | Observed response metadata describes hourly updates |
| Specialist RSS | 1–6 hours | Category yield and publication frequency decide |
| Fragile HTML sources | 2–6 hours initially | Shared domain budget; do not retry blocked queries in a loop |
| A 429/blocked source | Cooldown, not normal polling | Honor explicit retry guidance; surface access failures separately |

A source's last successful fetch does not by itself control failure traffic. Persist `next_attempt_at` and domain-level cooldown separately from `last_poll`. Otherwise many LinkedIn queries can independently hit the same throttled domain.

### 9.2 Decouple ingestion from scoring

Today, `runCycle()` fetches sources sequentially and calls `scoreCycle()` afterward. More sources and long pagination walks can delay all matching. Add a separate scoring worker/service over the same SQLite database before large rollout. The poller should discover/store; the scorer should consume eligible work; the Discord process should continue draining its outbox.

Keep one scorer initially. For multiple workers, add atomic work claiming with a lease and expiration, then commit results only if the input content/profile version still matches the claimed task. Never hold a SQLite transaction open during a network request. Enable WAL and retain a busy timeout.

Fair scheduling matters more than a larger concurrency number. Current unscored selection is newest-first. Under continuous load, older valid candidates can starve. A reasonable starting allocation is 70% fresh work, 20% oldest waiting work and 10% due retries, with unused slots shared. This split is a proposed policy to benchmark, not an established optimal ratio.

### 9.3 Size the workload honestly

At the default 25 attempted candidates every five minutes, the ideal ceiling is 7,200 candidates/day. That is an upper bound: long source cycles, disabled time, description failures and rule-rejected rows lower useful throughput. Adding 74 entries does not increase classifier capacity automatically.

Track:

```text
new observations/day
unique canonical jobs/day
jobs passing geography/hard rules/day
jobs with usable descriptions/day
Jev requests/day and actual input tokens
oldest unscored age and queue size
strong matches/day and rejected/unknown breakdown
Discord queued, delivered, suppressed and retry counts
```

For illustration, 10,000 Jev evaluations averaging 4,000 billed input tokens is 40 million input tokens. At the currently listed Jev 1.13 price of $0.042 per million input tokens, that arithmetic is $1.68/day for inference alone. This is an estimate, not measured Eve consumption; include all billed question/state tokens, retries and actual provider usage. Recheck [TypeSafe's model pricing and limits](https://docs.typesafe.ai/models) before budgeting. Scraper maintenance, hosting and any paid source access are separate costs.

Do not score the same employer job once per aggregator. Deduplication before inference reduces both cost and repeated alerts. A global feed with 100,000 jobs also needs a separate backfill budget so historical imports cannot bury fresh opportunities.

## 10. Jev decision policy and quality evaluation

Preserve the five current mandatory questions: experience/seniority, education, language, work authorization/remote restrictions, and mandatory technologies/work. Preserve duties/profile relevance as a separate graded question. Jev's output is typed evidence for application code; it does not fetch jobs, establish legal eligibility or guarantee factual correctness. See [TypeSafe API](https://docs.typesafe.ai/api) and [Score documentation](https://docs.typesafe.ai/primitives/score).

Use four application states:

| State | Meaning | Action |
|---|---|---|
| Pass | All required dimensions satisfied, fit and confidence meet thresholds | Queue one canonical-job match |
| Reject | Explicit incompatible requirement or insufficient fit | Store reason; no match alert |
| Unknown | Missing/ambiguous eligibility or other required evidence | Retain for enrichment/review; do not discard as a proven mismatch |
| Error | Timeout, malformed response, quota/access failure | Retry according to policy; never convert to a zero-fit decision |

Model confidence and evidence completeness are different. For example, “unknown work authorization” can be a very confident answer. High confidence in unknown must still not pass. A high relevance score must not compensate for a mandatory location restriction.

Build a labeled evaluation set of 200–300 jobs before tuning the current 75/80% defaults. Include remote-worldwide, remote-US-only, Germany hybrid, India onsite, UK sponsorship-required, internships, ambiguous languages, missing descriptions, German-language descriptions, attractive but senior jobs and deliberately irrelevant titles.

Measure useful-alert precision, missed-good-job rate, unknown rate and results by source/language. Inspect some rejected and unknown jobs every week; measuring only clicked alerts cannot reveal silent false negatives. The current strict requirement wording may classify unstated requirements as unknown. Any change to that behavior needs explicit evaluation and a question-version change, not just a lower confidence threshold.

Treat job descriptions as untrusted data. Do not follow instructions embedded in a JD. Keep API credentials out of state and fixtures. Preserve the profile section allowlist; do not send contact/address fields just because a new source has more metadata.

## 11. Known repository issues and scaling traps to address

These findings are based on the current working tree, not an assumption that the old HANDOUT.md describes the latest implementation.

| Finding | Evidence | Required implementation response |
|---|---|---|
| Scoring waits behind all source fetches | `src/poller.ts`: `runCycle` source loop precedes `scoreCycle` | Separate scoring work from ingestion before broad backfills |
| Old candidates can starve | `src/db.ts`: profile queue sorts newest first | Add fair scheduling and oldest-work monitoring |
| Source-local rows are not canonical deduplication | `src/schema.sql`: unique constraint is `(source_id, key)` | Preserve cross-source observations under a canonical identity |
| Alert dedupe currently considers historical high-fit events | `src/poller.ts`: high-fit lookup checks any matching key | Define policy for genuine reposts/reopened requisitions; don't suppress forever accidentally |
| Strict missing-requirement interpretation can hide jobs | `src/jev.ts`: requirements must be satisfied; unknown blocks delivery | Audit unknown reasons and validate wording against human labels |
| Role-family labels do not encode numeric priority weights | `src/jev.ts` sends `roleLabels`; `src/roles.ts` holds priorities separately | Do not claim exact priority weighting is already preserved; encode/test it if required |
| Decorated leadership titles can evade the phrase exclusion | `src/roles.ts`: regex contains contiguous `head of` | Add a fixture for `Head (m/f/x) of Engineering`; Jev may still reject it, but the cheap rule misses the phrase |
| Enrichment supports only selected hosts and a 2 MB page limit | `src/enrich.ts` | New board-specific detail paths need explicit support; avoid arbitrary URL fetching |
| Unknown results are cached like other successful results | `src/jev.ts` / `src/db.ts` cache keys | Re-evaluate when evidence changes; consider scheduled review for unresolved cases |
| Suppressed delivery events are deleted | `src/delivery.ts` | Add suppression counters/reasons if operations need an audit trail |
| Raw source completeness defaults can be dangerous | `Adapter.complete` is optional | Set false explicitly on every new feed/search adapter; preserve snapshot protections |
| A secret-bearing activation backup is untracked and unignored | `.gitignore` ignores `.env`, not `.env.before-profile-*` | Before sharing or committing, exclude/move these backups; never include them in fixtures or an archive |

The backup issue is a concrete local finding, not a hypothetical warning. Suggested `.gitignore` rule when implementing the cleanup:

```gitignore
.env.*
!.env.example
```

Review the intended tracked env templates before adopting a broader rule. Keep private backups outside the repository where practical. This handoff contains no credentials and does not require sharing the live `.env`, profile or database.

## 12. Acceptance tests your friend should implement

### Parser and transport tests

- A valid response yields stable IDs, titles, company, source URL and description where available.
- HTML returned from an API endpoint is an error, not zero jobs.
- RSS namespaces, `content:encoded`, CDATA and single-versus-array items survive parsing.
- Remote OK metadata never becomes a job.
- Jobspresso's empty RSS and Dynamite's blog RSS do not become false vacancy records.
- A 7.9 MB DevOpsJobs feed succeeds within its measured bound; an oversized response fails explicitly.
- Missing `pubDate` remains unknown; seconds/milliseconds/ISO dates normalize correctly.
- Redirects to unexpected/private hosts are rejected, including on paginated next URLs.
- A 429 pauses all sources on that domain; other domains continue.
- Pagination terminates on the provider's actual completion marker, detects repeated cursors and persists progress across restart.

### Storage and discovery tests

- Re-fetching the same input produces no duplicate observation or match event.
- A job seen on two aggregators and an ATS merges only with strong identity evidence; source attribution remains.
- Two distinct requisitions with identical company/title/location do not merge automatically.
- A page cap, timeout or empty recent feed never mass-closes employer jobs.
- Filter changes re-baseline safely rather than generating false closures.
- Complete employer snapshots retain existing mass-delist protection.
- New input content invalidates matching; unrelated tracking-URL changes do not force unnecessary inference.

### Matching and Discord tests

- High-confidence rejection, high-confidence unknown and low-confidence positive answers do not pass.
- Worldwide remote and country-restricted remote roles remain distinct.
- Missing descriptions enter enrichment/retry, not a fabricated rejection score.
- Changing a profile/model/question version invalidates relevant results.
- Changing thresholds reuses valid stored model results.
- Queue fairness allows older eligible work to progress under continuous new arrivals.
- A model outage does not stop ingestion or raw storage.
- Discord failure leaves a pending event for retry; source failures do not lose it.
- A source title containing mention syntax cannot create unintended Discord mentions.
- Every displayed third-party listing includes required attribution and its original source link.
- Cold backfill respects a notification rate limit/digest policy rather than sending hundreds of pings.

### Source-specific release evidence

Each adapter's PR should include: checked date, official endpoint/docs or public-page evidence, one sanitized listing fixture, one detail fixture when needed, pagination behavior, completeness decision, expected ID semantics, measured description coverage, cadence/cooldown settings, attribution requirements, and known access limitations.

A source is not “done” because its homepage returned 200. It is done when the tests prove that useful, correctly attributed jobs reach the queue without false closures or repeated alerts.

## 13. Operational rollout

1. **Use a separate test database and disable Discord delivery.** Never run fixture tests against the live `RADAR_DB`.
2. **Record the baseline.** Run `npm test` and `npm run typecheck`; inspect source counts and queue age. The preceding Jev implementation passed 276 tests, but re-run on the exact checkout your friend receives.
3. **Land shared transport and source scheduling.** Keep existing adapters behaving the same; test domain cooldown and long-source isolation.
4. **Implement one representative JSON source and one RSS source.** Remote OK and WWR are useful examples because they expose metadata and namespace pitfalls.
5. **Run one bounded read-only smoke fetch.** Do not seed the production database merely to test parsing.
6. **Register validated sources into the test database.** Seed quietly. Confirm the parser preserved the full descriptions and remote restrictions.
7. **Shadow-score a labeled sample.** Compare Jev decisions with human labels without sending alerts. Persist per-dimension results and provider token usage.
8. **Enable a small live batch.** Monitor request failures, duplicate rate, oldest work, unknown rate and useful matches for 24–48 hours.
9. **Add the next batch based on incremental yield.** Keep blocked or empty sources visible as disabled candidates, not silently “supported.”
10. **Retain a rollback route.** Disabling a new source must not delete job history, claims or applied state. Back up SQLite consistently; preserve the outbox. Restart only Eve's affected user services, not desktop/system services.

Current local verification commands:

```bash
npm test
npm run typecheck
systemctl --user status eve-bot.service eve-poll.timer eve-dashboard.service
journalctl --user -u eve-poll.service -n 80 --no-pager
```

Future worker commands/services must be documented when implemented; there is no `eve-score.service` merely because this guide proposes one. Likewise, the source catalog must not be passed to `seed-boards.ts` until supported reference strings have been deliberately generated from implemented adapters.

## 14. Work packages and definition of completion

| Package | Files/responsibility | Completion evidence |
|---|---|---|
| A. Reliable HTTP/scheduling | Shared source HTTP helpers, source state, poll scheduling | Per-domain cooldown, byte/time limits, resumable pages and no false-empty errors |
| B. Public JSON feeds | New adapters for Remote OK, Working Nomads, Himalayas, Arbeitnow and registered Muse | Field/pagination fixtures, source-specific rate settings and full-description coverage |
| C. RSS family | Shared XML parsing plus WWR, RemoteFirstJobs and chosen specialist adapters | Namespace/size tests, stable identity and incomplete-feed handling |
| D. Employer discovery | ATS URL validation, verified tenant inventory, canonical identity links | Discovered tenants validated without brute-force, no repeated inference for duplicates |
| E. Matching throughput | Separate scoring worker, queue leases/fairness, token metrics | Model outage isolation and bounded oldest-work age |
| F. Delivery/quality | Canonical outbox policy, attribution, cold-start rate controls, evaluation fixtures | Useful matches, duplicate control, unknown/rejection audit and reliable retries |
| G. Unresolved boards | One investigation record per P2/HOLD source | Public access and exact parser contract established, or an explicit disabled reason |

These are ownership boundaries, not a requirement to build a large team or create seven services. Start with A plus one JSON and one RSS adapter, then expand measured coverage.

The overall expansion is complete when every requested source is accounted for as implemented, intentionally deferred with evidence, or access-dependent; implemented sources pass the release criteria; and the existing geography/profile rules still determine what reaches Discord. A catalog entry alone does not count as integration.

## 15. Research limitations to carry forward

This research establishes HTTP reachability, redirects and selected response contracts. It does not establish browser behavior for every dynamic site, account entitlements, a complete terms review, long-term stability, exhaustive job inventories or sustained throughput. Unresolved paths are identified individually in the inventory rather than filled with guessed APIs.

Two concrete examples explain the distinction: Himalayas' public UI failed while its API worked, and DevOpsJobs initially looked unparsable only because the bounded probe cut a valid large feed short. Conversely, a successful marketing page or editorial RSS says nothing about actual vacancy extraction.

The fastest useful implementation is to use the validated machine-readable sources, preserve evidence and attribution, add employer ATS discovery, and measure the jobs unique to each later HTML integration.
