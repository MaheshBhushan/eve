/**
 * LinkedIn guest job-search adapter -- unauthenticated, direct HTTP.
 *
 * `linkedin-guest/jobs/api/seeMoreJobPostings/search` is the endpoint LinkedIn's
 * own "load more" pagination hits from a signed-out browser. It returns an
 * HTML fragment of `<li>` job cards, no cookies or auth required.
 *
 * Like `browser.ts`, this is a ranked, capped search, never a full snapshot:
 * `complete === false`, and the poller must never infer closure from absence.
 * See browser.ts's header for the full rationale -- it applies verbatim here.
 *
 * f_TPR=r604800 (last 7 days) + sortBy=DD (newest first) keep this adapter
 * useful for freshness alerts even though it can never be exhaustive. Page
 * size is 10; we fetch start=0,10,20,30 (4 pages max) and stop as soon as a
 * page comes back empty. Requests are spaced ~1s apart.
 *
 * Publish time: the card's `<time datetime="YYYY-MM-DD">` is date-only, but
 * its text is a relative age ("3 hours ago", "23 minutes ago") with the
 * precision the freshness alert actually needs. The text is resolved against
 * the fetch clock and wins; the attribute is the fallback when the text is
 * absent or unparseable (LinkedIn localises it per Accept-Language).
 *
 * There are deliberately NO evasion techniques: a 429 or 999 response throws
 * immediately, no retry, no backoff-and-retry, no header rotation. That is
 * the site telling us to stop.
 */

import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting, SourceKind } from "../types.ts";
import { stripHtml } from "./index.ts";
import { canon, ANY_LOCATION } from "./browser.ts";

const KIND: SourceKind = "linkedin";

const SEARCH_URL =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";

const PAGE_SIZE = 10;
const MAX_PAGES = 4;
const REQUEST_SPACING_MS = 1000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** `linkedin:<query>@<location>`. Ident and label shape mirror browser.ts. */
function makeIdent(query: string, location: string): string {
  const q = canon(query);
  const l = canon(location) || ANY_LOCATION;
  // No site prefix: the source's `kind` already says which board this is, and
  // the bot prints `kind:ident`, so a prefix here would show up doubled.
  return `${q}@${l}`;
}

function splitIdent(ident: string): { query: string; location: string } {
  const at = ident.lastIndexOf("@");
  if (at < 0) throw new Error(`not a linkedin ident: ${ident}`);
  return { query: ident.slice(0, at), location: ident.slice(at + 1) };
}

function label(query: string, location: string): string {
  const l = canon(location);
  return `LinkedIn: ${canon(query)}${l ? `, ${l}` : ""}`;
}

/** `linkedin:machine learning engineer@Berlin`. */
function parsePrefixed(input: string): ParsedRef | null {
  const m = /^linkedin\s*:\s*(.+)$/i.exec(input);
  if (!m) return null;
  const rest = m[1]!;
  const at = rest.lastIndexOf("@");
  const query = at >= 0 ? rest.slice(0, at) : rest;
  const location = at >= 0 ? rest.slice(at + 1) : "";
  if (!canon(query)) return null;
  return { kind: KIND, ident: makeIdent(query, location), label: label(query, location) };
}

/** A pasted `linkedin.com/jobs/search?keywords=...&location=...` URL. */
function parseUrl(input: string): ParsedRef | null {
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().includes("linkedin.")) return null;
  const query = url.searchParams.get("keywords") ?? "";
  if (!canon(query)) return null;
  const location = url.searchParams.get("location") ?? "";
  return { kind: KIND, ident: makeIdent(query, location), label: label(query, location) };
}

function parse(input: string): ParsedRef | null {
  const s = input.trim();
  if (!s) return null;
  try {
    return parseUrl(s) ?? parsePrefixed(s);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- fetch --- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `<li>` job card -> a posting, or null if a required field is missing. */
export function parseCard(li: string, now = Date.now()): FetchedPosting | null {
  const urn = /data-entity-urn="urn:li:jobPosting:(\d+)"/.exec(li);
  if (!urn || !urn[1]) return null;
  const externalId = urn[1];

  const titleM = /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/.exec(li);
  const title = stripHtml(titleM?.[1])?.trim();
  if (!title) return null;

  const companyM = /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/.exec(li);
  const company = stripHtml(companyM?.[1])?.trim();
  if (!company) return null;

  const locationM = /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(li);
  const location = stripHtml(locationM?.[1])?.trim() ?? null;

  const timeM = /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/time>/.exec(li);
  const postedAt =
    parseRelativeAge(stripHtml(timeM?.[2]) ?? "", now) ??
    (timeM?.[1] ? new Date(timeM[1]).toISOString() : null);

  return {
    externalId,
    title,
    company,
    location,
    remote: null,
    department: null,
    url: `https://www.linkedin.com/jobs/view/${externalId}`,
    postedAt,
    closesAt: null,
    description: null,
  };
}

const REL_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/**
 * "3 hours ago" / "1 minute ago" / "2 weeks ago" -> ISO timestamp, or null.
 * Anything not in this exact English shape (localised text, "just now",
 * "30+ days ago") returns null and the caller falls back to the date attribute.
 */
export function parseRelativeAge(text: string, now = Date.now()): string | null {
  const m = /^\s*(\d+)\s+(minute|hour|day|week|month)s?\s+ago\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = REL_UNIT_MS[m[2]!.toLowerCase()];
  if (!unit || !Number.isFinite(n)) return null;
  return new Date(now - n * unit).toISOString();
}

/** Split an HTML fragment into its `<li>` job cards. */
export function extractCards(html: string): string[] {
  const cards: string[] = [];
  const re = /<li[^>]*>[\s\S]*?data-entity-urn="urn:li:jobPosting:\d+"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) cards.push(m[0]);
  return cards;
}

async function fetchPage(query: string, location: string, start: number): Promise<string> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("keywords", query);
  if (location) url.searchParams.set("location", location);
  url.searchParams.set("f_TPR", "r604800");
  url.searchParams.set("sortBy", "DD");
  url.searchParams.set("start", String(start));

  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });

  // 429/999 are LinkedIn's rate-limit / bot-block signals: throw, no retry, no evasion.
  if (res.status === 429 || res.status === 999) {
    throw new Error(`${url} -> HTTP ${res.status}: rate-limited or blocked, backing off`);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

export const linkedin: Adapter & { readonly complete: false } = {
  kind: KIND,

  /** Partial source: see the module header and browser.ts. */
  complete: false,

  parse,

  async fetch(ident: string, _etag: string | null): Promise<FetchResult> {
    const { query, location } = splitIdent(ident);
    const loc = location === ANY_LOCATION ? "" : location;

    const postings: FetchedPosting[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const start = page * PAGE_SIZE;
      if (page > 0) await sleep(REQUEST_SPACING_MS);
      const html = await fetchPage(query, loc, start);
      const cards = extractCards(html);

      if (cards.length === 0) {
        // Empty fragment on the first page is a legitimate "no results in the
        // window". Empty on the first page with a non-empty body that isn't a
        // fragment (login/authwall) means we were blocked -- throw.
        if (page === 0 && html.trim().length > 0 && !/<li/i.test(html)) {
          throw new Error(
            "linkedin guest search returned no job cards and no empty fragment " +
              "-- likely an authwall or login page",
          );
        }
        break;
      }

      for (const card of cards) {
        const posting = parseCard(card);
        if (posting) postings.push(posting);
      }
    }

    return { postings, etag: null };
  },
};
