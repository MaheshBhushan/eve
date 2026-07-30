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
}

export interface Adapter {
  kind: SourceKind;
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
   */
  fetch(ident: string, etag: string | null): Promise<FetchResult>;
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

/* ---------------------------------------------------------- registry --- */
// Populated by registry.ts to keep this module free of adapter imports --
// adapters import the interface from here, so importing them back would be a
// cycle.
