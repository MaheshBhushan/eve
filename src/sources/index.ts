import type { FetchedPosting, SourceKind } from "../types.ts";

export interface ParsedRef {
  kind: SourceKind;
  /** Adapter-local identifier: board token, company slug, encoded query. */
  ident: string;
  /** Display name, refined from the first fetch if the board tells us better. */
  label: string;
}

export interface FetchResult {
  /** null means "not modified" -- the board honoured our ETag. */
  postings: FetchedPosting[] | null;
  etag: string | null;
  /**
   * Opaque resumable state for paginated discovery (a provider cursor, a
   * watermark — whatever the adapter needs). `undefined` leaves the stored
   * value untouched; `null` clears it, which is how an adapter signals that its
   * walk finished and the next one should start over. The poller never
   * interprets it.
   */
  cursor?: string | null;
}

export interface Adapter {
  /** Persistent polling cadence enforced against sources.last_poll. */
  minPollIntervalMs?: number;
  kind: SourceKind;
  /**
   * Host whose rate limits this source shares with every other source on it.
   *
   * Query-shaped sources are the reason this exists: twelve watched LinkedIn
   * searches are twelve sources but one throttled domain, and letting each hit
   * a 429 independently is how a site gets angry. The poller records a domain
   * cooldown on a block and consults it before every fetch, so one query's 429
   * pauses the rest of that host without touching other domains.
   *
   * Adapters whose ident maps to different hosts (Arbeitnow DE/UK) return the
   * host for that ident; adapters that only ever use one host can ignore the
   * argument.
   */
  domain?: (ident: string) => string | null;
  /**
   * Whether `fetch` returns a genuinely complete snapshot.
   *
   * Absent or true for the ATS adapters: their endpoints list every open role,
   * so an absence is a closure and the poller may act on it.
   *
   * Explicitly `false` for scraped search sources, where pagination is capped,
   * results are re-ranked between pages and promoted rows are injected —
   * "I reached the last page" is evidence the site stopped talking, not
   * evidence of completeness. The poller MUST NOT infer closure from an
   * absence in an incomplete source: doing so would close every posting that
   * merely fell off the ranking, wiping claims and firing false
   * `vanished_while_claimed` alerts. Presence-driven events are unaffected.
   */
  readonly complete?: boolean;
  /**
   * Recognise a /watch argument. Returns null if this adapter doesn't handle
   * it, so the registry can try the next one. Never throws -- a bad reference
   * should produce "no adapter matched", not a stack trace in the channel.
   */
  parse(input: string): ParsedRef | null;
  /**
   * Full snapshot of everything currently open on this board.
   *
   * A snapshot, not a delta -- this is the contract the whole system rests on.
   * An adapter that can only return a partial or truncated view MUST throw,
   * because a short snapshot is indistinguishable from a mass delisting and
   * would fire a close event for every posting it failed to return.
   *
   * `cursor` is the opaque state this adapter returned last time (null on the
   * first call). Adapters that walk a paginated discovery feed use it to resume
   * where they stopped; the rest ignore it.
   */
  fetch(ident: string, etag: string | null, cursor?: string | null): Promise<FetchResult>;
}

/** Shared fetch helper: conditional request, JSON, and a real error message. */
export async function getJson(
  url: string,
  etag: string | null,
): Promise<{ body: unknown | null; etag: string | null }> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "eve",
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });

  if (res.status === 304) return { body: null, etag };
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return { body: await res.json(), etag: res.headers.get("etag") };
}

/** Like getJson, but POSTs a JSON body -- Workday's search endpoint takes no query string. */
export async function postJson(url: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "eve",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Boards ship JD bodies as HTML; the fit scorer wants prose, not markup. */
export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/**
 * Normalise a feed/API timestamp to ISO 8601, or null when it is unusable.
 *
 * Sources disagree about how to say "when": RFC 2822 (`Tue, 22 Sep 2026 …`),
 * ISO with or without a zone, Unix seconds (`1790080189`) and Unix
 * milliseconds are all in this catalogue. The seconds/milliseconds split is
 * the dangerous one — 1.79 billion seconds treated as milliseconds lands in
 * January 1970, and a fresh posting with a 1970 date is silently ineligible for
 * the freshness alert. The magnitude test below is the whole trick: every
 * plausible seconds value is under 1e11 and every plausible milliseconds value
 * is over it, so no date this system can meet sits on the boundary.
 *
 * Out-of-range results are rejected rather than passed through: a nonsense date
 * is unknown, and unknown is already handled correctly downstream.
 */
export function isoDate(value: unknown): string | null {
  if (typeof value === "number") return isoFromEpoch(value);
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{9,13}$/.test(raw)) return isoFromEpoch(Number(raw));
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : isoFromMs(parsed);
}

function isoFromEpoch(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return isoFromMs(value < 1e11 ? value * 1000 : value);
}

function isoFromMs(ms: number): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return date.toISOString();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed non-empty string, or null. The API feeds are full of `""` and `"null"`. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "null" && trimmed !== "undefined" ? trimmed : null;
}

/** A string that is actually a usable absolute HTTP(S) URL, or null. */
export function httpUrl(value: unknown): string | null {
  const raw = cleanString(value);
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

/* ---------------------------------------------------------- registry --- */
// Populated by registry.ts to keep this module free of adapter imports --
// adapters import the interface from here, so importing them back would be a
// cycle.
