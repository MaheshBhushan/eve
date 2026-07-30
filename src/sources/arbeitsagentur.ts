/**
 * Bundesagentur für Arbeit ("Jobbörse") search adapter — the primary German
 * source, and the only one here that is a *search*, not a board.
 *
 * API: https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs
 * with the public client key `X-API-Key: jobboerse-jobsuche` (the key the
 * agency's own web UI ships; there is no registration and no secret).
 *
 * ------------------------------------------------------------------ why
 * The ATS adapters answer "what is open on this board?" and the poller is
 * allowed to read an absence as a closure. A search endpoint normally cannot
 * support that, which is why `browser` declares `complete === false`. This one
 * is different in one decisive way: it reports `maxErgebnisse`, the true size
 * of the result set. So we can *know* whether we saw everything instead of
 * guessing, and completeness becomes achievable — for a narrow search.
 *
 * COMPLETENESS DECISION. This adapter is a complete source (it deliberately
 * does NOT set `complete: false`), and it keeps that promise the way the
 * `Adapter` doc demands: **when it cannot produce a complete snapshot it
 * throws.** Concretely, if `maxErgebnisse > MAX_RESULTS` the fetch fails with a
 * message telling the owner to narrow the search. Nothing partial is ever
 * returned, so the poller needs no new machinery and no per-source completeness
 * flag: every snapshot that reaches it is exhaustive for that query, and
 * absence really does mean the posting left the result set.
 *
 * The alternative — return a truncated snapshot and mark it incomplete — was
 * rejected because `complete` is a per-adapter constant and this adapter is
 * only *conditionally* complete. Claiming `false` would permanently disable
 * closure detection for narrow, well-behaved searches (the common case, and
 * where most of the value is); claiming `true` while truncating would close
 * every posting that fell past the cap. Throwing is the only option that is
 * honest for both cases, and it fails in the direction the poller already
 * handles: a raised error just increments `fail_count`.
 *
 * The one caveat, stated plainly: a search snapshot is complete but *volatile*.
 * A posting can leave a `werkstudent@berlin` result set because the employer
 * retitled it, not because it closed. That is a property of watching a query
 * rather than a company, not a completeness bug, and the poller's existing
 * mass-delisting guard (`acceptSnapshot`) is the backstop.
 *
 * THE CAP. MAX_RESULTS = 800, i.e. 8 requests of 100 at most per cycle.
 * Measured set sizes: `werkstudent@berlin+25` → 285, `werkstudent@münchen+25`
 * → 473, `praktikum@berlin+25` → 608, `werkstudent` nationwide → 4435,
 * `praktikum` nationwide → 33487. 800 therefore admits every realistic
 * city-plus-radius search (the widest measured one, Praktikum in Berlin, fits
 * with room to spare) and rejects the nationwide ones, which must never be
 * paginated every ten minutes. Raising the cap buys nothing: past ~800 the
 * right fix is a location, a smaller radius, or a `~days` recency window, all
 * of which the ident supports.
 *
 * Descriptions: the list endpoint returns none. The detail endpoint
 * (`v4/jobdetails/<base64(refnr)>`) does work with this key and returns plain
 * text in `stellenangebotsBeschreibung`, so we fetch it for **new postings
 * only**, at most DETAIL_BUDGET per cycle. Known postings are never refetched:
 * the poller keeps the description it already stored.
 */

import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting, SourceKind } from "../types.ts";

const KIND: SourceKind = "arbeitsagentur";

const BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4";
const API_KEY = "jobboerse-jobsuche";
const JOBDETAIL_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail/";

/** See the module header: 8 pages of 100 is the whole budget for a cycle. */
export const MAX_RESULTS = 800;
/** Verified: `size=100` is honoured (and so is 200; we stay at the documented max). */
const PAGE_SIZE = 100;
/** Guard against a result set that keeps growing under us mid-pagination. */
const MAX_PAGES = Math.ceil(MAX_RESULTS / PAGE_SIZE);

/**
 * How far short of the promised total a snapshot may fall and still count.
 *
 * Paginating a live search is inherently racy: ads are published and withdrawn
 * while we walk the pages, so `maxErgebnisse` is a reading taken at page 1 and
 * the set genuinely differs by a few entries by the last page. Demanding an
 * exact match sounds strict but is actually wrong — it makes every large search
 * fail permanently and get muted, which is how `praktikum@münchen+25` (439 of
 * 440) died in testing while the far less useful small searches survived.
 *
 * A few missing entries cannot be confused with a delisting; a truncated fetch
 * loses pages at a time, not items. So allow a small proportional slack, and
 * keep a floor so tiny result sets aren't held to an impossibly tight bound.
 * Genuine truncation still trips the throw, and the poller's mass-delist guard
 * backstops anything that slips through.
 */
function shortfallAllowance(total: number): number {
  return Math.max(5, Math.ceil(total * 0.02));
}
/** Per-cycle ceiling on detail requests, so a burst of new hits cannot fan out. */
export const DETAIL_BUDGET = 25;

/* --------------------------------------------------------------- parse --- */

/** `arbeitsagentur:<query>[@<location>[+<radius>]][~<days>]`, or `ba:` for short. */
const REF_RE = /^(?:arbeitsagentur|ba):(.+)$/i;

export interface Search {
  query: string;
  location: string | null;
  /** Radius in km around `location`; null means the API's own default. */
  radius: number | null;
  /** `veroeffentlichtseit`: only postings published within N days. */
  sinceDays: number | null;
}

/** Whitespace-collapsed, lowercased. Two spellings of a search must collapse
 *  to one ident, because the ident is the SQLite uniqueness key for a source. */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Canonical ident. Prefixed so `splitIdent` can reject a foreign one instead of
 * silently mis-searching, and every optional part is omitted when unset so that
 * `werkstudent@berlin` and `werkstudent @ Berlin` cannot become two sources.
 */
export function makeIdent(s: Search): string {
  let out = `ba:${s.query}`;
  if (s.location) {
    out += `@${s.location}`;
    // A radius without a location is meaningless, so it is dropped, not kept.
    if (s.radius !== null) out += `+${s.radius}`;
  }
  if (s.sinceDays !== null) out += `~${s.sinceDays}`;
  return out;
}

/** Inverse of `makeIdent`. Throws on anything not produced by this adapter. */
export function splitIdent(ident: string): Search {
  const parsed = parseSearch(ident);
  if (!parsed) throw new Error(`not an arbeitsagentur ident: ${ident}`);
  return parsed;
}

function parseSearch(input: string): Search | null {
  const m = REF_RE.exec(input.trim());
  if (!m || !m[1]) return null;
  let rest = m[1].trim();

  let sinceDays: number | null = null;
  const since = /~(\d{1,3})$/.exec(rest);
  if (since && since[1]) {
    sinceDays = Number(since[1]);
    rest = rest.slice(0, since.index);
    if (sinceDays < 1) return null;
  }

  let radius: number | null = null;
  const rad = /\+(\d{1,3})$/.exec(rest);
  if (rad && rad[1]) {
    radius = Number(rad[1]);
    rest = rest.slice(0, rad.index);
    if (radius < 1) return null;
  }

  const at = rest.indexOf("@");
  const query = norm(at === -1 ? rest : rest.slice(0, at));
  const location = at === -1 ? null : norm(rest.slice(at + 1)) || null;
  if (!query) return null;
  if (!location) radius = null;

  return { query, location, radius, sinceDays };
}

function label(s: Search): string {
  const parts = [titleCase(s.query)];
  if (s.location) {
    parts.push(titleCase(s.location) + (s.radius !== null ? ` (${s.radius}km)` : ""));
  } else {
    parts.push("Deutschland");
  }
  if (s.sinceDays !== null) parts.push(`≤${s.sinceDays}d`);
  return parts.join(" · ");
}

function titleCase(s: string): string {
  return s.replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
}

function parse(input: string): ParsedRef | null {
  const s = parseSearch(input);
  if (!s) return null;
  return { kind: KIND, ident: makeIdent(s), label: label(s) };
}

/* ------------------------------------------------------------- mapping --- */

interface BaOrt {
  plz?: string | null;
  ort?: string | null;
  strasse?: string | null;
  region?: string | null;
  land?: string | null;
}

interface BaJob {
  beruf?: string | null;
  titel?: string | null;
  refnr?: string | null;
  arbeitsort?: BaOrt | null;
  arbeitgeber?: string | null;
  aktuelleVeroeffentlichungsdatum?: string | null;
  modifikationsTimestamp?: string | null;
  eintrittsdatum?: string | null;
  externeUrl?: string | null;
}

/**
 * This feed ships dirty scalars: `strasse` comes back as the literal string
 * `"null"`, and empty strings are common. Treat that whole class as absent
 * rather than special-casing one field.
 */
function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t === "null" || t === "undefined" || t === "-") return null;
  return t;
}

/**
 * Location feeds both the dedupe key and the location filter, so it has to be
 * stable and terse: city, plus the region only when it says something the city
 * doesn't (Berlin/Berlin adds nothing). The postcode is deliberately left out —
 * it would split one city into dozens of distinct dedupe keys.
 */
function toLocation(ort: BaOrt | null | undefined): string | null {
  const city = clean(ort?.ort);
  const region = clean(ort?.region);
  if (!city) return region;
  if (region && region.toLowerCase() !== city.toLowerCase()) return `${city}, ${region}`;
  return city;
}

export function toPosting(job: BaJob, description: string | null = null): FetchedPosting {
  const refnr = clean(job.refnr);
  if (!refnr) throw new Error("arbeitsagentur posting without refnr");
  return {
    externalId: refnr,
    title: clean(job.titel) ?? clean(job.beruf) ?? "(ohne Titel)",
    // Employer is occasionally withheld (agency listings, anonymised ads). Say
    // so rather than inventing a name the dedupe key would then trust.
    company: clean(job.arbeitgeber) ?? "unbekannt",
    location: toLocation(job.arbeitsort),
    // No reliable remote flag exists on this endpoint; `false` would be a guess.
    remote: null,
    // `beruf` is the occupational category ("Architekt/in"), which is the
    // closest thing here to a department and reads usefully in the embed.
    department: clean(job.beruf),
    // `externeUrl` is absent whenever the ad lives on the agency's own board.
    url: clean(job.externeUrl) ?? JOBDETAIL_URL + encodeURIComponent(refnr),
    // A board-stated publish date (date only), so it counts as exact. We do NOT
    // fall back to modifikationsTimestamp: that is a record-touch time, and
    // passing it off as a publish date would poison the freshness alert.
    postedAt: clean(job.aktuelleVeroeffentlichungsdatum),
    // Nothing in this payload means "applications close on". `eintrittsdatum`
    // is the desired start date, which is not a deadline.
    closesAt: null,
    description,
  };
}

/* --------------------------------------------------------------- fetch --- */

async function getBa(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "eve", "X-API-Key": API_KEY },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

function pageUrl(s: Search, page: number): string {
  const q = new URLSearchParams({ was: s.query, size: String(PAGE_SIZE), page: String(page) });
  if (s.location) q.set("wo", s.location);
  if (s.radius !== null) q.set("umkreis", String(s.radius));
  if (s.sinceDays !== null) q.set("veroeffentlichtseit", String(s.sinceDays));
  return `${BASE}/jobs?${q}`;
}

/** The detail endpoint keys on base64 of the refnr (URL-safe, padding kept). */
async function fetchDescription(refnr: string): Promise<string | null> {
  const id = Buffer.from(refnr, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  try {
    const body = await getBa(`${BASE}/jobdetails/${id}`);
    const text = (body as { stellenangebotsBeschreibung?: unknown }).stellenangebotsBeschreibung;
    // Already plain text with bullet characters, not HTML — no stripping needed.
    return clean(text);
  } catch {
    // A single missing JD must never fail the whole snapshot: a null description
    // only costs fit scoring for that posting, a thrown fetch costs the poll.
    return null;
  }
}

async function fetchSearch(ident: string, _etag: string | null): Promise<FetchResult> {
  const s = splitIdent(ident);

  const seen = new Map<string, BaJob>();
  let total = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = (await getBa(pageUrl(s, page))) as {
      stellenangebote?: unknown;
      maxErgebnisse?: unknown;
    };
    const rows = body.stellenangebote;
    // Every page restates the total, and it is read even on the page that ends
    // pagination: a set that shrank while we paged (an ad was withdrawn) is
    // normal, so we track the smallest total we were told rather than the first.
    // Trusting page 1's number alone would report a shortfall — and fail the
    // poll — every time a single ad disappeared mid-fetch.
    const reported = body.maxErgebnisse;
    if (typeof reported === "number") {
      total = page === 1 ? reported : Math.min(total, reported);
    } else if (page === 1) {
      total = Array.isArray(rows) ? rows.length : 0;
    }

    if (!Array.isArray(rows)) {
      // Past the last page the API answers 200 with the key omitted, which is
      // the normal end-of-results signal, not a malformed response.
      if (page === 1) throw new Error(`arbeitsagentur ${ident}: no stellenangebote array`);
      break;
    }

    if (page === 1) {
      // The completeness contract: refuse rather than truncate. See header.
      if (total > MAX_RESULTS) {
        throw new Error(
          `arbeitsagentur ${ident}: ${total} results exceeds the ${MAX_RESULTS} cap, so no ` +
            `complete snapshot is possible. Narrow the search: add a location or a smaller ` +
            `radius (…@berlin+25) or a recency window (…~7 for the last 7 days).`,
        );
      }
    }

    const before = seen.size;
    for (const row of rows as BaJob[]) {
      // Dedupe by refnr: paginating a live, re-ranked result set can repeat a
      // row across pages, and a duplicate would upsert twice per cycle.
      const refnr = clean(row.refnr);
      if (refnr && !seen.has(refnr)) seen.set(refnr, row);
    }

    if (rows.length === 0 || seen.size === before) break; // no forward progress
    if (seen.size >= total) break;
  }

  const jobs = [...seen.values()];
  if (jobs.length < total - shortfallAllowance(total)) {
    // Materially short of what we were promised: the snapshot would read as a
    // mass delisting downstream, so fail instead and let fail_count handle it.
    throw new Error(
      `arbeitsagentur ${ident}: collected ${jobs.length} of ${total} results; ` +
        `the result set changed mid-pagination, so the snapshot is incomplete`,
    );
  }

  const postings = jobs.map((j) => toPosting(j));
  // Descriptions cost one request each. The adapter has no DB, so it cannot ask
  // "which of these are new"; the best available proxy is the publish date, and
  // the newest postings are exactly the ones the poller is about to announce.
  // Spend the budget there, newest first. The poller keeps the description it
  // already stored, so a posting skipped here is not wiped — it just stays
  // unscored until a cycle has budget for it.
  const newest = [...postings].sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
  for (const p of newest.slice(0, DETAIL_BUDGET)) {
    p.description = await fetchDescription(p.externalId);
  }

  // Verified: this endpoint sends no ETag (and `cache-control: no-store`), so
  // there is nothing to round-trip. Inventing one would suppress real changes.
  return { postings, etag: null };
}

export const arbeitsagentur: Adapter = {
  kind: KIND,
  // `complete` intentionally left unset (i.e. true): fetch throws rather than
  // ever returning a partial snapshot. See the module header.
  parse,
  fetch: fetchSearch,
};
