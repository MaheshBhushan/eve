import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { getJson, stripHtml } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/** Recognises `ashby:name`, `jobs.ashbyhq.com/name`. */
const PREFIX_RE = /^ashby:([a-z0-9][a-z0-9-]*)$/i;
const URL_RE = /^(?:https?:\/\/)?jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-]*)(?:[/?].*)?$/i;

interface AshbyJob {
  id: string;
  title: string;
  department?: string | null;
  team?: string | null;
  location?: string | null;
  secondaryLocations?: Array<{ location?: string | null }> | null;
  publishedAt?: string | null;
  isListed?: boolean;
  isRemote?: boolean | null;
  workplaceType?: string | null;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const ident = m[1].toLowerCase();
  return { kind: "ashby", ident, label: ident };
}

function locationDisplay(job: AshbyJob): string | null {
  const extras = (job.secondaryLocations ?? [])
    .map((l) => l.location)
    .filter((l): l is string => !!l);
  if (!job.location) return extras[0] ?? null;
  // A role open in Berlin + Remote-EU is one posting with several locations,
  // not several postings -- only `location` feeds identity/matching; the
  // rest is display detail only, folded into a "(+N more)" suffix.
  return extras.length > 0 ? `${job.location} (+${extras.length} more)` : job.location;
}

function toPosting(job: AshbyJob, slug: string): FetchedPosting {
  const description = job.descriptionPlain ?? stripHtml(job.descriptionHtml) ?? null;
  return {
    externalId: job.id,
    // Ashby titles routinely carry a leading space in the raw feed; trim it.
    title: job.title.trim(),
    company: slug, // Ashby's job-board API has no company field either.
    location: locationDisplay(job),
    remote:
      job.isRemote === true || job.isRemote === false
        ? job.isRemote
        : job.workplaceType
          ? job.workplaceType.toLowerCase().includes("remote")
          : null,
    department: job.department ?? job.team ?? null,
    url: job.jobUrl ?? job.applyUrl ?? "",
    postedAt: job.publishedAt ?? null,
    closesAt: null, // Ashby's job-board API has no deadline field.
    description,
  };
}

async function fetchBoard(ident: string, etag: string | null): Promise<FetchResult> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${ident}`;
  const { body, etag: newEtag } = await getJson(url, etag);
  if (body === null) return { postings: null, etag: newEtag };

  const jobs = (body as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) {
    throw new Error(`ashby board ${ident} did not return a jobs array`);
  }

  const postings = (jobs as AshbyJob[])
    // isListed:false means the board itself is hiding the posting -- as
    // good as closed, so it must not be surfaced as an open snapshot entry.
    .filter((j) => j.isListed !== false)
    .map((j) => toPosting(j, ident));
  return { postings, etag: newEtag };
}

export const ashby: Adapter = {
  kind: "ashby",
  parse,
  fetch: fetchBoard,
};
