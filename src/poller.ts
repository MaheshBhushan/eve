import type { DatabaseSync } from "node:sqlite";
import { loadConfig, type Config } from "./config.ts";
import {
  closePosting,
  getFilterHash,
  getPosting,
  listPostingsForSource,
  listSources,
  listUnscoredPostings,
  markPollFailed,
  markPolled,
  openDb,
  setFilterHash,
  setFit,
  touchPosting,
  upsertPosting,
} from "./db.ts";
import { diffSnapshot } from "./diff.ts";
import {
  applyFilter,
  filterHash,
  loadFilters,
  specFor,
  type FilterConfig,
} from "./filter.ts";
import {
  emitClosure,
  emitDiffEvents,
  emitHighFit,
  sweepDeadlines,
  sweepStale,
} from "./events.ts";
import { scoreFit } from "./fit.ts";
import { adapterFor } from "./sources/registry.ts";
import type { Adapter } from "./sources/index.ts";
import type { SourceRow } from "./types.ts";

/**
 * One poll cycle, start to finish.
 *
 * This process never talks to Discord. It writes rows and queues events; the
 * bot drains the queue later. That split is what makes a gateway outage cost
 * delay instead of data -- and it means everything below can be reasoned about
 * as pure database work.
 *
 * The asymmetry to keep in mind throughout: a job board serves a snapshot, not
 * a delta, so the most valuable event here is carried by an *absence*. That
 * makes a truncated fetch actively dangerous rather than merely lossy, and most
 * of the defensive code in this file exists for that one reason.
 */

export interface PollReport {
  source: string;
  /** Board honoured our ETag; nothing to do. */
  notModified: boolean;
  /** Muted (too many consecutive failures) or refused by the delist guard. */
  skipped: boolean;
  seen: number;
  /** Postings dropped by the source's filter spec before the diff ran. */
  filtered: number;
  /**
   * The filter spec changed since the last poll, so this cycle re-baselined:
   * rows refreshed, nothing closed, no closure events. See `pollSource`.
   */
  rebaselined: boolean;
  opened: number;
  updated: number;
  closed: number;
  error: string | null;
}

/**
 * A board below this many open postings is too small for a ratio to mean
 * anything: losing 2 of 3 is a Tuesday, not a catastrophe, and refusing those
 * cycles would leave tiny boards permanently unable to close anything.
 */
const MIN_BOARD_FOR_GUARD = 4;

/**
 * Poll one source.
 *
 * `adapter` is injectable purely so tests can drive a cycle against an
 * in-memory board with no network. Production never passes it: the default
 * resolves the real adapter from the source's kind, so the call site in
 * `runCycle` reads exactly as if the parameter didn't exist.
 */
export async function pollSource(
  db: DatabaseSync,
  cfg: Config,
  source: SourceRow,
  adapter: Adapter = adapterFor(source.kind),
  /**
   * Injected by `runCycle` so one malformed filter file fails the process once
   * instead of being caught per-source and logged as N board failures. The
   * default keeps a standalone `pollSource` call honest.
   */
  filters: FilterConfig = loadFilters(cfg.filtersPath),
): Promise<PollReport> {
  const report: PollReport = {
    source: source.label,
    notModified: false,
    skipped: false,
    seen: 0,
    filtered: 0,
    rebaselined: false,
    opened: 0,
    updated: 0,
    closed: 0,
    error: null,
  };

  // Companies really do delete their job boards. Retrying a dead one on every
  // timer firing forever is just log noise, so a source that has failed this
  // many times in a row goes quiet until someone re-adds it.
  if (source.fail_count >= cfg.maxFailures) {
    report.skipped = true;
    return report;
  }

  const { postings, etag } = await adapter.fetch(source.ident, source.etag);

  // 304: the board is telling us nothing changed. Believing it is safe in a way
  // that believing a short 200 is not.
  if (postings === null) {
    markPolled(db, source.id, etag);
    report.notModified = true;
    return report;
  }

  // Filter before the diff, not after.
  //
  // Placement here is load-bearing in three separate ways, and all three are
  // reasons *not* to move it later:
  //
  //  1. A filtered-out posting is never stored at all. It costs no row, and --
  //     because the fit scorer only ever looks at stored rows -- no LLM call.
  //     That is the whole point on a query-shaped board: the scoring budget is
  //     a spend cap, and it should be spent on postings that could matter.
  //  2. The mass-delist guard's arithmetic below runs on the filtered counts, so
  //     it measures movement on the *watched* board rather than churn among
  //     postings we deliberately ignore. Guarding on unfiltered totals would
  //     make the ratio meaningless: a board could swap out 90% of its irrelevant
  //     postings without a single watched one moving.
  //  3. It also means absence from this list -- the thing this system reads as a
  //     closure -- now depends on the filter as well as the board. Hence the
  //     re-baseline rule immediately below.
  const spec = specFor(filters, source.kind, source.ident);
  const filteredPostings = applyFilter(postings, spec);
  report.filtered = postings.length - filteredPostings.length;

  /*
   * The re-baseline rule.
   *
   * Filters run before the diff, so the filter is part of this system's notion
   * of what exists. Change the filter and the meaning of "present in the
   * snapshot" changes underneath a set difference that was computed against the
   * old meaning -- and the two ways that goes wrong are both bad:
   *
   *   Tightening (drop a city, add a titleNone) makes live, still-open postings
   *   vanish from the snapshot. The diff cannot tell that from a company closing
   *   them, so it would mass-close them: claims wiped, and a
   *   `vanished_while_claimed` ping fired at someone mid-application about a job
   *   that is still perfectly open. That is the loudest false alarm this
   *   codebase can produce, and no later cycle can unsend it.
   *
   *   Widening (add a city, add a role word) makes hundreds of long-open
   *   postings appear as brand new, flooding the channel and burning the fit
   *   budget on a back catalogue.
   *
   * So the first cycle under a new spec is a re-baseline: upsert everything
   * present, close nothing, emit no closure events, store the new hash. It
   * re-establishes what "present" means without ever reading an absence. A NULL
   * stored hash -- a source that predates filtering, or one just added -- is a
   * change too, and re-baselines on first sight for exactly the same reason.
   *
   * The cost is precise and small: genuine closures that happened during this
   * one cycle are not reported. They are not lost, just quiet -- the postings
   * are still absent next cycle, which closes them normally. One delayed batch
   * of closures against a channel full of false ones is not a close call.
   */
  const hash = filterHash(spec);
  const storedHash = getFilterHash(db, source.id);
  const rebaseline = storedHash !== hash;
  report.rebaselined = rebaseline;
  if (rebaseline) {
    console.log(
      `[poll] ${source.label}: filter ${storedHash ?? "(none)"} -> ${hash} -- ` +
        `re-baselining, ${filteredPostings.length}/${postings.length} postings kept, ` +
        `nothing will be closed this cycle`,
    );
  }

  const stored = listPostingsForSource(db, source.id);
  const { present, vanished } = diffSnapshot(stored, filteredPostings);
  report.seen = present.length;

  // Adapters that cannot see the whole board. See the guard below and the
  // closure step for what changes.
  const complete = adapter.complete !== false;

  // The guard is moot on a re-baseline cycle: it exists to stop a truncated
  // fetch from being read as a mass delisting, and a re-baseline cycle closes
  // nothing regardless, so there is no closure to protect. Worse, running it
  // would *refuse* the cycle -- a deliberate tightening looks exactly like a
  // mass delisting by design -- leaving the old hash stored and re-refusing
  // forever, which would mute the source after `maxFailures` for the crime of
  // having its filter edited.
  if (
    !rebaseline &&
    complete &&
    !acceptSnapshot(cfg, source, stored, filteredPostings.length, vanished.length)
  ) {
    markPollFailed(db, source.id);
    report.skipped = true;
    report.error = "refused: mass delist guard";
    return report;
  }

  for (const p of present) {
    const f = p.fetched;
    // `posted_at_exact` is the flag the freshness alert hangs off, and getting
    // it wrong is not a cosmetic error. When a board states no date we have to
    // substitute something, and the only thing available is our own clock --
    // which, on the first poll of a newly watched board, is *now* for every
    // posting on it, including the ones open since last year. Recording that
    // the date is a substitution is what stops that first poll from announcing
    // an entire back catalogue as breaking news.
    const exact = Boolean(f.postedAt);
    const postedAt = f.postedAt ?? p.stored?.posted_at ?? nowUtc();

    const id = upsertPosting(db, {
      source_id: source.id,
      key: p.key,
      external_id: f.externalId,
      title: f.title,
      company: f.company,
      location: f.location,
      remote: f.remote === null ? null : f.remote ? 1 : 0,
      department: f.department,
      url: f.url,
      posted_at: postedAt,
      posted_at_exact: exact ? 1 : 0,
      closes_at: f.closesAt,
      description: f.description,
    });

    if (p.diffs.length === 0) {
      // Still listed, still identical. Prove it is alive and say nothing --
      // this is the overwhelming majority of every cycle.
      touchPosting(db, id);
      continue;
    }
    emitDiffEvents(
      db,
      source.id,
      id,
      p.diffs,
      { postedAt, exact: exact ? 1 : 0 },
      { freshPingHours: cfg.freshPingHours, alertMaxAgeHours: cfg.alertMaxAgeHours },
    );
    for (const d of p.diffs) {
      if (d.kind === "updated") report.updated++;
      else report.opened++;
    }
  }

  if (rebaseline) {
    // Absences this cycle mean "stopped matching the new filter" at least as
    // plausibly as "closed", and there is no way to tell the two apart. So they
    // are left open and untouched, and the new hash is stored now that the rows
    // reflect it -- the next cycle diffs like for like and closes normally.
    if (vanished.length) {
      console.log(
        `[poll] ${source.label}: ${vanished.length} absent under the new filter, ` +
          `left open (re-baseline)`,
      );
    }
  } else if (complete) {
    // The absence IS the close event -- nothing arrives from a board to say a
    // req ended. Order matters: emitClosure reads the row to decide whether the
    // closure is an alert or a quiet note, so it runs before we mark it closed.
    for (const row of vanished) {
      emitClosure(db, source.id, row);
      closePosting(db, row.id);
      report.closed++;
    }
  } else if (vanished.length) {
    // An incomplete adapter (the scraped search source) cannot support this
    // inference at all, and the difference is not one of degree. Its pages are
    // ranked, capped and reshuffled between fetches, with promoted rows spliced
    // in -- so a posting missing from today's results is overwhelmingly likely
    // to have simply fallen off page one. Closing it would mark a live job dead
    // and fire a `vanished_while_claimed` ping at someone who is still mid
    // application, which is the loudest false alarm this system can produce.
    // The mass-delist guard is moot here for the same reason: absence carries
    // no meaning to guard against.
    console.log(
      `[poll] ${source.label}: ${vanished.length} absent, ignored (incomplete source)`,
    );
  }

  // Last, and only on a cycle that ran to completion: every early return above
  // leaves the old hash in place, so a refused or failed cycle re-baselines on
  // the next attempt rather than skipping it.
  if (rebaseline) setFilterHash(db, source.id, hash);
  markPolled(db, source.id, etag);
  return report;
}

/**
 * The mass-delist guard. This is the most important thing in the file.
 *
 * A board that errors out halfway through pagination returns a short list. A
 * renamed slug that now resolves to an empty board returns a shorter one. Both
 * are, at the level of the data, completely indistinguishable from a company
 * closing every req it has in a single afternoon -- and the innocent reading is
 * enormously more likely than the catastrophic one. Acting on it would close
 * every posting on the board at once, wiping the claims and destroying the
 * alerts this system exists to raise, and no later cycle can undo an alert that
 * has already been sent.
 *
 * So the trade is deliberately lopsided: refuse the entire cycle, change no
 * rows, count a failure, and wait for the next timer firing. The cost of being
 * wrong is one delayed batch of closures. The cost of the other error is
 * everything.
 *
 * A genuine mass delisting is not lost either -- it simply has to survive
 * `maxFailures` consecutive cycles before the source mutes itself and asks for
 * a human, which is the correct amount of attention for a board that vanished.
 */
function acceptSnapshot(
  cfg: Config,
  source: SourceRow,
  stored: Array<{ state: string }>,
  snapshotSize: number,
  vanishedCount: number,
): boolean {
  const openBefore = stored.filter((r) => r.state === "open").length;
  if (openBefore === 0) return true;

  // Nothing at all, against a board that had postings yesterday. Treated as a
  // failed fetch on its own, without reference to the ratio: an empty list is
  // what every broken adapter returns, and it is the single most suspicious
  // response a live board can give.
  if (snapshotSize === 0) {
    console.error(
      `[poll] ${source.label}: empty snapshot against ${openBefore} open postings -- refusing cycle`,
    );
    return false;
  }

  if (openBefore < MIN_BOARD_FOR_GUARD) return true;

  const ratio = vanishedCount / openBefore;
  if (ratio > cfg.massDelistRatio) {
    console.error(
      `[poll] ${source.label}: ${vanishedCount}/${openBefore} open postings vanished ` +
        `(${(ratio * 100).toFixed(0)}% > ${(cfg.massDelistRatio * 100).toFixed(0)}%) -- ` +
        `refusing cycle, no rows changed`,
    );
    return false;
  }
  return true;
}

/* ---------------------------------------------------------------- cycle --- */

export async function runCycle(
  db: DatabaseSync,
  cfg: Config,
  /** Same injection point as `pollSource`; production uses the default. */
  resolve: (source: SourceRow) => Adapter = (s) => adapterFor(s.kind),
): Promise<PollReport[]> {
  const reports: PollReport[] = [];

  // Once per cycle, outside the try/catch: a malformed filter file is a config
  // error for the whole run, and it should fail the process loudly rather than
  // be swallowed N times as N separate board failures.
  const filters = loadFilters(cfg.filtersPath);

  for (const source of listSources(db)) {
    try {
      reports.push(await pollSource(db, cfg, source, resolve(source), filters));
    } catch (e) {
      // One board being down, renamed or serving garbage must not cost the
      // other boards their cycle -- they are independent, and the failure is
      // already recorded where it can mute this source on its own.
      const count = markPollFailed(db, source.id);
      console.error(`[poll] ${source.label} failed (${count} in a row):`, e);
      reports.push({
        source: source.label,
        notModified: false,
        skipped: false,
        seen: 0,
        filtered: 0,
        rebaselined: false,
        opened: 0,
        updated: 0,
        closed: 0,
        error: String(e),
      });
    }
  }

  const scored = await scoreCycle(db, cfg);
  const stale = sweepStale(db, cfg.staleDays);
  const deadlines = sweepDeadlines(db, cfg.deadlineDays);

  const totals = reports.reduce(
    (a, r) => ({
      opened: a.opened + r.opened,
      updated: a.updated + r.updated,
      closed: a.closed + r.closed,
      filtered: a.filtered + r.filtered,
    }),
    { opened: 0, updated: 0, closed: 0, filtered: 0 },
  );
  console.log(
    `[poll] ${reports.length} sources: ${totals.opened} opened, ${totals.updated} updated, ` +
      `${totals.closed} closed, ${totals.filtered} filtered out, ${scored} scored, ` +
      `${stale} stale, ${deadlines} deadline`,
  );
  return reports;
}

/**
 * Score whatever is still unscored, newest first, up to the budget.
 *
 * Deliberately after the fetch loop rather than inside it. Scoring is the only
 * expensive thing in a cycle and the budget is a spend cap, so running it
 * per-source would hand the whole allowance to whichever board happens to sort
 * first and starve the last board of the list every single cycle -- forever,
 * since the ordering is stable.
 */
async function scoreCycle(db: DatabaseSync, cfg: Config): Promise<number> {
  if (!cfg.profilePath) return 0;

  let scored = 0;
  for (const posting of listUnscoredPostings(db, cfg.fitBudget)) {
    const fit = await scoreFit(posting, cfg.profilePath, cfg.fitModel);
    // Null is "unscored", not "failed": the posting stays tracked and simply
    // carries no number. The next cycle will pick it up again.
    if (!fit) continue;

    setFit(db, posting.id, fit.score, fit.reason);
    scored++;

    // Re-read rather than reusing `posting`: emitHighFit puts fit_reason into
    // the event payload, and the row in hand predates the setFit above.
    const fresh = getPosting(db, posting.id);
    if (fresh) {
      emitHighFit(db, fresh.source_id, fresh, fit.score, cfg.fitThreshold, cfg.freshHours);
    }
  }
  return scored;
}

/** SQLite's own `datetime('now')` format, so stored dates all compare as text. */
function nowUtc(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

if (import.meta.filename === process.argv[1]) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  await runCycle(db, cfg);
  db.close();
}
