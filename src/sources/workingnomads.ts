import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { cleanString, httpUrl, isRecord, isoDate, stripHtml } from "./index.ts";
import { fetchJson } from "../http.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Working Nomads, via the exposed-jobs endpoint its homepage links.
 *
 * Evidence (2026-09-22): https://www.workingnomads.com/api/exposed_jobs/
 * returned a 56-element JSON array of `url`, `title`, `description`,
 * `company_name`, `category_name`, `tags`, `location`, `pub_date`. There is no
 * provider ID field, so the source URL is the identity — explicitly not the
 * array position, which changes whenever the list is re-ranked.
 *
 * `complete: false`: the array is a discovery window with no total count, so
 * absence proves nothing. `tags` is preserved in the payload and not stored
 * because FetchedPosting has no tag column yet.
 */

const API = "https://www.workingnomads.com/api/exposed_jobs/";

const REF_RE = /^(?:workingnomads|working-nomads)(?::all)?$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?workingnomads\.com(?:\/.*)?$/i;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  if (!REF_RE.test(trimmed) && !URL_RE.test(trimmed)) return null;
  return { kind: "workingnomads", ident: "all", label: "Working Nomads" };
}

export function parseWorkingNomads(raw: unknown): FetchedPosting[] {
  if (!Array.isArray(raw)) {
    throw new Error("Working Nomads: expected a JSON array");
  }

  const postings: FetchedPosting[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const title = cleanString(value.title);
    const company = cleanString(value.company_name);
    const url = httpUrl(value.url);
    if (!title || !company || !url) continue;

    postings.push({
      externalId: url,
      title,
      company,
      location: cleanString(value.location),
      remote: true,
      department: cleanString(value.category_name),
      url,
      postedAt: isoDate(value.pub_date),
      closesAt: null,
      description: stripHtml(cleanString(value.description)),
    });
  }

  if (raw.length > 0 && postings.length === 0) {
    throw new Error(`Working Nomads: ${raw.length} elements but no usable jobs`);
  }
  return postings;
}

async function fetchJobs(_ident: string, _etag: string | null): Promise<FetchResult> {
  const { body } = await fetchJson(API, {
    maxBytes: 5_000_000,
    allowHost: (host) => host === "workingnomads.com" || host === "www.workingnomads.com",
  });
  if (body === null) return { postings: [], etag: null };
  return { postings: parseWorkingNomads(body), etag: null };
}

export const workingnomads: Adapter = {
  kind: "workingnomads",
  complete: false,
  minPollIntervalMs: 60 * 60_000,
  domain: () => "www.workingnomads.com",
  parse,
  fetch: fetchJobs,
};
