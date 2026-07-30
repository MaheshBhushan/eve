import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { stripHtml } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Recognises `personio:slug`, `slug.jobs.personio.de` and `slug.jobs.personio.com`.
 *
 * Personio gives every customer its own tenant host, so the slug is a
 * subdomain rather than a path segment -- the opposite of Greenhouse/Lever.
 * Some tenants additionally CNAME a vanity domain (`jobs.acme.com`) onto the
 * same backend; those are unrecognisable from the URL alone, so they have to be
 * watched with the explicit `personio:<slug>` form.
 */
const PREFIX_RE = /^personio:([a-z0-9][a-z0-9-]*)$/i;
const URL_RE =
  /^(?:https?:\/\/)?([a-z0-9][a-z0-9-]*)\.jobs\.personio\.(?:de|com)(?:[/?].*)?$/i;

/** `/search.json` record. Fields are inconsistently localised (see toPosting). */
interface PersonioJson {
  id: number;
  name: string;
  office?: string | null;
  offices?: string[] | null;
  department?: string | null;
  schedule?: string | null;
  employment_type?: string | null;
  seniority?: string | null;
  /** Always the empty string in practice -- the JSON feed carries no JD body. */
  description?: string | null;
}

/** What we manage to recover from the `/xml` feed for one position. */
interface PersonioXml {
  id: string;
  name: string | null;
  office: string | null;
  department: string | null;
  createdAt: string | null;
  description: string | null;
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const ident = m[1].toLowerCase();
  return { kind: "personio", ident, label: ident };
}

/**
 * Fetch one tenant endpoint.
 *
 * `redirect: "manual"` is the whole bad-slug defence. An unknown or churned
 * tenant (verified with `gitpod` and `demodesk`, both former customers) answers
 * HTTP 307 with `location: https://personio.com` rather than a 404. Following
 * that redirect lands on Personio's marketing site behind a Vercel bot
 * checkpoint, which then answers 200 or 429 with HTML -- so an auto-following
 * client sees "success" and a parse failure instead of "this board does not
 * exist". A real tenant with no open roles answers 200 with an empty list
 * (verified: `moss`, `konux`), so 200-vs-3xx is an exact existence test.
 */
async function getTenant(
  url: string,
  optional: boolean,
): Promise<string | null> {
  const res = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "job-radar" },
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `personio tenant does not exist (${url} -> HTTP ${res.status} ${
        res.headers.get("location") ?? "redirect"
      }); check the slug`,
    );
  }
  // The XML feed is not enabled on every tenant: `sunhat` and `fintiba` answer
  // 404 there while listing roles normally in JSON. That must degrade to "no
  // dates, no JD bodies", never to a failed poll -- a failed poll on a live
  // board is what eventually trips the fail_count backoff.
  if (optional && res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);
  return await res.text();
}

/**
 * Minimal reader for the `<workzag-jobs>` feed. A hand-rolled parser is worth
 * it over a dependency: the document is two levels deep, and we only need six
 * fields out of it.
 */
function parseXml(xml: string): PersonioXml[] {
  const out: PersonioXml[] = [];
  for (const block of xml.match(/<position>[\s\S]*?<\/position>/g) ?? []) {
    // The nested <jobDescription> entries have their own <name> tags, which
    // would otherwise shadow the position's own <name>. Split the descriptions
    // off first so the scalar lookups below can't cross-match.
    const descBlock = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(block);
    const scalars = block.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, "");
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(scalars);
      const v = m?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
      return v ? v : null;
    };

    const id = pick("id");
    if (!id) continue; // A position with no id can't be tracked or deduped.

    // Each section is a heading plus a CDATA-wrapped HTML body; keeping the
    // headings makes the joined text read like the actual job ad.
    let description: string | null = null;
    if (descBlock?.[1]) {
      const parts: string[] = [];
      for (const d of descBlock[1].match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) ??
        []) {
        const heading = /<name>([\s\S]*?)<\/name>/
          .exec(d)?.[1]
          ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .trim();
        const body = stripHtml(
          /<value>([\s\S]*?)<\/value>/
            .exec(d)?.[1]
            ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") ?? null,
        );
        if (body) parts.push(heading ? `${heading}\n${body}` : body);
      }
      description = parts.join("\n\n") || null;
    }

    out.push({
      id,
      name: pick("name"),
      office: pick("office"),
      department: pick("department"),
      createdAt: pick("createdAt"),
      description,
    });
  }
  return out;
}

/**
 * Offices arrive as a comma-joined string in `office` and as an array in
 * `offices`; the array is the reliable one because office names themselves
 * contain commas on some tenants. Order is stable per board, which matters
 * because this string feeds the dedupe key.
 */
function cleanLocation(offices: string[] | null | undefined, office: string | null): string | null {
  const list = (offices?.length ? offices : (office ?? "").split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length ? list.join(", ") : null;
}

function toPosting(
  id: string,
  slug: string,
  json: PersonioJson | undefined,
  xml: PersonioXml | undefined,
): FetchedPosting | null {
  const title = json?.name ?? xml?.name ?? null;
  if (!title) return null;

  const offices = json?.offices ?? (xml?.office ? [xml.office] : null);
  const location = cleanLocation(offices, json?.office ?? xml?.office ?? null);
  const remote =
    offices && offices.length
      ? offices.some((o) => /^remote$/i.test(o.trim()))
      : null;

  return {
    externalId: id,
    title,
    // Neither feed states a company name -- `subcompany` is empty on every
    // tenant probed -- so the slug the owner watched is all we have.
    company: slug,
    location,
    remote,
    department: json?.department ?? xml?.department ?? null,
    url: `https://${slug}.jobs.personio.de/job/${id}`,
    // Only the XML feed states a date (`createdAt`, already ISO-8601 with an
    // offset). When we fell back to the JSON feed there is genuinely no date,
    // and null is the honest answer -- the freshness alert only trusts stated
    // dates, so inventing "now" here would corrupt it.
    postedAt: xml?.createdAt ?? null,
    closesAt: null, // Personio exposes no application deadline publicly.
    // `description` in the JSON feed is always "", so the XML feed is the only
    // source of a JD. A delisted posting can never be refetched, hence the
    // extra request per poll rather than lazy loading.
    description: xml?.description ?? null,
  };
}

async function fetchBoard(ident: string, etag: string | null): Promise<FetchResult> {
  // Two feeds, because neither alone is sufficient:
  //   /xml         -- has createdAt and the JD body, but comes back COMPLETELY
  //                   EMPTY (zero bytes, HTTP 200) on some live tenants
  //                   (verified: `sunhat` and `fintiba`, both of which list
  //                   roles fine in JSON). Trusting it alone would report a
  //                   populated board as empty and close every posting on it.
  //   /search.json -- always populated, but states no date and no JD.
  // So JSON supplies the authoritative id set and XML enriches it. Postings
  // are unioned rather than intersected: a posting present in only one feed is
  // still open, and dropping it would be read downstream as a closure.
  //
  // Both feeds serve ETags, but this adapter deliberately does not use them.
  // The two feeds change independently, so one 304 and one 200 is the common
  // case -- and a 304 on either side would silently shrink the merged result:
  // a 304 on JSON collapses the id set to XML-only (which is empty on some
  // tenants), and a 304 on XML strips the dates and JD bodies off every
  // posting. Both are snapshot corruption, and the bodies are a few tens of
  // kilobytes, so an unconditional fetch is the right trade.
  const [xmlText, jsonText] = await Promise.all([
    getTenant(`https://${ident}.jobs.personio.de/xml`, true),
    getTenant(`https://${ident}.jobs.personio.de/search.json`, false),
  ]);

  const xmlById = new Map<string, PersonioXml>();
  for (const p of parseXml(xmlText ?? "")) xmlById.set(p.id, p);

  let body: unknown;
  try {
    body = JSON.parse(jsonText ?? "null");
  } catch {
    throw new Error(`personio tenant ${ident} returned non-JSON from /search.json`);
  }
  // A tenant host that exists but is not serving a job board answers 200 with
  // an object or an HTML page rather than the expected array; treat that as
  // broken instead of as "no open roles".
  if (!Array.isArray(body)) {
    throw new Error(`personio tenant ${ident} did not return a positions array`);
  }

  const jsonById = new Map<string, PersonioJson>();
  for (const j of body as PersonioJson[]) {
    if (j?.id != null) jsonById.set(String(j.id), j);
  }

  const ids = new Set<string>([...jsonById.keys(), ...xmlById.keys()]);
  const postings: FetchedPosting[] = [];
  for (const id of ids) {
    const p = toPosting(id, ident, jsonById.get(id), xmlById.get(id));
    if (p) postings.push(p);
  }

  return { postings, etag: null };
}

export const personio: Adapter = {
  kind: "personio",
  parse,
  fetch: fetchBoard,
};
