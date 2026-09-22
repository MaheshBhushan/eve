import { stripHtml } from "./sources/index.ts";
import type { PostingRow } from "./types.ts";

/** Only request known public job hosts; never arbitrary model-provided URLs. */
const allowed = /(^|\.)(linkedin\.com|stepstone\.de|xing\.com|indeed\.com|indeed\.de)$/;
export function jobDescription(html: string): string | null {
  for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const find = (v: unknown): string | null => {
        if (Array.isArray(v)) return v.map(find).find(Boolean) ?? null;
        if (!v || typeof v !== "object") return null;
        const obj = v as Record<string, unknown>;
        if ((obj['@type'] === 'JobPosting' || (Array.isArray(obj['@type']) && obj['@type'].includes('JobPosting'))) && typeof obj.description === "string") return stripHtml(obj.description);
        return find(obj['@graph']);
      };
      const found = find(JSON.parse(script[1]!));
      if (found) return found;
    } catch { /* A page can carry unrelated malformed structured data. */ }
  }
  const linkedin = html.match(/<div[^>]*class=["'][^"']*show-more-less-html__markup[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return linkedin ? stripHtml(linkedin[1]) : null;
}
export async function enrichDescription(posting: PostingRow, request: typeof fetch = fetch): Promise<string | null> {
  try {
    let url = new URL(posting.url);
    if (url.hostname.endsWith("linkedin.com") && /^\d+$/.test(posting.external_id)) {
      url = new URL(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${posting.external_id}`);
    }
    for (let redirects = 0; redirects < 4; redirects++) {
      if (url.protocol !== "https:" || !allowed.test(url.hostname) || url.port || url.username || url.password) return null;
      const response = await request(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: {"user-agent": "eve", accept: "text/html"} });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return null;
        url = new URL(location, url); continue;
      }
      if (!response.ok) { await response.body?.cancel(); return null; }
      // Bound the downloaded page as well as the extracted model input.
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      return jobDescription(Buffer.concat(chunks).toString("utf8"));
    }
  } catch { /* A blocked or missing page remains unscored. */ }
  return null;
}
