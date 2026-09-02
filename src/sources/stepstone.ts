/**
 * StepStone direct-HTTP search adapter.
 *
 * PARTIAL SOURCE -- see the header of ./browser.ts for the full rationale.
 * This adapter fetches page 1 only (25 results) of a ranked, capped search,
 * so `complete` is `false`: an absence here means "not on the page we saw",
 * never "closed". The poller must not infer closure from it.
 *
 * GET https://www.stepstone.de/jobs/<query-slug>/in-<location-slug> with a
 * Chrome-like User-Agent, `Accept: text/html` and `Accept-Language: de-DE`
 * returns the real HTML page (verified live: no challenge on this path).
 * Slugs are lowercase, spaces become "-", and umlauts are transliterated
 * (ü->ue, ö->oe, ä->ae, ß->ss); "in-nuernberg" and "in-muenchen" both
 * verified to resolve. robots.txt disallows `?page=N` on `/jobs/` paths, so
 * there is deliberately no pagination and no query string of any kind.
 *
 * Each result is a card carrying `data-at="job-item-title"` (on the anchor
 * whose `href` is `/stellenangebote--<slug>--<jobId>-inline.html`),
 * `data-at="job-item-company-name"` and `data-at="job-item-location"`.
 * `data-at="job-item-timeago"` is a relative string ("vor 6 Tagen"), never an
 * absolute date. The real publish time lives elsewhere on the same page: the
 * inline `window.__PRELOADED_STATE__` carries each result as
 * `{"id":<jobId>,"title":...,"datePosted":"2026-09-02T01:54:01+02:00",...}`.
 * `postedAt` is joined from there by job id and is null only when the state
 * blob is missing the id, so the freshness alert can work on this board.
 * The page also carries an inline `data-atx-onpageview-payload` attribute
 * whose JSON gives `searchResultsTotalJobCount`; that number is used only as a
 * sanity check -- if it says results exist but no cards parsed, this throws
 * rather than returning an empty (and misleading) snapshot.
 */

import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting } from "../types.ts";
import { stripHtml } from "./index.ts";
import { canon, ANY_LOCATION } from "./browser.ts";

const KIND = "stepstone";
const BASE = "https://www.stepstone.de";

function makeIdent(query: string, location: string): string {
  const q = canon(query);
  const l = canon(location) || ANY_LOCATION;
  // No site prefix: the source's `kind` already says which board this is, and
  // the bot prints `kind:ident`, so a prefix here would show up doubled.
  return `${q}@${l}`;
}

/** Inverse of `makeIdent`. Throws on garbage: idents come from our own DB. */
function splitIdent(ident: string): { query: string; location: string } {
  const at = ident.lastIndexOf("@");
  if (at < 0) throw new Error(`not a stepstone ident: ${ident}`);
  return { query: ident.slice(0, at), location: ident.slice(at + 1) };
}

function label(query: string, location: string): string {
  const l = canon(location);
  return `StepStone: ${canon(query)}${l ? `, ${l}` : ""}`;
}

/** `stepstone:<query>@<location>` */
function parsePrefixed(input: string): ParsedRef | null {
  const m = /^stepstone\s*:\s*(.+)$/i.exec(input);
  if (!m) return null;
  const rest = m[1]!;
  const at = rest.lastIndexOf("@");
  const query = at >= 0 ? rest.slice(0, at) : rest;
  const location = at >= 0 ? rest.slice(at + 1) : "";
  if (!canon(query)) return null;
  return {
    kind: KIND,
    ident: makeIdent(query, location),
    label: label(query, location),
  };
}

/**
 * A pasted stepstone.de search URL: either the slug form
 * `/jobs/<query-slug>/in-<location-slug>` or the older `?what=&where=` form.
 */
function parseUrl(input: string): ParsedRef | null {
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().includes("stepstone.")) return null;

  const what = url.searchParams.get("what");
  if (what && canon(what)) {
    const where = url.searchParams.get("where") ?? "";
    return {
      kind: KIND,
      ident: makeIdent(what, where),
      label: label(what, where),
    };
  }

  const m = /^\/jobs\/([^/]+)(?:\/in-([^/?]+))?/i.exec(url.pathname);
  if (!m) return null;
  const query = m[1]!.replace(/-/g, " ");
  const location = m[2] ? m[2].replace(/-/g, " ") : "";
  if (!canon(query)) return null;
  return {
    kind: KIND,
    ident: makeIdent(query, location),
    label: label(query, location),
  };
}

/** Lowercase, transliterate umlauts, and dash-join for a URL slug. */
function slugify(s: string): string {
  return canon(s)
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * First plain-text run at or after `fromIdx`, skipping CSS spilled out of
 * inline `<style>` blocks (recognisable by a literal `{`) and tags with no
 * text content (e.g. `<svg>...</svg>`, which never puts text between `>`
 * and the next `<`).
 */
function firstText(html: string, fromIdx: number): string {
  const re = />([^<>{}][^<>]*)</g;
  re.lastIndex = fromIdx;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = m[1]!.trim();
    if (text && !text.includes("{")) return text;
  }
  return "";
}

function fieldAfter(card: string, dataAt: string): string {
  const idx = card.indexOf(`data-at="${dataAt}"`);
  if (idx < 0) return "";
  return stripHtml(firstText(card, idx)) ?? "";
}

/** Read `searchResultsTotalJobCount` out of the entity-encoded payload JSON. */
function totalJobCount(html: string): number | null {
  const m = /data-atx-onpageview-payload="([^"]*)"/.exec(html);
  if (!m) return null;
  const decoded = m[1]!.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
  try {
    const payload = JSON.parse(decoded) as Record<string, unknown>;
    const total = payload["searchResultsTotalJobCount"];
    return typeof total === "number" ? total : null;
  } catch {
    return null;
  }
}

const CARD_HREF =
  /href="(\/stellenangebote--[^"]+?-(\d+)-inline\.html)"[^>]*data-at="job-item-title"/g;

/**
 * jobId -> ISO publish time, read from the preloaded-state JSON that the page
 * ships alongside the cards. Items are flat objects whose `id` immediately
 * precedes `title`, and whose `datePosted` follows within the same object; the
 * regex anchors on that `"id":N,"title"` pair so a nested label id can't be
 * mistaken for a job id, and stops at the next item's id so one item's date
 * cannot leak onto its neighbour.
 */
export function extractPostedDates(html: string): Map<string, string> {
  const dates = new Map<string, string>();
  const re = /"id":(\d+),"title":"(?:(?!"id":\d+,"title")[\s\S])*?"datePosted":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = Date.parse(m[2]!);
    if (!Number.isNaN(t)) dates.set(m[1]!, new Date(t).toISOString());
  }
  return dates;
}

/** Parse the fetched search page into postings, or throw on unexpected shape. */
export function parseSearchHtml(html: string): FetchedPosting[] {
  const postedDates = extractPostedDates(html);
  const anchors: { start: number; href: string; jobId: string }[] = [];
  let m: RegExpExecArray | null;
  CARD_HREF.lastIndex = 0;
  while ((m = CARD_HREF.exec(html))) {
    anchors.push({ start: m.index, href: m[1]!, jobId: m[2]! });
  }

  const total = totalJobCount(html);
  if (anchors.length === 0) {
    if (total && total > 0) {
      throw new Error(
        `stepstone: page reports ${total} results but no job cards were found -- page shape changed`,
      );
    }
    return [];
  }

  return anchors.map(({ start, href, jobId }, i) => {
    const end = i + 1 < anchors.length ? anchors[i + 1]!.start : html.length;
    const card = html.slice(start, end);
    const title = fieldAfter(card, "job-item-title");
    if (!title) throw new Error(`stepstone: card ${i} has no title`);
    const company = fieldAfter(card, "job-item-company-name");
    if (!company) throw new Error(`stepstone: card ${i} has no company`);
    const location = fieldAfter(card, "job-item-location") || null;

    return {
      externalId: jobId,
      title,
      company,
      location,
      remote: null,
      department: null,
      url: `${BASE}${href}`,
      // Cards only carry a relative "vor N Tagen" age; the exact time comes
      // from the page's preloaded state, joined by job id.
      postedAt: postedDates.get(jobId) ?? null,
      closesAt: null,
      description: null,
    } satisfies FetchedPosting;
  });
}

export const stepstone: Adapter & { readonly complete: false } = {
  kind: KIND,

  complete: false,

  parse(input: string): ParsedRef | null {
    const s = input.trim();
    if (!s) return null;
    try {
      return parseUrl(s) ?? parsePrefixed(s);
    } catch {
      return null;
    }
  },

  async fetch(ident: string, _etag: string | null): Promise<FetchResult> {
    const { query, location } = splitIdent(ident);
    const path =
      location === ANY_LOCATION
        ? `/jobs/${slugify(query)}`
        : `/jobs/${slugify(query)}/in-${slugify(location)}`;
    const url = `${BASE}${path}`;

    const res = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "accept-language": "de-DE",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (res.status !== 200) {
      throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();

    return { postings: parseSearchHtml(html), etag: null };
  },
};
