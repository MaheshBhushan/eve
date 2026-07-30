import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { getJson, stripHtml } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Recognises `smartrecruiters:slug`, `jobs.smartrecruiters.com/slug` and
 * `careers.smartrecruiters.com/slug` (the host the former 301-redirects to).
 */
const PREFIX_RE = /^smartrecruiters:([a-z0-9][a-z0-9._-]*)$/i;
const URL_RE =
  /^(?:https?:\/\/)?(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9][a-z0-9._-]*)(?:[/?].*)?$/i;

/** Postings API page size ceiling. Asking for 500 silently yields 100. */
const PAGE_SIZE = 100;
/**
 * Request cap. The largest board found while building the example config was
 * Bosch Group at ~4,750 postings, so 80 pages leaves generous headroom while
 * still bounding a runaway loop if `totalFound` ever disagrees with reality.
 */
const MAX_PAGES = 80;
/**
 * How many job descriptions to pull per poll. The list endpoint carries no JD
 * body, so each one costs a separate request -- 4,750 of those per cycle is out
 * of the question. See fetchDescriptions for why "newest first" is the right
 * subset to spend the budget on.
 */
const DESCRIPTION_BUDGET = 25;

interface SrPosting {
  id: string;
  name: string;
  releasedDate?: string | null;
  company?: { identifier?: string | null; name?: string | null } | null;
  location?: {
    city?: string | null;
    region?: string | null;
    country?: string | null;
    remote?: boolean | null;
    hybrid?: boolean | null;
  } | null;
  department?: { label?: string | null } | null;
  function?: { label?: string | null } | null;
  typeOfEmployment?: { label?: string | null } | null;
  experienceLevel?: { label?: string | null } | null;
}

interface SrPage {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: SrPosting[];
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  // The API treats slugs case-insensitively (`Continental`, `continental` and
  // `CONTINENTAL` all return the same 918 postings), so lowercasing is safe and
  // keeps one board from being watched twice under two spellings.
  const ident = m[1].toLowerCase();
  return { kind: "smartrecruiters", ident, label: ident };
}

/**
 * `location.fullLocation` is unusable: SmartRecruiters joins city/region/country
 * blindly, so a posting with no region reads "Celaya Planta, , Mexico". Rebuild
 * it from the parts, uppercasing the ISO country code the API returns lowercase.
 * This string feeds both the dedupe key and the location filter, so it has to be
 * canonical rather than merely human-readable.
 */
function cleanLocation(loc: SrPosting["location"]): string | null {
  const country = loc?.country?.trim();
  const parts = [
    loc?.city?.trim(),
    loc?.region?.trim(),
    country && country.length <= 3 ? country.toUpperCase() : country,
  ].filter((s): s is string => !!s && s.length > 0);
  return parts.length ? parts.join(", ") : null;
}

function toPosting(p: SrPosting, slug: string): FetchedPosting {
  return {
    externalId: String(p.id),
    title: p.name,
    // The board states its own display name ("Bosch Group" for slug
    // `boschgroup`), which is nicer than the slug when it is there.
    company: p.company?.name || slug,
    location: cleanLocation(p.location),
    remote: p.location?.remote ?? null,
    // `department` is frequently `{}` on large boards while `function` is
    // populated, so fall through to the job family rather than showing nothing.
    department: p.department?.label ?? p.function?.label ?? null,
    // The list endpoint carries no applyUrl -- only `ref`, which points back at
    // the API. This canonical form redirects to the slugged public posting page.
    url: `https://jobs.smartrecruiters.com/${slug}/${p.id}`,
    postedAt: p.releasedDate ?? null,
    closesAt: null, // No deadline field on the public postings API.
    description: null, // Filled in by fetchDescriptions where budget allows.
  };
}

/** One page of the postings list. Throws unless the page is well-formed. */
async function fetchPage(slug: string, offset: number): Promise<SrPage> {
  const url =
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings` +
    `?limit=${PAGE_SIZE}&offset=${offset}`;
  // ETags are deliberately not used here: they are computed per page, so a 304
  // on page 0 says nothing about pages 1..n and would let a change deep in a
  // 1,000-posting board go unnoticed for a cycle.
  const { body } = await getJson(url, null);
  const page = body as SrPage;
  if (!page || !Array.isArray(page.content) || typeof page.totalFound !== "number") {
    throw new Error(
      `smartrecruiters ${slug} returned an unexpected page shape at offset ${offset}`,
    );
  }
  return page;
}

/**
 * Distinguish "real company, nothing open right now" from "slug is wrong".
 *
 * This is the same trap the Lever adapter exists for, but worse: an unknown
 * company answers HTTP 200 with `{"offset":0,"limit":1,"totalFound":0,
 * "content":[]}` -- byte-identical to a real customer between hiring rounds
 * (verified: `lidl` and `Bosch1` are real tenants currently at zero). There is
 * no company-metadata endpoint on api.smartrecruiters.com (it 404s for every
 * slug), so the careers-site widget API is the only existence oracle found:
 * 200 for a real company, 404 for an unknown one. It is only consulted when
 * totalFound is 0, so the normal path stays at one request per page.
 */
async function assertCompanyExists(slug: string): Promise<void> {
  const res = await fetch(`https://careers.smartrecruiters.com/${slug}/api/groups`, {
    headers: { "user-agent": "job-radar" },
  });
  if (res.status === 404) {
    throw new Error(
      `smartrecruiters company "${slug}" does not exist (careers site returns 404); check the slug`,
    );
  }
  if (!res.ok) {
    // Any other failure is inconclusive, and refusing to register a board on an
    // unrelated outage would be worse than accepting an empty one.
    return;
  }
}

/**
 * Pull JD bodies for at most DESCRIPTION_BUDGET postings, newest first.
 *
 * The adapter cannot see which postings the poller already knows, so newest-by-
 * releasedDate is the available proxy for "new since last cycle": anything the
 * poller is about to record as opened is, by construction, among the most
 * recently released. On boards that publish more than the budget between two
 * polls some JDs are lost for good -- that is a deliberate trade against
 * thousands of requests per cycle, and it only degrades fit scoring for those
 * postings. Individual failures are swallowed: a missing description is
 * acceptable, aborting the whole snapshot over one is not.
 */
async function fetchDescriptions(slug: string, postings: FetchedPosting[]): Promise<void> {
  const newest = [...postings]
    .filter((p) => p.postedAt != null)
    .sort((a, b) => (a.postedAt! < b.postedAt! ? 1 : -1))
    .slice(0, DESCRIPTION_BUDGET);

  await Promise.all(
    newest.map(async (p) => {
      try {
        const { body } = await getJson(
          `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${p.externalId}`,
          null,
        );
        const sections = (body as {
          jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
        })?.jobAd?.sections;
        if (!sections) return;
        // Fixed section order: the API returns an object, whose key order is
        // not guaranteed, and a JD that starts with "Additional Information"
        // reads as noise to the fit scorer.
        const parts: string[] = [];
        for (const key of [
          "jobDescription",
          "qualifications",
          "additionalInformation",
          "companyDescription",
        ]) {
          const text = stripHtml(sections[key]?.text ?? null);
          if (text) parts.push(text);
        }
        p.description = parts.join("\n\n") || null;
      } catch {
        /* leave description null -- see doc comment */
      }
    }),
  );
}

async function fetchBoard(ident: string, _etag: string | null): Promise<FetchResult> {
  const first = await fetchPage(ident, 0);
  const total = first.totalFound ?? 0;

  if (total === 0) {
    await assertCompanyExists(ident);
    return { postings: [], etag: null };
  }

  const raw: SrPosting[] = [...(first.content ?? [])];
  let pages = 1;
  while (raw.length < total && pages < MAX_PAGES) {
    const page = await fetchPage(ident, raw.length);
    // An empty page before totalFound is reached means the board stopped
    // talking mid-walk. Returning what we have would look like a mass
    // delisting and close every posting we failed to read, so throw instead --
    // the snapshot contract requires all-or-nothing.
    if (!page.content?.length) {
      throw new Error(
        `smartrecruiters ${ident} truncated: got ${raw.length} of ${total} postings ` +
          `(empty page at offset ${raw.length})`,
      );
    }
    raw.push(...page.content);
    pages++;
  }

  if (raw.length < total) {
    throw new Error(
      `smartrecruiters ${ident} exceeded the ${MAX_PAGES}-page cap with ` +
        `${raw.length} of ${total} postings; refusing to return a partial snapshot`,
    );
  }

  // totalFound is a live count, so a posting published mid-walk can push the
  // tail past it and duplicate an id across pages. Deduping by id keeps the
  // snapshot honest without a second pass.
  const byId = new Map<string, FetchedPosting>();
  for (const p of raw) {
    if (p?.id == null) continue;
    byId.set(String(p.id), toPosting(p, ident));
  }
  const postings = [...byId.values()];

  await fetchDescriptions(ident, postings);
  return { postings, etag: null };
}

export const smartrecruiters: Adapter = {
  kind: "smartrecruiters",
  parse,
  fetch: fetchBoard,
};
