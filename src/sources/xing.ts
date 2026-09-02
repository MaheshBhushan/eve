/**
 * XING direct-HTTP job search adapter.
 *
 * PARTIAL SOURCE -- `xing.complete === false`. See the header of
 * `./browser.ts` for the full rationale: this is a ranked, capped search
 * result page (page 1, 20 results), not an employer's full listing, so an
 * absence here must never be read by the poller as a closure.
 *
 * DISCOVERY. GET https://www.xing.com/jobs/search?keywords=<q>&location=<l>
 * with a Chrome-like User-Agent returns server-rendered HTML containing
 * `<script id="runtime-config">window.crate={...}</script>`. That object is a
 * JS literal (not strict JSON): it contains bare `undefined` tokens, which we
 * replace with `null` before JSON.parse. The job data lives at
 * `serverData.APOLLO_STATE`, a normalised Apollo cache: `ROOT_QUERY` has
 * a key starting with `jobSearchByQuery(` whose `collection[]` entries are
 * `__ref` pointers (nested as `{ jobDetail: { __ref } }` in practice; a
 * bare `__ref` or a `{ job: { __ref } }` shape is also handled) into
 * `VisibleJob:<id>` nodes, which in turn reference `Company` nodes.
 */

import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting } from "../types.ts";
import { canon, ANY_LOCATION } from "./browser.ts";

const SITE = "xing";

function makeIdent(query: string, location: string): string {
  const q = canon(query);
  const l = canon(location) || ANY_LOCATION;
  return `${SITE}:${q}@${l}`;
}

function splitIdent(ident: string): { query: string; location: string } {
  const colon = ident.indexOf(":");
  const at = ident.lastIndexOf("@");
  const site = ident.slice(0, colon);
  if (colon < 0 || at < colon || site !== SITE) {
    throw new Error(`not a xing ident: ${ident}`);
  }
  return {
    query: ident.slice(colon + 1, at),
    location: ident.slice(at + 1),
  };
}

function label(query: string, location: string): string {
  const l = canon(location);
  return `XING: ${canon(query)}${l && l !== ANY_LOCATION ? `, ${l}` : ""}`;
}

/** `xing:<query>@<location>` */
function parsePrefixed(input: string): ParsedRef | null {
  const m = /^xing\s*:\s*(.+)$/i.exec(input);
  if (!m) return null;
  const rest = m[1]!;
  const at = rest.lastIndexOf("@");
  const query = at >= 0 ? rest.slice(0, at) : rest;
  const location = at >= 0 ? rest.slice(at + 1) : "";
  if (!canon(query)) return null;
  return {
    kind: "xing",
    ident: makeIdent(query, location),
    label: label(query, location),
  };
}

/** A pasted xing.com/jobs/search?keywords=&location= URL. */
function parseUrl(input: string): ParsedRef | null {
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!url.hostname.toLowerCase().includes("xing.")) return null;
  const query = url.searchParams.get("keywords") ?? "";
  if (!canon(query)) return null;
  const location = url.searchParams.get("location") ?? "";
  return {
    kind: "xing",
    ident: makeIdent(query, location),
    label: label(query, location),
  };
}

/* ------------------------------------------------------------- fetch --- */

const SEARCH_URL = "https://www.xing.com/jobs/search";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Follows an Apollo-cache `__ref`, whether given directly or nested under a key. */
function deref(
  state: Record<string, unknown>,
  refHolder: unknown,
): Record<string, unknown> | null {
  if (refHolder === null || typeof refHolder !== "object") return null;
  const obj = refHolder as Record<string, unknown>;
  const ref = typeof obj.__ref === "string" ? obj.__ref : null;
  if (!ref) return null;
  const target = state[ref];
  return target && typeof target === "object"
    ? (target as Record<string, unknown>)
    : null;
}

/**
 * Extract postings from the parsed `window.crate` object.
 *
 * Exported for tests: exercising the Apollo-cache extraction against a fixed
 * fixture is the only way to catch a shape change without hitting the live
 * site.
 */
export function extractPostings(crate: unknown): FetchedPosting[] {
  if (crate === null || typeof crate !== "object") {
    throw new Error("xing: runtime-config is not an object");
  }
  const serverData = (crate as Record<string, unknown>).serverData;
  const state =
    serverData && typeof serverData === "object"
      ? (serverData as Record<string, unknown>).APOLLO_STATE
      : null;
  if (!state || typeof state !== "object") {
    throw new Error("xing: APOLLO_STATE missing from runtime-config");
  }
  const apollo = state as Record<string, unknown>;

  const rootQuery = apollo.ROOT_QUERY;
  if (!rootQuery || typeof rootQuery !== "object") {
    throw new Error("xing: ROOT_QUERY missing from APOLLO_STATE");
  }
  const searchKey = Object.keys(rootQuery as Record<string, unknown>).find((k) =>
    k.startsWith("jobSearchByQuery("),
  );
  if (!searchKey) {
    throw new Error("xing: jobSearchByQuery key missing from ROOT_QUERY");
  }
  const searchResult = (rootQuery as Record<string, unknown>)[searchKey];
  const collection =
    searchResult && typeof searchResult === "object"
      ? (searchResult as Record<string, unknown>).collection
      : null;
  if (!Array.isArray(collection)) {
    throw new Error("xing: jobSearchByQuery collection missing or not an array");
  }

  return collection.map((entry, i) => {
    // entries may be a direct __ref, or nested under a key such as
    // `jobDetail` or `job` (observed: real search results carry
    // `{ jobDetail: { __ref } }`; the collection wrapper never has a bare
    // `__ref` in practice, but both shapes are handled defensively).
    let job =
      entry && typeof entry === "object" && "__ref" in (entry as object)
        ? deref(apollo, entry)
        : null;
    if (!job && entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      job = deref(apollo, e.jobDetail) ?? deref(apollo, e.job);
    }
    if (!job) {
      throw new Error(`xing: collection entry ${i} does not dereference to a job`);
    }

    const id = job.id;
    const title = job.title;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error(`xing: job ${i} missing id`);
    }
    if (typeof title !== "string" || !title.trim()) {
      throw new Error(`xing: job ${i} missing title`);
    }

    let company: string | null = null;
    const companyInfo = job.companyInfo;
    if (companyInfo && typeof companyInfo === "object") {
      const override = (companyInfo as Record<string, unknown>).companyNameOverride;
      if (typeof override === "string" && override.trim()) {
        company = override.trim();
      } else {
        const companyNode = deref(
          apollo,
          (companyInfo as Record<string, unknown>).company,
        );
        if (companyNode) {
          const name = companyNode.companyName ?? companyNode.name;
          if (typeof name === "string" && name.trim()) company = name.trim();
        }
      }
    }
    if (!company) {
      throw new Error(`xing: job ${i} (${String(id)}) has no resolvable company`);
    }

    const locationObj = job.location;
    const city =
      locationObj && typeof locationObj === "object"
        ? (locationObj as Record<string, unknown>).city
        : null;

    const url = job.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      throw new Error(`xing: job ${i} (${String(id)}) has no valid url`);
    }

    const publishedRaw =
      job.activatedAt ?? job.publishedAt ?? job.createdAt ?? null;
    const postedAt =
      typeof publishedRaw === "string" && !Number.isNaN(Date.parse(publishedRaw))
        ? new Date(publishedRaw).toISOString()
        : null;

    const closesRaw = job.activeUntil;
    const closesAt =
      typeof closesRaw === "string" && !Number.isNaN(Date.parse(closesRaw))
        ? new Date(closesRaw).toISOString()
        : null;

    return {
      externalId: String(id),
      title: title.trim(),
      company,
      location: typeof city === "string" && city.trim() ? city.trim() : null,
      remote: null,
      department: null,
      url,
      postedAt,
      closesAt,
      description: null,
    } satisfies FetchedPosting;
  });
}

/**
 * Parse the `window.crate=...` runtime-config script into a JS value.
 *
 * The literal is not strict JSON: it carries bare `undefined` tokens (never
 * inside strings, in practice) that JSON.parse rejects, so they are rewritten
 * to `null` first.
 */
export function parseRuntimeConfig(html: string): unknown {
  const m = /<script[^>]*id=["']runtime-config["'][^>]*>window\.crate=([\s\S]*?)<\/script>/i.exec(
    html,
  );
  if (!m) {
    throw new Error("xing: runtime-config script not found in response HTML");
  }
  const literal = m[1]!.replace(/\bundefined\b/g, "null");
  try {
    return JSON.parse(literal);
  } catch (e) {
    throw new Error(
      `xing: runtime-config is not parseable JSON after undefined->null: ${(e as Error).message}`,
    );
  }
}

export const xing: Adapter & { readonly complete: false } = {
  kind: "xing",

  /** See module header and browser.ts: a ranked search page, never complete. */
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
    const url = new URL(SEARCH_URL);
    url.searchParams.set("keywords", query);
    if (location !== ANY_LOCATION) url.searchParams.set("location", location);

    const res = await fetch(url.toString(), {
      headers: {
        "user-agent": CHROME_UA,
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`${url.toString()} -> HTTP ${res.status} ${res.statusText}`);
    }
    const html = await res.text();
    const crate = parseRuntimeConfig(html);
    const postings = extractPostings(crate);

    // No stable ETag for a scraped search page; never invent one.
    return { postings, etag: null };
  },
};
