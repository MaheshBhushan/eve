import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import { getJson } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/** Recognises `lever:slug`, `jobs.lever.co/slug`, `jobs.eu.lever.co/slug`. */
const PREFIX_RE = /^lever:([a-z0-9][a-z0-9-]*)$/i;
const URL_RE = /^(?:https?:\/\/)?jobs\.(?:eu\.)?lever\.co\/([a-z0-9][a-z0-9-]*)(?:[/?].*)?$/i;

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: string | null;
  country?: string | null;
  categories?: {
    commitment?: string | null;
    department?: string | null;
    team?: string | null;
    location?: string | null;
    allLocations?: string[];
  };
  descriptionPlain?: string | null;
  additionalPlain?: string | null;
  openingPlain?: string | null;
}

function parse(input: string): ParsedRef | null {
  const trimmed = input.trim();
  const m = PREFIX_RE.exec(trimmed) ?? URL_RE.exec(trimmed);
  if (!m || !m[1]) return null;
  const ident = m[1].toLowerCase();
  return { kind: "lever", ident, label: ident };
}

function toPosting(p: LeverPosting, slug: string): FetchedPosting {
  const description =
    [p.openingPlain, p.descriptionPlain, p.additionalPlain]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join("\n\n") || null;

  return {
    externalId: p.id,
    title: p.text,
    // Lever postings carry no company name at all -- the board slug is the
    // only identifier we have, same as what the caller used to /watch it.
    company: slug,
    location: p.categories?.location ?? p.country ?? null,
    remote: p.workplaceType ? p.workplaceType === "remote" : null,
    department: p.categories?.department ?? p.categories?.team ?? null,
    url: p.hostedUrl,
    // createdAt is epoch milliseconds, not an ISO string -- must convert.
    postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    closesAt: null, // Lever has no deadline field on the postings API.
    description,
  };
}

async function fetchBoard(ident: string, etag: string | null): Promise<FetchResult> {
  const url = `https://api.lever.co/v0/postings/${ident}?mode=json`;
  const { body, etag: newEtag } = await getJson(url, etag);
  if (body === null) return { postings: null, etag: newEtag };

  // An unknown or typo'd slug answers HTTP 200 with
  // `{"ok":false,"error":"Document not found"}` rather than a 404. Without
  // this check /watch would happily register a board that silently returns
  // nothing forever, and every posting Lever ever had would read as closed.
  if (!Array.isArray(body)) {
    const err = (body as { error?: string })?.error ?? "unexpected response shape";
    throw new Error(`lever board ${ident} error: ${err}`);
  }

  const postings = (body as LeverPosting[]).map((p) => toPosting(p, ident));
  return { postings, etag: newEtag };
}

export const lever: Adapter = {
  kind: "lever",
  parse,
  fetch: fetchBoard,
};
