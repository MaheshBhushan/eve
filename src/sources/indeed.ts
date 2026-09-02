/**
 * Indeed Germany direct-HTTP search adapter.
 *
 * PARTIAL SOURCE -- see the header of ./browser.ts for the full rationale.
 * This adapter fetches page 1 only (~15 results) of a ranked, capped search,
 * so `complete` is `false`: an absence here means "not on the page we saw",
 * never "closed". The poller must not infer closure from it.
 *
 * GET https://de.indeed.com/jobs?q=<query>&l=<location>&sort=date with a
 * Chrome-like User-Agent and `Accept: text/html` returns the real HTML page
 * (verified: no Cloudflare challenge on this path). `sort=date` puts the
 * newest postings first, which is what a partial source wants most. There is
 * deliberately no pagination and no evasion of any kind: if the page looks
 * like a challenge, this throws rather than working around it.
 *
 * The page embeds its job data as a JS assignment:
 *   window.mosaic.providerData["mosaic-provider-jobcards"]=<JSON>;
 * which is extracted with a balanced-brace scan and parsed.
 */

import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting } from "../types.ts";
import { canon, ANY_LOCATION } from "./browser.ts";

const KIND = "indeed";
const BASE = "https://de.indeed.com";

function makeIdent(query: string, location: string): string {
  const q = canon(query);
  const l = canon(location) || ANY_LOCATION;
  return `indeed:${q}@${l}`;
}

/** Inverse of `makeIdent`. Throws on garbage: idents come from our own DB. */
function splitIdent(ident: string): { query: string; location: string } {
  const colon = ident.indexOf(":");
  const at = ident.lastIndexOf("@");
  if (colon < 0 || at < colon || ident.slice(0, colon) !== "indeed") {
    throw new Error(`not an indeed ident: ${ident}`);
  }
  return {
    query: ident.slice(colon + 1, at),
    location: ident.slice(at + 1),
  };
}

function label(query: string, location: string): string {
  const l = canon(location);
  return `Indeed: ${canon(query)}${l ? `, ${l}` : ""}`;
}

/** `indeed:<query>@<location>` */
function parsePrefixed(input: string): ParsedRef | null {
  const m = /^indeed\s*:\s*(.+)$/i.exec(input);
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

/** A pasted de.indeed.com/jobs?q=&l= search URL. */
function parseUrl(input: string): ParsedRef | null {
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().includes("indeed.")) return null;
  const query = url.searchParams.get("q") ?? "";
  if (!canon(query)) return null;
  const location = url.searchParams.get("l") ?? "";
  return {
    kind: KIND,
    ident: makeIdent(query, location),
    label: label(query, location),
  };
}

/**
 * Extract the JSON object assigned to
 * `window.mosaic.providerData["mosaic-provider-jobcards"]` via a balanced
 * brace scan starting at its first `{`, so nested braces inside the JSON
 * don't confuse a regex terminated on `;`.
 */
export function extractProviderData(html: string): unknown {
  const marker = 'window.mosaic.providerData["mosaic-provider-jobcards"]=';
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error(
      "indeed: mosaic-provider-jobcards blob not found -- page shape changed " +
        "or this is a challenge page",
    );
  }
  const braceStart = html.indexOf("{", start + marker.length);
  if (braceStart < 0) {
    throw new Error("indeed: mosaic-provider-jobcards blob has no JSON object");
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const jsonText = html.slice(braceStart, i + 1);
        try {
          return JSON.parse(jsonText);
        } catch (e) {
          throw new Error(
            `indeed: mosaic-provider-jobcards blob is not valid JSON: ${(e as Error).message}`,
          );
        }
      }
    }
  }
  throw new Error("indeed: mosaic-provider-jobcards blob never closed its braces");
}

/** Map one raw result from `metaData.mosaicProviderJobCardsModel.results[]`. */
function mapResult(r: Record<string, unknown>, i: number): FetchedPosting {
  const jobkey = r["jobkey"];
  if (typeof jobkey !== "string" || !jobkey) {
    throw new Error(`indeed: result ${i} has no jobkey`);
  }
  const title = r["displayTitle"] ?? r["title"];
  if (typeof title !== "string" || !title) {
    throw new Error(`indeed: result ${i} has no title`);
  }
  const company = r["company"];
  if (typeof company !== "string" || !company) {
    throw new Error(`indeed: result ${i} has no company`);
  }
  const location =
    (typeof r["formattedLocation"] === "string" && r["formattedLocation"]) ||
    (typeof r["jobLocationCity"] === "string" && r["jobLocationCity"]) ||
    null;
  const pubDate = r["pubDate"];
  const postedAt =
    typeof pubDate === "number" && Number.isFinite(pubDate)
      ? new Date(pubDate).toISOString()
      : null;

  return {
    externalId: jobkey,
    title,
    company,
    location,
    remote: null,
    department: null,
    url: `${BASE}/viewjob?jk=${jobkey}`,
    postedAt,
    closesAt: null,
    description: null,
  };
}

/** Parse the fetched HTML into postings, or throw on any unexpected shape. */
export function parseSearchHtml(html: string): FetchedPosting[] {
  const blob = extractProviderData(html) as Record<string, unknown>;
  const metaData = blob["metaData"] as Record<string, unknown> | undefined;
  const model = metaData?.["mosaicProviderJobCardsModel"] as
    | Record<string, unknown>
    | undefined;
  const results = model?.["results"];
  if (!Array.isArray(results)) {
    throw new Error("indeed: metaData.mosaicProviderJobCardsModel.results is missing");
  }
  return results.map((r, i) => mapResult(r as Record<string, unknown>, i));
}

export const indeed: Adapter & { readonly complete: false } = {
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
    const url = new URL(`${BASE}/jobs`);
    url.searchParams.set("q", query);
    if (location !== ANY_LOCATION) url.searchParams.set("l", location);
    url.searchParams.set("sort", "date");

    const res = await fetch(url.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (res.status !== 200) {
      throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
    }
    const cfMitigated = res.headers.get("cf-mitigated");
    if (cfMitigated) {
      throw new Error(`indeed: Cloudflare mitigation on ${url} (cf-mitigated: ${cfMitigated})`);
    }
    const html = await res.text();
    if (/just a moment/i.test(html) || /"pageType"\s*:\s*"captcha"/i.test(html)) {
      throw new Error(`indeed: challenge page returned for ${url}`);
    }

    return { postings: parseSearchHtml(html), etag: null };
  },
};
