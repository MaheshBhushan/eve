import type { Adapter } from "./index.ts";
import { stripHtml } from "./index.ts";
import type { FetchedPosting } from "../types.ts";

/** Unfiltered remote feed with full descriptions; source credit and original URLs are retained. */
export const remotive: Adapter = {
  kind: "remotive",
  minPollIntervalMs: 6 * 60 * 60 * 1000,
  domain: () => "remotive.com",
  parse(input) {
    return /^(?:remotive:all|https:\/\/remotive\.com\/api\/remote-jobs\/?|https:\/\/remotive\.com\/?)$/i.test(input)
      ? {kind: "remotive", ident: "all", label: "Remotive · worldwide remote jobs"} : null;
  },
  async fetch() {
    const response = await fetch("https://remotive.com/api/remote-jobs", {signal: AbortSignal.timeout(30_000), headers: {accept: "application/json", "user-agent": "eve"}});
    if (!response.ok) throw new Error(`Remotive HTTP ${response.status}`);
    return {postings: parseRemotive(await response.json()), etag: null};
  },
};
export function parseRemotive(raw: unknown): FetchedPosting[] {
  const body = raw as {jobs?: unknown[]; "job-count"?: number} | null;
  if (!body || !Array.isArray(body.jobs) || body['job-count'] !== body.jobs.length) throw new Error("Incomplete Remotive feed");
  return body.jobs.map(value => {
    const p = value as Record<string, unknown> | null;
    if (!p || (typeof p.id !== "number" && typeof p.id !== "string") || typeof p.title !== "string" || typeof p.company_name !== "string" || typeof p.url !== "string" || !p.url.startsWith("https://remotive.com/")) throw new Error("Invalid Remotive posting");
    const date = typeof p.publication_date === "string" ? p.publication_date : null;
    return {externalId: String(p.id), title: p.title, company: p.company_name, url: p.url,
      location: typeof p.candidate_required_location === "string" ? p.candidate_required_location : null,
      remote: true, department: typeof p.category === "string" ? p.category : null,
      postedAt: date && Number.isFinite(Date.parse(date)) ? date : null, closesAt: null,
      description: stripHtml(typeof p.description === "string" ? p.description : null)};
  });
}
