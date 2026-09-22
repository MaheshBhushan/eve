import { XMLParser } from "fast-xml-parser";
import { isoDate } from "./index.ts";

/**
 * Shared RSS/Atom parsing for the feed-shaped sources.
 *
 * Feeds lie in specific, repeatable ways, and every one of them is a trap for a
 * hand-rolled regex parser:
 *
 *   - one item and one hundred items must produce the same shape, so `item`,
 *     `entry` and `category` are forced to arrays;
 *   - `description` may be CDATA, escaped HTML, or absent while
 *     `content:encoded` carries the real body;
 *   - namespaced tags (`content:encoded`, `media:content`) keep their prefix,
 *     and source-specific extensions (WWR's `region`/`country`/`state`/`skills`)
 *     are the eligibility evidence we cannot afford to drop;
 *   - a missing `pubDate` is unknown, never "now".
 *
 * So the parser normalizes all of that into one flat item shape and keeps the
 * extension tags in a lowercased local-name map for adapters to read. Values
 * are left as strings (`parseTagValue: false`) because a GUID that happens to be
 * all digits must not become a number and lose leading zeros.
 *
 * Entity handling is enabled with explicit expansion limits: standard named and
 * numeric references (`&amp;`, `&#252;`) are decoded as XML requires, while a
 * hostile DTD-defined entity bomb trips `maxExpandedLength`/`maxEntityCount`
 * instead of expanding. A `DOCTYPE` is rejected outright — no feed in this
 * catalogue declares one, and refusing it removes the entire custom-entity
 * class rather than relying on the library's expansion bounds to catch it.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  // Decodes numeric character references (`&#252;` -> "ü") and the HTML entity
  // table. Without this, `M&#252;nchen` in a title reaches the filter as
  // literal text and never matches a config term.
  htmlEntities: true,
  processEntities: {
    enabled: true,
    maxEntitySize: 10_000,
    maxExpansionDepth: 16,
    // A feed legitimately carries tens of thousands of `&amp;` references
    // (WWR's 840 KB feed exceeds 10k on its own), so the useful bound is the
    // *output* size, not the reference count. `maxExpandedLength` is what makes
    // a DTD-defined bomb fail instead of expanding, and `maxEntityCount` caps
    // how many definitions a hostile document can declare in the first place.
    maxTotalExpansions: 1_000_000,
    maxExpandedLength: 1_000_000,
    maxEntityCount: 200,
  },
  // Depth bound: a real feed is a flat list under one container.
  maxNestedTags: 40,
  isArray: (name) => name === "item" || name === "entry" || name === "category",
});

/** Well past any real feed in this catalogue (VueJobs' 985 is the largest seen). */
export const MAX_FEED_ITEMS = 5_000;

export interface FeedItem {
  guid: string | null;
  link: string | null;
  title: string | null;
  /** Plain HTML as served; adapters strip it. Description, content:encoded or summary. */
  description: string | null;
  /** Normalized to ISO, or null when the feed does not state one. */
  pubDate: string | null;
  expiresAt: string | null;
  categories: string[];
  /**
   * Every other leaf tag on the item, keyed by lowercased local tag name
   * (namespace prefix dropped, full name kept as well when they differ).
   */
  tags: Record<string, string[]>;
}

export interface ParsedFeed {
  title: string | null;
  items: FeedItem[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** fast-xml-parser's text representation: a string, or {"#text": …} with attrs. */
function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObject(v)) return text(v["#text"]);
  return null;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function push(into: Record<string, string[]>, key: string, value: string): void {
  (into[key] ??= []).push(value);
  const colon = key.lastIndexOf(":");
  if (colon !== -1) {
    const local = key.slice(colon + 1);
    (into[local] ??= []).push(value);
  }
}

/** Walk an item, collecting every leaf value by tag name. */
function flatten(node: unknown, into: Record<string, string[]>, depth = 0): void {
  if (depth > 6 || !isObject(node)) return;
  for (const [rawKey, value] of Object.entries(node)) {
    if (rawKey.startsWith("@_") || rawKey === "#text") continue;
    const key = rawKey.toLowerCase();
    if (isObject(value)) {
      flatten(value, into, depth + 1);
      const t = text(value);
      if (t !== null) push(into, key, t);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        const t = text(entry);
        if (t !== null) push(into, key, t);
      }
    } else {
      const t = text(value);
      if (t !== null) push(into, key, t);
    }
  }
}

/** Atom `<link href=…/>` carries the URL in an attribute, RSS in the text. */
function hrefFrom(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const href = hrefFrom(entry);
      if (href) return href;
    }
    return null;
  }
  if (isObject(raw)) {
    const href = raw["@_href"];
    if (typeof href === "string" && href.trim()) return href.trim();
    return text(raw["#text"]);
  }
  return null;
}

function first(tags: Record<string, string[]>, ...names: string[]): string | null {
  for (const name of names) {
    const v = tags[name];
    if (v?.length) return v[0]!;
  }
  return null;
}

function parseItem(node: unknown): FeedItem | null {
  if (!isObject(node)) return null;
  const tags: Record<string, string[]> = {};
  flatten(node, tags);

  const link =
    hrefFrom(node.link) ??
    (typeof node.guid === "string" && /^https?:/i.test(node.guid) ? node.guid : null);

  return {
    guid: first(tags, "guid", "id"),
    link,
    title: first(tags, "title"),
    description: first(tags, "description", "encoded", "content", "summary"),
    pubDate: isoDate(first(tags, "pubdate", "published", "date", "updated")),
    expiresAt: isoDate(first(tags, "expires_at", "expirationdate", "expires")),
    categories: tags.category ?? [],
    tags,
  };
}

export function parseFeed(xml: string): ParsedFeed {
  const source = xml.replace(/^\uFEFF/, "");
  // No feed here declares a DTD. Refusing one removes the custom-entity class
  // entirely instead of trusting the library's expansion bounds.
  if (/<!DOCTYPE/i.test(source)) {
    throw new Error("feed declares a DOCTYPE, which is not accepted");
  }

  let doc: unknown;
  try {
    doc = parser.parse(source);
  } catch (e) {
    throw new Error(`feed is not valid XML: ${(e as Error).message}`);
  }
  if (!isObject(doc)) throw new Error("feed XML has no root element");

  const rss = isObject(doc.rss) ? doc.rss : null;
  const container =
    (rss && isObject(rss.channel) ? rss.channel : null) ??
    (isObject(doc.feed) ? doc.feed : null) ??
    (isObject(doc["rdf:RDF"]) ? doc["rdf:RDF"] : null) ??
    (isObject(doc.RDF) ? doc.RDF : null);
  if (!container) throw new Error("feed XML has no channel/feed element");

  const entries = asArray(container.item ?? container.entry);
  if (entries.length > MAX_FEED_ITEMS) {
    throw new Error(`feed has ${entries.length} items, over the ${MAX_FEED_ITEMS} cap`);
  }

  const items = entries.map(parseItem).filter((i): i is FeedItem => i !== null);
  return { title: text(container.title), items };
}
