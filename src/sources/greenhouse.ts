import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { getJson, stripHtml } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/** Recognises `greenhouse:token`, `boards.greenhouse.io/token`, `job-boards.greenhouse.io/token`. */
const PREFIX_RE = /^greenhouse:([a-z0-9][a-z0-9-]*)$/i;
const URL_RE = /^(?:https?:\/\/)?(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9-]*)(?:[/?].*)?$/i;

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  company_name?: string;
  updated_at?: string;
  first_published?: string | null;
  application_deadline?: string | null;
  location?: { name?: string | null } | null;
  departments?: Array<{ name?: string | null }> | null;
  content?: string | null;
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const ident = m[1].toLowerCase();
  return { kind: "greenhouse", ident, label: ident };
}

/**
 * Greenhouse's `content` field is double-escaped: the JSON string itself
 * contains literal `&lt;h2&gt;` rather than a real `<h2>` tag. If you run
 * stripHtml straight on it, the tag-stripping regex never matches anything
 * (there are no real `<` characters to find) and the visible JD ends up
 * full of `&lt;/p&gt;` litter. Decoding the entities first turns it into
 * ordinary HTML, which stripHtml can then strip normally.
 */
function unescapeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function toPosting(job: GreenhouseJob, fallbackCompany: string): FetchedPosting {
  const description = job.content ? stripHtml(unescapeEntities(job.content)) : null;
  return {
    externalId: String(job.id),
    title: job.title,
    company: job.company_name || fallbackCompany,
    location: job.location?.name ?? null,
    remote: null,
    department: job.departments?.[0]?.name ?? null,
    url: job.absolute_url,
    // first_published is the board's own posting date; updated_at is the
    // best we can do when a job was never explicitly first-published.
    postedAt: job.first_published ?? job.updated_at ?? null,
    closesAt: job.application_deadline ?? null,
    description,
  };
}

async function fetchBoard(ident: string, etag: string | null): Promise<FetchResult> {
  // content=true is not optional: a delisted posting can never be refetched,
  // so the JD text must be captured the first time we see it or it is lost
  // for good once the role closes.
  const url = `https://boards-api.greenhouse.io/v1/boards/${ident}/jobs?content=true`;
  const { body, etag: newEtag } = await getJson(url, etag);
  if (body === null) return { postings: null, etag: newEtag };

  const jobs = (body as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) {
    throw new Error(`greenhouse board ${ident} did not return a jobs array`);
  }

  const postings = (jobs as GreenhouseJob[]).map((j) => toPosting(j, ident));
  return { postings, etag: newEtag };
}

export const greenhouse: Adapter = {
  kind: "greenhouse",
  parse,
  fetch: fetchBoard,
};
