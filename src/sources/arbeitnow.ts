import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { cleanString, httpUrl, isRecord, isoDate, stripHtml } from "./index.ts";
import { fetchJson } from "../http.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Arbeitnow's documented job-board API, in its German and UK variants.
 *
 * Evidence (2026-09-22): the German endpoint returned 250 jobs and the UK
 * endpoint 100, both `{data, links, meta}` with `links.next` pointing at the
 * next page on the same host. Job fields: `slug`, `company_name`, `title`,
 * `description`, `remote`, `url`, `tags`, `job_types`, `location`, `created_at`.
 * The response's own metadata says jobs update hourly and are ordered by
 * `created_at`, which is what makes a bounded head walk safe: page 1 is the
 * newest work.
 *
 * Decisions worth naming:
 *
 *   - `complete: false`. Even though `links.next` would technically allow
 *     walking to the end, a truncated walk (page cap, timeout) must never read
 *     as a mass delisting, and the API is a feed, not an employer inventory.
 *   - The next-page URL is validated against the board's own host before being
 *     followed. An API that starts pointing elsewhere is a bug or a compromise,
 *     and either way not something to fetch.
 *   - A blank `location` stays null on both boards. The UK board is UK-focused,
 *     but "listed on a UK board" is not the same as "the employer stated a UK
 *     location", and storing that inference would turn missing evidence into a
 *     confirmed location the filter and Jev both trust. The cost is real and
 *     accepted: blank-location, non-remote rows are dropped by the profile
 *     filter instead of being guessed into the feed.
 *   - `created_at` is Unix seconds; `isoDate` handles that and the UK board's
 *     HTML is entity-escaped (`&lt;p&gt;`), so it is decoded before stripping.
 */

const BOARDS = {
  de: { api: "https://www.arbeitnow.com/api/job-board-api", host: "www.arbeitnow.com" },
  uk: { api: "https://www.arbeitnow.co.uk/api/job-board-api", host: "www.arbeitnow.co.uk" },
} as const;

type Board = keyof typeof BOARDS;

/** 5 pages: 1250 German jobs or 500 UK jobs per hourly poll — a deep enough head. */
const MAX_PAGES = 5;

const REF_RE = /^arbeitnow:(de|uk)$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?arbeitnow\.(com|co\.uk)(?:\/.*)?$/i;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = REF_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const board = (m[1] === "co.uk" || m[1] === "uk" ? "uk" : "de") as Board;
  return {
    kind: "arbeitnow",
    ident: board,
    label: board === "uk" ? "Arbeitnow UK" : "Arbeitnow Germany",
  };
}

/** Same trick as Greenhouse: decode entity-escaped markup before stripping it. */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function toPosting(v: Record<string, unknown>): FetchedPosting | null {
  const slug = cleanString(v.slug);
  const title = cleanString(v.title);
  const company = cleanString(v.company_name);
  const url = httpUrl(v.url);
  if (!slug || !title || !company || !url) return null;

  const remote = v.remote === true;
  const location = cleanString(v.location);

  const tags = Array.isArray(v.tags)
    ? v.tags.map((t) => cleanString(t)).filter((t): t is string => t !== null)
    : [];
  const jobTypes = Array.isArray(v.job_types)
    ? v.job_types.map((t) => cleanString(t)).filter((t): t is string => t !== null)
    : [];

  const rawDescription = cleanString(v.description);

  return {
    externalId: slug,
    title,
    company,
    location,
    remote,
    department: tags[0] ?? jobTypes[0] ?? null,
    url,
    postedAt: isoDate(v.created_at),
    closesAt: null,
    description: stripHtml(rawDescription ? unescapeEntities(rawDescription) : null),
  };
}

/** One page plus the validated next-page hint. */
export function parseArbeitnowPage(raw: unknown, board: Board): {
  postings: FetchedPosting[];
  next: string | null;
} {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new Error(`Arbeitnow ${board}: response has no data array`);
  }
  const postings = raw.data
    .map((job) => (isRecord(job) ? toPosting(job) : null))
    .filter((p): p is FetchedPosting => p !== null);
  if (raw.data.length > 0 && postings.length === 0) {
    throw new Error(`Arbeitnow ${board}: ${raw.data.length} jobs but none usable`);
  }
  const links = isRecord(raw.links) ? raw.links : {};
  return { postings, next: cleanString(links.next) };
}

async function fetchBoard(ident: string, _etag: string | null): Promise<FetchResult> {
  const board = (ident === "uk" ? "uk" : "de") as Board;
  const expected = BOARDS[board];
  const collected = new Map<string, FetchedPosting>();
  let url: string | null = expected.api;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const { body } = await fetchJson(url, {
      maxBytes: 5_000_000,
      allowHost: (host) => host === expected.host || host === expected.host.replace(/^www\./, ""),
    });
    if (body === null) break;
    const parsed = parseArbeitnowPage(body, board);
    for (const posting of parsed.postings) collected.set(posting.externalId, posting);

    if (!parsed.next) break;
    let next: URL;
    try {
      next = new URL(parsed.next);
    } catch {
      throw new Error(`Arbeitnow ${board}: unparseable next link ${parsed.next}`);
    }
    if (next.hostname !== expected.host) {
      throw new Error(`Arbeitnow ${board}: next page points at ${next.hostname}, refusing`);
    }
    url = next.href;
  }

  return { postings: [...collected.values()], etag: null };
}

export const arbeitnow: Adapter = {
  kind: "arbeitnow",
  complete: false,
  minPollIntervalMs: 60 * 60_000,
  domain: (ident) => BOARDS[ident === "uk" ? "uk" : "de"].host,
  parse,
  fetch: fetchBoard,
};
