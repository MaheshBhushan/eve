import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { cleanString, httpUrl, isRecord, isoDate, stripHtml } from "./index.ts";
import { fetchJson } from "../http.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Remote OK, via its public JSON API.
 *
 * Evidence (2026-09-22): https://remoteok.com/api returned a 100-element array
 * whose first element is metadata ({last_updated, legal}) and whose remaining
 * elements are jobs with `id`, `slug`, `position`, `company`, `tags`,
 * `description`, `location`, `date`, `epoch`, `url`, `apply_url`. The RSS route
 * the site used to offer now answers 410, so JSON is the only supported route.
 *
 * Decisions worth naming:
 *
 *   - The metadata element has no `id`/`position` and is skipped structurally,
 *     not by array index. An index check would turn into a data bug the first
 *     time Remote OK drops or reorders the preamble.
 *   - The API's terms ask for a link back and a "Remote OK" credit. The credit
 *     is the source label in the embed footer; `url` is preferred over
 *     `apply_url` so the link lands on the listing being described.
 *   - Salary fields exist on the payload and are deliberately not mapped:
 *     FetchedPosting has no salary column yet, and mapping `salary_min: 0` to
 *     "no salary" would be worse than leaving it out. The future
 *     SourceObservation migration carries it properly.
 *   - `complete: false`: 100 items is Remote OK's discovery window.
 */

const API = "https://remoteok.com/api";

const REF_RE = /^(?:remoteok|remote-ok)(?::all)?$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?remoteok\.(?:com|io)(?:\/.*)?$/i;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  if (!REF_RE.test(trimmed) && !URL_RE.test(trimmed)) return null;
  return { kind: "remoteok", ident: "all", label: "Remote OK" };
}

export function parseRemoteOk(raw: unknown): FetchedPosting[] {
  if (!Array.isArray(raw)) {
    throw new Error("Remote OK: expected a JSON array");
  }

  const postings: FetchedPosting[] = [];
  for (const value of raw) {
    if (!isRecord(value)) continue;
    const id = value.id;
    const title = cleanString(value.position);
    const company = cleanString(value.company);
    // The metadata row fails exactly these three checks, which is the point:
    // only a record that identifies a real job becomes a posting.
    if ((typeof id !== "string" && typeof id !== "number") || !title || !company) continue;

    const url = httpUrl(value.url) ?? httpUrl(value.apply_url);
    if (!url) continue;

    postings.push({
      externalId: String(id),
      title,
      company,
      location: cleanString(value.location),
      remote: true,
      department: null,
      url,
      postedAt: isoDate(value.date) ?? isoDate(value.epoch),
      closesAt: null,
      description: stripHtml(cleanString(value.description)),
    });
  }

  if (raw.length > 0 && postings.length === 0) {
    throw new Error(`Remote OK: ${raw.length} elements but no usable jobs`);
  }
  return postings;
}

async function fetchJobs(_ident: string, _etag: string | null): Promise<FetchResult> {
  // No conditional support observed; an ETag we invent would suppress updates.
  const { body } = await fetchJson(API, {
    maxBytes: 5_000_000,
    allowHost: (host) => host === "remoteok.com" || host === "www.remoteok.com",
  });
  if (body === null) return { postings: [], etag: null };
  return { postings: parseRemoteOk(body), etag: null };
}

export const remoteok: Adapter = {
  kind: "remoteok",
  complete: false,
  minPollIntervalMs: 60 * 60_000,
  domain: () => "remoteok.com",
  parse,
  fetch: fetchJobs,
};
