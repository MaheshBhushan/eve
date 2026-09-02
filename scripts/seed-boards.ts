/**
 * Batch `/watch` — register and seed many boards from a JSON file.
 *
 * Does exactly what `onWatch` in src/bot.ts does, once per entry, without
 * needing Discord: fetch, filter, register, seed silently, record the filter
 * hash. It queues no events, so seeding a hundred boards cannot flood the
 * channel; the postings simply become the baseline the next poll diffs against.
 *
 *   node scripts/seed-boards.ts [path] [--dry-run]
 *
 * Defaults to config/boards.json. `--dry-run` resolves and fetches everything
 * and reports the yield, but writes nothing — use it to check a board list, and
 * to see how many postings each source actually contributes before committing
 * to polling it every ten minutes.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addSource,
  getSource,
  openDb,
  setFilterHash,
  setSourceLabel,
  upsertPosting,
} from "../src/db.ts";
import { applyFilter, filterHash, loadFilters, specFor } from "../src/filter.ts";
import { postingKey } from "../src/key.ts";
import { adapterFor, parseRef } from "../src/sources/registry.ts";
import type { PostingUpsert } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

interface BoardEntry {
  ref: string;
  group?: string;
  note?: string;
}

/** Accepts `{ boards: [...] }`, a bare array, or an array of plain strings. */
function readBoards(path: string): BoardEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read board list at ${path}: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { boards?: unknown }).boards;
  if (!Array.isArray(list)) {
    throw new Error(`${path}: expected an array, or an object with a "boards" array`);
  }
  return list.map((e) => (typeof e === "string" ? { ref: e } : (e as BoardEntry)));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--")) ?? join(repo, "config/boards.json");

  const boards = readBoards(path);
  // Deliberately not inside the per-board try/catch: a malformed filter file is
  // a configuration error, and failing fast beats seeding everything unfiltered.
  const filters = loadFilters(process.env.RADAR_FILTERS ?? null);
  const db = openDb(process.env.RADAR_DB ?? join(repo, "eve.db"));

  console.log(
    `${dryRun ? "[dry-run] " : ""}${boards.length} board${
      boards.length === 1 ? "" : "s"
    } from ${path}\n`,
  );

  let added = 0;
  let skipped = 0;
  let failed = 0;
  let seeded = 0;

  for (const entry of boards) {
    const label = entry.ref.padEnd(40).slice(0, 40);
    const parsed = parseRef(entry.ref);
    if (!parsed) {
      console.log(`${label} SKIP  unrecognised reference`);
      failed++;
      continue;
    }

    if (!dryRun && getSource(db, parsed.kind, parsed.ident)) {
      console.log(`${label} ---   already watched`);
      skipped++;
      continue;
    }

    try {
      // Fetching before registering is the only honest existence check: several
      // boards answer a typo'd slug with HTTP 200 and an error body.
      const result = await adapterFor(parsed.kind).fetch(parsed.ident, null);
      const postings = result.postings;
      if (postings === null) throw new Error("empty response");

      const spec = specFor(filters, parsed.kind, parsed.ident);
      const kept = applyFilter(postings, spec);

      if (dryRun) {
        console.log(
          `${label} OK    ${String(postings.length).padStart(5)} total, ${String(
            kept.length,
          ).padStart(4)} matched`,
        );
        added++;
        continue;
      }

      // Searches keep the adapter's query label; only company boards take the
      // company name from their first posting (see the same rule in bot.ts).
      const isSearch = adapter.complete === false || parsed.kind === "arbeitsagentur";
      const name = isSearch ? parsed.label : postings[0]?.company || parsed.label;
      const source = addSource(db, parsed.kind, parsed.ident, name);
      if (source.label !== name) setSourceLabel(db, source.id, name);
      setFilterHash(db, source.id, filterHash(spec));

      for (const p of kept) {
        const row: PostingUpsert = {
          source_id: source.id,
          key: postingKey(p),
          external_id: p.externalId,
          title: p.title,
          company: p.company,
          location: p.location,
          remote: p.remote === null ? null : p.remote ? 1 : 0,
          department: p.department,
          url: p.url,
          // Substituting now() is safe only because posted_at_exact records that
          // we guessed; the freshness alert refuses to fire on a guessed date,
          // which is what stops a seeded back catalogue reading as breaking news.
          posted_at: p.postedAt ?? new Date().toISOString(),
          posted_at_exact: p.postedAt != null ? 1 : 0,
          closes_at: p.closesAt,
          description: p.description,
        };
        upsertPosting(db, row);
      }

      console.log(
        `${label} OK    ${String(postings.length).padStart(5)} total, ${String(
          kept.length,
        ).padStart(4)} seeded`,
      );
      added++;
      seeded += kept.length;
    } catch (e) {
      // One dead board must not abort the batch — report and carry on.
      console.log(`${label} FAIL  ${(e as Error).message.slice(0, 70)}`);
      failed++;
    }
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}${added} ok, ${skipped} already watched, ` +
      `${failed} failed${dryRun ? "" : `, ${seeded} postings seeded`}`,
  );
  if (!dryRun && added > 0) {
    console.log("Seeded silently — no events queued. The next poll diffs against this baseline.");
  }
}

main().catch((e) => {
  console.error(`[seed] ${(e as Error).message}`);
  process.exit(1);
});
