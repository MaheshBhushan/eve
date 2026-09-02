import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/**
 * Recognises `successfactors:<host>` and pasted career-site URLs whose path
 * starts with /search/, /go/ or /job/, or the bare host root (the search page
 * SAP's own career sites default to). Kept narrow on purpose: SuccessFactors
 * is scraped HTML, not an API, so a false-positive match here would send
 * unrelated input into a regex parser that has no idea what it's looking at.
 */
const PREFIX_RE = /^successfactors:([a-z0-9][a-z0-9.-]*)$/i;
const URL_RE =
  /^(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\/?(?:(?:search|go|job)(?:[/?].*)?)?$/i;

/** SuccessFactors' anti-bot layer treats a bare/eve UA as a bot; look like a real browser. */
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Results table page size ceiling seen in practice; the real value is read from the page. */
const MAX_PAGES = 60;

/**
 * How far short of the aria-label total a collected snapshot may fall before
 * being treated as truncated rather than live drift. SuccessFactors' total is
 * a live count re-evaluated on every page (same trap as SmartRecruiters'
 * totalFound), so a posting opening or closing mid-walk can shift it by a
 * handful without the snapshot actually being incomplete.
 */
const TOLERANCE = 3;

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const host = m[1].toLowerCase();
  return { kind: "successfactors", ident: host, label: host };
}

/**
 * Turns a career-site host into a readable company label when the page gives
 * us nothing better (no og:site_name, generic <title>). "jobs.sap.com" -> "Sap".
 */
function labelFromHost(host: string): string {
  const parts = host.split(".").filter((p) => !["www", "jobs", "careers", "com", "net", "org", "co"].includes(p));
  const name = parts[0] ?? host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

interface SfRow {
  externalId: string;
  title: string;
  location: string | null;
  path: string;
}

interface SfPage {
  rows: SfRow[];
  pageSize: number;
  total: number;
}

const ROW_RE = /<tr class="data-row">([\s\S]*?)<\/tr>/g;
// SAP's markup doesn't keep attribute order stable between the desktop and
// phone-duplicate anchors (href-before-class in one, class-before-href in the
// other), so match the tag first and pull href/class out of it independently.
const ANCHOR_RE = /<a\s+([^>]*)>([^<]*)</g;
const HREF_ATTR_RE = /href="([^"]+)"/;
const CLASS_ATTR_RE = /class="([^"]*)"/;
const LOCATION_RE = /<td class="colLocation[^"]*"[\s\S]*?<span class="jobLocation">([\s\S]*?)<\/span>/;
const ARIA_TOTAL_RE = /Page (\d+) of (\d+), Results (\d+) to (\d+) of (\d+)/;
const LOGIN_RE = /<input[^>]*type=["']password["']|id=["']loginForm["']|<title>[^<]*(sign in|log ?in)/i;

function parsePage(html: string): SfPage {
  const ariaMatch = ARIA_TOTAL_RE.exec(html);
  if (!ariaMatch) {
    if (LOGIN_RE.test(html)) {
      throw new Error("successfactors: redirected to an SSO login page instead of the search results");
    }
    throw new Error("successfactors: could not find the results header (page shape changed?)");
  }
  const from = Number(ariaMatch[3]);
  const to = Number(ariaMatch[4]);
  const total = Number(ariaMatch[5]);
  const pageSize = to - from + 1;

  const rows: SfRow[] = [];
  for (const rowMatch of html.matchAll(ROW_RE)) {
    const rowHtml = rowMatch[1] ?? "";
    let path: string | null = null;
    let title: string | null = null;
    for (const anchorMatch of rowHtml.matchAll(ANCHOR_RE)) {
      const attrs = anchorMatch[1] ?? "";
      if (!CLASS_ATTR_RE.exec(attrs)?.[1]?.split(/\s+/).includes("jobTitle-link")) continue;
      const href = HREF_ATTR_RE.exec(attrs)?.[1];
      if (!href) continue;
      path = href.trim();
      title = (anchorMatch[2] ?? "").trim();
      break;
    }
    if (!path || !title) continue;
    const segments = path.split("/").filter(Boolean);
    const externalId = segments[segments.length - 1];
    if (!externalId) continue;
    const locationMatch = LOCATION_RE.exec(rowHtml);
    const location = locationMatch
      ? (locationMatch[1] ?? "").replace(/\s+/g, " ").trim() || null
      : null;
    rows.push({
      externalId,
      title,
      location,
      path,
    });
  }

  return { rows, pageSize: pageSize > 0 ? pageSize : rows.length || 25, total };
}

async function fetchPage(host: string, startrow: number): Promise<{ page: SfPage; html: string }> {
  const url = `https://${host}/search/?q=&startrow=${startrow}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": CHROME_UA,
      accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status} ${res.statusText}`);

  const finalHost = new URL(res.url).host.toLowerCase();
  if (finalHost !== host) {
    throw new Error(
      `successfactors ${host}: redirected off-host to ${finalHost} (likely an SSO login gate)`,
    );
  }

  const html = await res.text();
  return { page: parsePage(html), html };
}

function toPosting(row: SfRow, host: string, company: string): FetchedPosting {
  return {
    externalId: row.externalId,
    title: row.title,
    company,
    location: row.location,
    remote: null,
    department: null,
    url: `https://${host}${row.path}`,
    postedAt: null,
    closesAt: null,
    description: null,
  };
}

/** Company display name: prefer a clean <title>, fall back to a label derived from the host. */
function deriveCompany(html: string, host: string): string {
  const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.trim();
  if (title && !/^\s*$/.test(title) && !/search|results/i.test(title) && title.length < 40) {
    return title;
  }
  return labelFromHost(host);
}

async function fetchBoard(host: string, _etag: string | null): Promise<FetchResult> {
  const { page: first, html: firstHtml } = await fetchPage(host, 0);
  const company = deriveCompany(firstHtml, host);

  const byId = new Map<string, FetchedPosting>();
  for (const row of first.rows) byId.set(row.externalId, toPosting(row, host, company));

  let pages = 1;
  let startrow = first.pageSize;
  while (byId.size < first.total && pages < MAX_PAGES) {
    const { page } = await fetchPage(host, startrow);
    if (!page.rows.length) {
      throw new Error(
        `successfactors ${host} truncated: got ${byId.size} of ${first.total} postings ` +
          `(empty page at startrow ${startrow})`,
      );
    }
    for (const row of page.rows) byId.set(row.externalId, toPosting(row, host, company));
    startrow += page.pageSize || page.rows.length;
    pages++;
  }

  if (byId.size < first.total - TOLERANCE) {
    throw new Error(
      `successfactors ${host} exceeded the ${MAX_PAGES}-page cap (or the board stopped talking) with ` +
        `${byId.size} of ${first.total} postings; refusing to return a partial snapshot`,
    );
  }

  return { postings: [...byId.values()], etag: null };
}

export const successfactors: Adapter = {
  kind: "successfactors",
  parse,
  fetch: fetchBoard,
};
