import { createHash } from "node:crypto";
import type { FetchedPosting } from "./types.ts";

/**
 * Posting identity.
 *
 * A job board hands back a full snapshot of what is open right now, so the
 * absence of a posting is the close event and the reappearance of one is the
 * repost event. Both of those readings depend entirely on being able to say
 * "this is the same job I saw last week" — and no board gives us anything to
 * say it with. An ATS id (Greenhouse `4712345`, Lever uuid, Ashby uuid) is
 * stable only while the posting is live: close a search, reopen it a month
 * later, and the same role comes back under a brand new id. Keying on the ATS
 * id would therefore report every repost as a fresh opening — the single
 * loudest source of false alerts available to us — and would delete the
 * "reposted role" signal, which is one of the four things this bot exists to
 * raise.
 *
 * So identity is synthesised from the three things a human uses to decide two
 * listings are the same job: company, role, place. Everything below is in
 * service of making those three survive the cosmetic churn boards inflict on
 * them between reposts.
 *
 * The bias throughout: aggressive on decoration, conservative on anything that
 * could distinguish two genuinely different roles. A missed repost costs one
 * spurious "new posting" alert. An over-eager merge silently swallows a real
 * opening, and nobody ever finds out.
 */

/** NFKC + casefold + de-accent, the shared prelude for every field. */
function fold(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // München/Munchen, Zürich/Zurich — boards mix these freely
    .toLowerCase()
    .normalize("NFKC");
}

/** Collapse everything that isn't a letter or digit down to single spaces. */
function squash(s: string): string {
  return s.replace(/[^\p{L}\p{N}+#]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Ubiquitous on German-language postings and freely added, dropped or reordered
// between reposts: (m/w/d), (w/m/d), (m/f/d), (m/w/x), (d/f/m), bare m/w/d.
const GENDER = /\(?\s*\b[mwfdxagn](?:\s*[\/|]\s*[mwfdxagn]){1,3}\b\s*\)?/g;
const ALL_GENDERS = /\(?\s*\ball[\s-]+genders?\b\s*\)?/g;

const EMPLOYMENT =
  /\(?\s*\b(?:full[\s-]?time|part[\s-]?time|vollzeit|teilzeit|permanent|contract|festanstellung)\b\s*\)?/g;

// "urgent" and "hiring now" are never part of a real job title, so they can go
// anywhere they appear. "new" very much can be ("New Business Manager"), so it
// is only stripped where it sits as decoration: bracketed, or fenced off by a
// separator at the very start or end of the title.
const URGENT = /\(?\s*\b(?:urgent(?:ly)?(?:\s+hiring)?|hiring\s+now|immediate\s+start)\b\s*\)?/g;
const NEW_DECORATION = [
  /[\(\[\{]\s*new\s*[\)\]\}]/g,
  /^\s*new\s*[-–—:|•]+\s*/,
  /\s*[-–—:|•]+\s*new\s*$/,
];

// Requisition numbers: REQ-10422, Job ID: 4471, Ref 9912, (88123), #10422.
const REQ = [
  /\b(?:job\s*(?:id|code|nr\.?|no\.?)|requisition(?:\s*id)?|req(?:\.|\s|-|#|:)?|ref(?:erence)?(?:\.|\s|-|#|:)?|stellen[a-z]*nummer)\s*[:#-]?\s*[a-z]{0,4}[-\s]?\d{2,}/g,
  /[\(\[]\s*#?\s*[a-z]{0,4}[-\s]?\d{3,}\s*[\)\]]/g,
  /\s#\d{3,}\b/g,
];

// A trailing work-arrangement token the board glued onto the title. Location is
// its own field; leaving it in the title would fork "Backend Engineer" from
// "Backend Engineer - Remote" for no reason.
const TRAILING_ARRANGEMENT =
  /[\s\-–—|,/(\[]+\s*(?:100%\s*)?(?:fully\s+)?(?:remote|hybrid|on[\s-]?site|onsite|in[\s-]?office|wfh|work\s+from\s+home)\b[^)\]]*[\)\]]?\s*$/i;

/**
 * Strip decoration from a title without touching anything that separates two
 * real roles. Seniority in particular is load-bearing: "Senior Backend
 * Engineer" and "Backend Engineer" are two different openings and merging them
 * hides one of them forever, so no seniority word is ever removed here.
 */
export function normaliseTitle(title: string): string {
  let t = fold(title);

  t = t.replace(ALL_GENDERS, " ").replace(GENDER, " ");
  for (const re of REQ) t = t.replace(re, " ");
  t = t.replace(EMPLOYMENT, " ").replace(URGENT, " ");
  for (const re of NEW_DECORATION) t = t.replace(re, " ");

  // Repeat: boards stack these ("Engineer - Remote (Hybrid)").
  for (let i = 0; i < 3 && TRAILING_ARRANGEMENT.test(t); i++) {
    t = t.replace(TRAILING_ARRANGEMENT, " ");
  }

  return squash(t);
}

const REMOTE = /\b(?:remote|wfh|work\s+from\s+home|anywhere|home[\s-]?office|telecommute)\b/;
const HYBRID = /\bhybrid\b/;
// Country tails boards append to a city, plus the "Berlin Office" / "Berlin HQ"
// habit. Only the city survives, because the city is what a human compares.
const OFFICE_TAIL = /\b(?:office|hq|headquarters|campus|standort|buro|site)\b/g;

/**
 * Reduce a location to one comparable token.
 *
 * Hybrid is deliberately *not* remote: it implies a specific office you have to
 * be near, so "Berlin (Hybrid)" must key to Berlin and not collapse into the
 * global remote bucket with a job in São Paulo.
 */
export function normaliseLocation(loc: string | null, remote?: boolean | null): string {
  const raw = loc?.trim() ?? "";
  if (!raw) return remote ? "remote" : "";

  const l = fold(raw);

  // Hybrid first: a hybrid listing often also says "remote" ("Remote/Hybrid -
  // Berlin"), and the office requirement is the stronger claim.
  if (!HYBRID.test(l) && REMOTE.test(l)) return "remote";

  // "Berlin, Germany" / "Berlin, DE" / "Berlin, Berlin, Germany" — the first
  // segment is the city on every board we read. The arrangement words go first
  // so they can't be mistaken for the city ("Hybrid - Munich").
  const stripped = l
    .replace(/\([^)]*\)/g, " ")
    .replace(new RegExp(HYBRID.source, "g"), " ")
    .replace(new RegExp(REMOTE.source, "g"), " ")
    .replace(OFFICE_TAIL, " ");
  const city = stripped.split(/[,;\/•|–—-]|\bor\b/).find((s) => squash(s)) ?? "";
  const cleaned = squash(city);

  // A location that was nothing but "(Hybrid)" tells us no city; fall back
  // rather than inventing one.
  if (!cleaned) return remote && !HYBRID.test(l) ? "remote" : "hybrid";
  return cleaned;
}

// Stripped only from the tail, and repeatedly: "Acme GmbH & Co. KG" -> "acme".
// Anchoring at the end matters — "SE Labs" and "AG Grid" are not suffixes.
const LEGAL_SUFFIX =
  /\s*(?:&\s*co\.?|gmbh|mbh|ug|ag|se|kg|ohg|e\.?\s?v|inc|incorporated|llc|l\.l\.c|ltd|limited|plc|corp(?:oration)?|co|company|bv|b\.v|nv|n\.v|as|a\/s|ab|oy|sa|s\.a|sas|srl|s\.r\.l|spa|pty|pte|kft|sp\.?\s?z\s?o\.?o)\.?\s*$/;

/**
 * Companies rename themselves cosmetically far more often than they rename
 * themselves: "Acme GmbH" on the careers page, "Acme" on the aggregator. Left
 * alone that forks one employer into two and breaks every cross-board match.
 */
export function normaliseCompany(company: string): string {
  let c = fold(company).replace(/[.,]+$/, "");
  for (let i = 0; i < 4 && LEGAL_SUFFIX.test(c); i++) c = c.replace(LEGAL_SUFFIX, "");
  return squash(c);
}

/**
 * The stable identity of a posting: company + role + place, hashed.
 *
 * Notably *not* scoped by source. The same job on a company's own Greenhouse
 * board and on an aggregator is one job; the per-source uniqueness constraint
 * in SQLite keeps both rows, and this shared key is what relates them.
 *
 * Truncated to 12 hex chars (48 bits). Collisions need ~16M distinct postings
 * to reach even a percent of likelihood, and we track thousands — the win is a
 * key short enough to eyeball in a log line or a Discord custom_id.
 */
export function postingKey(p: FetchedPosting): string {
  const company = normaliseCompany(p.company);
  const location = normaliseLocation(p.location, p.remote);

  // The board sometimes glues the location onto the title ("Backend Engineer -
  // Berlin"). We can't strip arbitrary city names blind, but here we know what
  // the location field says, so a trailing segment that matches it is safe to
  // drop.
  let title = normaliseTitle(p.title);
  if (location && location !== "remote") {
    const tail = new RegExp(`\\s${escapeRe(location)}$`);
    const stripped = title.replace(tail, "");
    if (stripped.trim()) title = stripped.trim();
  }

  // NUL separators so a company whose name ends in the words a title starts
  // with can't shift the boundary and alias onto another posting.
  const material = `${company}\u0000${title}\u0000${location}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
