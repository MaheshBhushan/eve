import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { postJson } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Recognises `workday:tenant.wd3/site` and pasted
 * `tenant.wd3.myworkdayjobs.com/site` (or `/en-US/site`) URLs. The wd host
 * number is per-tenant and not derivable from the tenant name alone, so it
 * has to be carried in the ident.
 */
const PREFIX_RE = /^workday:([a-z0-9-]+)\.(wd\d+)\/([a-z0-9][a-z0-9_-]*)$/i;
const URL_RE =
  /^(?:https?:\/\/)?([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([a-z0-9][a-z0-9_-]*)(?:[/?].*)?$/i;

/** Workday's search endpoint silently caps `limit` at 20 regardless of what is asked. */
const PAGE_SIZE = 20;
/**
 * Request cap. Mirrors the smartrecruiters headroom: bounds a runaway loop if
 * the board's reported total ever disagrees with reality.
 */
const MAX_PAGES = 200;

interface WdPosting {
  title: string;
  externalPath: string;
  locationsText?: string | null;
  postedOn?: string | null;
  bulletFields?: string[] | null;
}

interface WdPage {
  total?: number;
  jobPostings?: WdPosting[];
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const tenant = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  const site = m[3];
  return { kind: "workday", ident: `${tenant}.${host}/${site}`, label: site };
}

/** Splits `tenant.wd3/site` back into its three parts. */
function parts(ident: string): { tenant: string; host: string; site: string } {
  const m = /^([a-z0-9-]+)\.(wd\d+)\/(.+)$/i.exec(ident);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new Error(`workday: malformed ident "${ident}"`);
  }
  return { tenant: m[1], host: m[2], site: m[3] };
}

function toPosting(p: WdPosting, tenantHost: string, site: string): FetchedPosting {
  return {
    // bulletFields carries the req id on every tenant seen so far; fall back
    // to the path when a tenant omits it rather than dropping the posting.
    externalId: p.bulletFields?.[0] || p.externalPath,
    title: p.title,
    company: site,
    location: p.locationsText ?? null,
    remote: null,
    department: null,
    url: `https://${tenantHost}.myworkdayjobs.com/${site}${p.externalPath}`,
    // Workday's list endpoint only gives relative text ("Posted 3 Days Ago"),
    // which is not a date the poller can trust as exact -- leaving this null
    // makes posted_at_exact false and falls back to first_seen, same as any
    // other board that doesn't state a publish date.
    postedAt: null,
    closesAt: null,
    description: null,
  };
}

/** One page of the jobs search. Throws unless the page is well-formed. */
async function fetchPage(tenant: string, host: string, site: string, offset: number): Promise<WdPage> {
  const url = `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const body = await postJson(url, {
    appliedFacets: {},
    limit: PAGE_SIZE,
    offset,
    searchText: "",
  });
  const page = body as WdPage;
  if (!page || !Array.isArray(page.jobPostings) || typeof page.total !== "number") {
    throw new Error(`workday ${tenant}/${site} returned an unexpected page shape at offset ${offset}`);
  }
  return page;
}

async function fetchBoard(ident: string, _etag: string | null): Promise<FetchResult> {
  const { tenant, host, site } = parts(ident);
  const tenantHost = `${tenant}.${host}`;

  const first = await fetchPage(tenant, host, site, 0);
  const total = first.total ?? 0;

  if (total === 0) {
    return { postings: [], etag: null };
  }

  const raw: WdPosting[] = [...(first.jobPostings ?? [])];
  let pages = 1;
  while (raw.length < total && pages < MAX_PAGES) {
    // Workday's `total` field is unreliable past offset 0 (it comes back as 0
    // on later pages on real tenants) -- the loop bound is fixed to the total
    // captured from the first page, and later pages are only consulted for
    // their postings.
    const page = await fetchPage(tenant, host, site, raw.length);
    if (!page.jobPostings?.length) {
      throw new Error(
        `workday ${tenant}/${site} truncated: got ${raw.length} of ${total} postings ` +
          `(empty page at offset ${raw.length})`,
      );
    }
    raw.push(...page.jobPostings);
    pages++;
  }

  if (raw.length < total) {
    throw new Error(
      `workday ${tenant}/${site} exceeded the ${MAX_PAGES}-page cap with ` +
        `${raw.length} of ${total} postings; refusing to return a partial snapshot`,
    );
  }

  const byId = new Map<string, FetchedPosting>();
  for (const p of raw) {
    if (!p?.externalPath) continue;
    const posting = toPosting(p, tenantHost, site);
    byId.set(posting.externalId, posting);
  }

  return { postings: [...byId.values()], etag: null };
}

export const workday: Adapter = {
  kind: "workday",
  parse,
  fetch: fetchBoard,
};
