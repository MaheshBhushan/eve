import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { cleanString, isoDate, stripHtml } from "./index.ts";
import { parseFeed, type FeedItem } from "./rss.ts";
import { request } from "../http.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * We Work Remotely, via its published all-jobs RSS feed.
 *
 * Evidence (2026-09-22): https://weworkremotely.com/remote-jobs.rss returned 82
 * items of `application/rss+xml`, each carrying `guid`, `link`, `title`,
 * `description`, `pubDate`, and the job extensions `expires_at`, `region`,
 * `country`, `state`, `skills`, `category`, `type`. The feed sends a weak ETag,
 * so repeat polls are usually a 304.
 *
 * Decisions worth naming:
 *
 *   - `complete: false`. A feed is a rolling window, not an inventory. A job
 *     falling out of it says something about the window, not about the job, and
 *     the poller must never read that as a closure.
 *   - Company comes from the title's `Company: Role` convention, which every
 *     sampled item followed, and only from there: WWR has no company field, and
 *     inventing one by splitting on any colon would mangle titles like
 *     "Senior Engineer: Platform".
 *   - WWR asks to be credited; the source label ("We Work Remotely") is rendered
 *     in the embed footer and the posting links back to WWR's own listing.
 *   - `type` (employment type) and `skills` have no home in FetchedPosting yet.
 *     They are preserved in the RSS parser's tag map for the future
 *     SourceObservation migration rather than dropped silently here.
 */

const FEED = "https://weworkremotely.com/remote-jobs.rss";

/**
 * "Company: Role" — the company half is capped so a title that merely contains
 * a colon ("Engineer: Backend") is treated as a title, not split mid-sentence.
 * WWR's own convention puts the employer first, and every sampled title fit.
 */
const TITLE_RE = /^([^:]{1,60}):\s+(.+)$/;

/** Any WWR URL, plus the short prefix. `wwr:all` is accepted for convenience. */
const REF_RE = /^(?:weworkremotely|wwr)(?::all)?$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?weworkremotely\.com(?:\/.*)?$/i;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  if (!REF_RE.test(trimmed) && !URL_RE.test(trimmed)) return null;
  return { kind: "weworkremotely", ident: "all", label: "We Work Remotely" };
}

/**
 * Region/country/state are the feed's eligibility evidence, and the location
 * filter reads exactly that field. Country is often blank while the region says
 * "Anywhere in the World"; when both exist they are kept together rather than
 * picking one, because "United States of America" beside "Anywhere in the
 * World" is a restriction the filter must be able to see.
 */
function location(item: FeedItem): string | null {
  const parts = [
    cleanString(item.tags.country?.[0]),
    cleanString(item.tags.region?.[0]),
    cleanString(item.tags.state?.[0]),
  ].filter((p): p is string => p !== null);
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(", ") : null;
}

export function parseWeworkRemotely(xml: string): FetchedPosting[] {
  const { items } = parseFeed(xml);
  const postings: FetchedPosting[] = [];

  for (const item of items) {
    const title = cleanString(item.title);
    const url = cleanString(item.link);
    if (!title || !url) continue;

    const split = TITLE_RE.exec(title);
    postings.push({
      externalId: cleanString(item.guid) ?? url,
      title: split?.[2]?.trim() || title,
      company: split?.[1]?.trim() || "Unknown employer",
      location: location(item),
      // The board only lists remote roles; `region` is a hiring restriction,
      // not an office.
      remote: true,
      department: cleanString(item.tags.category?.[0]),
      url,
      postedAt: isoDate(item.pubDate),
      closesAt: isoDate(item.expiresAt),
      description: stripHtml(item.description),
    });
  }

  // An item-less feed is an empty window and a legitimate result; items that
  // all fail to parse mean the shape changed, which must be loud.
  if (items.length > 0 && postings.length === 0) {
    throw new Error(`WWR feed returned ${items.length} items but none parsed`);
  }
  return postings;
}

async function fetchFeed(_ident: string, etag: string | null): Promise<FetchResult> {
  const res = await request(FEED, {
    etag,
    accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5",
    maxBytes: 5_000_000,
    allowHost: (host) => host === "weworkremotely.com" || host === "www.weworkremotely.com",
  });
  if (res.body === null) return { postings: null, etag: res.etag };
  return { postings: parseWeworkRemotely(res.body), etag: res.etag };
}

export const weworkremotely: Adapter = {
  kind: "weworkremotely",
  // A rolling window: absence from it is not a closure. See the header.
  complete: false,
  minPollIntervalMs: 30 * 60_000,
  domain: () => "weworkremotely.com",
  parse,
  fetch: fetchFeed,
};
