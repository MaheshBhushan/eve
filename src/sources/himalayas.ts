import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { cleanString, httpUrl, isRecord, isoDate, stripHtml } from "./index.ts";
import { fetchJson } from "../http.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Himalayas, via the documented browse API.
 *
 * Evidence (2026-09-22): the jobs UI answered 403 to an unauthenticated probe
 * while https://himalayas.app/jobs/api?limit=1 returned valid JSON, i.e. the
 * block is on the rendered page, not the API. Response shape: `jobs`,
 * `nextCursor`, `totalCount` (104k), `limit`, `offset`, `updatedAt`; items carry
 * `guid`, `title`, `companyName`, `description`, `applicationLink`,
 * `locationRestrictions`, `timezoneRestrictions`, `seniority`, `employmentType`,
 * salary fields, `pubDate`, `expiryDate`.
 *
 * COVERAGE MODEL. `totalCount` around 104k at 20 per page is a 5,239-request
 * full walk, and the list moves fast — a measured 200-job window covered 4.2
 * hours, i.e. roughly 1,150 new jobs a day. A fixed head-only walk therefore
 * misses most arrivals between daily polls, and a fixed deep-only walk never
 * sees the head. So each poll does two bounded walks, resuming from an opaque
 * cursor this adapter owns:
 *
 *   1. a head walk from the newest job downwards, stopping once it reaches the
 *      watermark (the newest `pubDate` the previous head walk already covered).
 *      This is the fresh-job budget: it fetches exactly what is new, however
 *      much that is, up to MAX_HEAD_PAGES. On the very first run there is no
 *      watermark, so the first head walk is deliberately small and the
 *      background walk takes over from there.
 *   2. a background walk of MAX_BG_PAGES pages resuming from where the previous
 *      background walk stopped, so the historical tail is covered a slice at a
 *      time and nothing is permanently unreachable. When it reaches the end the
 *      cursor resets and the next background walk starts from the head again.
 *
 * The two walks are contiguous: the head walk ends where the previous poll's
 * coverage began, and the background walk picks up exactly where the previous
 * one stopped (or where this poll's head walk stopped, when starting a new
 * background walk). Every job is fetched at least once as the list shifts; the
 * historical slice is not silenced by any freshness gate, because profile
 * matches are allowed to surface older open jobs.
 *
 * ELIGIBILITY. `locationRestrictions` and `timezoneRestrictions` are evidence,
 * and missing evidence must never read as permission. Only a present, fully
 * valid, *empty* restriction list means "Worldwide"; a missing field, a
 * non-array, or a list containing anything that cannot be read is recorded as
 * explicitly unknown, not as unrestricted. `null` location would also be
 * honest, but the text form keeps the distinction visible in the embed and to
 * Jev instead of looking like a job that simply forgot to state a location.
 *
 * DATE TRAP. The live sample returned `pubDate: 1790080189` — Unix *seconds* —
 * while the documentation examples disagree about ISO strings and milliseconds.
 * `isoDate` normalizes from the value's magnitude and rejects implausible
 * results, so seconds, milliseconds and ISO all land correctly and a garbage
 * value stays `null` (unknown), never a 1970 date that looks stale.
 */

const API = "https://himalayas.app/jobs/api";
/** Provider maximum. The API returns 400 above this. */
const PAGE_SIZE = 20;
/** Fresh budget: enough for a day of arrivals (~1,150 measured) with headroom. */
const MAX_HEAD_PAGES = 80;
/** First run has no watermark; keep the initial head grab small. */
const FIRST_HEAD_PAGES = 5;
/** Background budget: 500 historical jobs a day, resumable. */
const MAX_BG_PAGES = 25;

const REF_RE = /^(?:himalayas)(?::all)?$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?himalayas\.app(?:\/.*)?$/i;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  if (!REF_RE.test(trimmed) && !URL_RE.test(trimmed)) return null;
  return { kind: "himalayas", ident: "all", label: "Himalayas" };
}

/* -------------------------------------------------------- restrictions --- */

/**
 * A validated list of strings, or null when the field is missing or malformed.
 * `[]` is a real value — the provider said "no restriction" — and only that
 * empty list is allowed to mean unrestricted. One unreadable entry invalidates
 * the whole list, because keeping the entries we understood and dropping the
 * ones we did not would understate a restriction the filter never sees.
 */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanString(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/** UTC offsets arrive as numbers in the live payload; strings are kept as-is. */
function zoneList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "number" && Number.isFinite(entry)) {
      out.push(entry >= 0 ? `+${entry}` : String(entry));
    } else {
      const text = cleanString(entry);
      if (text === null) return null;
      out.push(text);
    }
  }
  return out;
}

function location(v: Record<string, unknown>): string | null {
  const countries = stringList(v.locationRestrictions);
  const zones = zoneList(v.timezoneRestrictions);
  // Nothing trustworthy at all: unknown, not unrestricted.
  if (countries === null && zones === null) return null;

  const parts: string[] = [];
  if (countries === null) parts.push("Hiring countries not stated");
  else if (countries.length === 0) parts.push("Worldwide");
  else parts.push(countries.join(", "));
  if (zones === null) parts.push("time zones not stated");
  else if (zones.length) parts.push(`UTC ${zones.join(", ")}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------ mapping --- */

function toPosting(v: Record<string, unknown>): FetchedPosting | null {
  const title = cleanString(v.title);
  const company = cleanString(v.companyName);
  const url = httpUrl(v.applicationLink);
  const guid = cleanString(v.guid) ?? url;
  if (!title || !company || !url || !guid) return null;

  const categories = Array.isArray(v.categories)
    ? v.categories.map((c) => cleanString(c)).filter((c): c is string => c !== null)
    : [];

  return {
    externalId: guid,
    title,
    company,
    location: location(v),
    remote: true,
    department: categories[0] ?? null,
    url,
    postedAt: isoDate(v.pubDate),
    closesAt: isoDate(v.expiryDate),
    description: stripHtml(cleanString(v.description)),
  };
}

/** One response page, validated. `nextCursor` is opaque; we only echo it. */
export function parseHimalayasPage(raw: unknown): {
  postings: FetchedPosting[];
  nextCursor: string | null;
} {
  if (!isRecord(raw) || !Array.isArray(raw.jobs)) {
    throw new Error("Himalayas: response has no jobs array");
  }
  const postings = raw.jobs
    .map((job) => (isRecord(job) ? toPosting(job) : null))
    .filter((p): p is FetchedPosting => p !== null);
  if (raw.jobs.length > 0 && postings.length === 0) {
    throw new Error(`Himalayas: ${raw.jobs.length} jobs but none usable`);
  }
  return { postings, nextCursor: cleanString(raw.nextCursor) };
}

/* ------------------------------------------------------------- cursor --- */

interface CursorState {
  /** Newest `pubDate` (epoch seconds) already covered by a head walk. */
  wm: number | null;
  /** Provider cursor for the background walk; null starts a new one. */
  bg: string | null;
}

function readState(cursor: string | null | undefined): CursorState {
  if (!cursor) return { wm: null, bg: null };
  try {
    const parsed = JSON.parse(cursor) as { wm?: unknown; bg?: unknown };
    return {
      wm: typeof parsed.wm === "number" && Number.isFinite(parsed.wm) ? parsed.wm : null,
      bg: typeof parsed.bg === "string" && parsed.bg ? parsed.bg : null,
    };
  } catch {
    // A corrupt cursor is unknown state, not a reason to fail the source.
    return { wm: null, bg: null };
  }
}

function epochSeconds(postedAt: string | null): number | null {
  if (!postedAt) return null;
  const ms = Date.parse(postedAt);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/* -------------------------------------------------------------- fetch --- */

async function fetchJobs(
  _ident: string,
  _etag: string | null,
  cursor?: string | null,
): Promise<FetchResult> {
  const state = readState(cursor);
  const collected = new Map<string, FetchedPosting>();
  let newest = state.wm;

  const page = async (params: URLSearchParams) => {
    const { body } = await fetchJson(`${API}?${params.toString()}`, {
      maxBytes: 5_000_000,
      allowHost: (host) => host === "himalayas.app" || host === "www.himalayas.app",
    });
    return body === null ? null : parseHimalayasPage(body);
  };

  // 1. Head walk: newest-first until the previous watermark is reached.
  const headBudget = state.wm === null ? FIRST_HEAD_PAGES : MAX_HEAD_PAGES;
  let headCursor: string | null = null;
  for (let i = 0; i < headBudget; i++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (headCursor) params.set("cursor", headCursor);
    const parsed = await page(params);
    if (!parsed || parsed.postings.length === 0) {
      headCursor = null;
      break;
    }
    let reachedKnown = false;
    for (const posting of parsed.postings) {
      collected.set(posting.externalId, posting);
      const epoch = epochSeconds(posting.postedAt);
      if (epoch !== null) {
        if (newest === null || epoch > newest) newest = epoch;
        // Strictly older: the watermark job itself is already covered, but a
        // republished one carrying the same timestamp still gets fetched.
        if (state.wm !== null && epoch < state.wm) reachedKnown = true;
      }
    }
    headCursor = parsed.nextCursor;
    // A provider looping the same cursor must not become five identical
    // requests; treat it as the end of this walk.
    if (headCursor === params.get("cursor")) headCursor = null;
    if (!headCursor || reachedKnown) break;
  }

  // 2. Background walk: resume where the last one stopped, or where this
  //    poll's head walk stopped when there is no stored cursor.
  let bg = state.bg ?? headCursor;
  for (let i = 0; i < MAX_BG_PAGES && bg; i++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: bg });
    const parsed = await page(params);
    if (!parsed || parsed.postings.length === 0) {
      bg = null;
      break;
    }
    for (const posting of parsed.postings) collected.set(posting.externalId, posting);
    bg = parsed.nextCursor;
    if (bg === params.get("cursor")) bg = null; // provider loop: stop
  }

  return {
    postings: [...collected.values()],
    etag: null,
    cursor: JSON.stringify({ wm: newest, bg }),
  };
}

export const himalayas: Adapter = {
  kind: "himalayas",
  complete: false,
  // The provider says the data is cached daily.
  minPollIntervalMs: 24 * 60 * 60_000,
  domain: () => "himalayas.app",
  parse,
  fetch: fetchJobs,
};
