import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FetchedPosting } from "./types.ts";

/**
 * Config-driven snapshot filtering.
 *
 * This exists because the boards this system watches are not curated for us.
 * A Personio or Arbeitsagentur query can hand back tens of thousands of
 * postings, and the owner cares about a few dozen -- so the snapshot has to be
 * narrowed before anything else touches it. Filtering happens *before* the
 * diff, which is the whole reason this module is careful: absence from the
 * (filtered) snapshot is how the poller infers closure, so the filter is not a
 * display preference, it is part of the system's notion of what exists. See
 * the re-baseline rule in poller.ts for the consequence.
 *
 * Nothing here is German-specific. The vocabulary lives entirely in JSON
 * (config/filters.example.json ships the Werkstudent/Praktikum default), so
 * changing target roles, cities or countries is an edit to a config file, never
 * a code change. That generality is the requirement; the German setup is just
 * what it ships with.
 */

export interface FilterSpec {
  /** Posting matches if its title contains ANY of these. Empty/absent = no title requirement. */
  titleAny?: string[];
  /** Rejected if its title contains ANY of these. Applied after titleAny. */
  titleNone?: string[];
  /** Matches if location contains ANY of these (cities, regions, country names). */
  locationAny?: string[];
  /** Rejected if location contains ANY of these. */
  locationNone?: string[];
  /** Matches if company contains ANY of these; absent = any company. */
  companyAny?: string[];
  companyNone?: string[];
  /** How to treat a posting the board marks remote, when locationAny is set. */
  remote?: "include" | "exclude" | "only";
  /** Reject postings whose stated publish date is older than this. Absent = no limit. */
  maxAgeDays?: number;
}

export interface FilterConfig {
  /** Applied to every source unless overridden. */
  default?: FilterSpec;
  /** Keyed by "kind:ident" (exact) or "kind:*" (whole adapter). More specific wins. */
  perSource?: Record<string, FilterSpec>;
}

/* ---------------------------------------------------------- normalising --- */

/**
 * Fold a haystack or a needle down to one comparable form.
 *
 * NFKD splits a precomposed character into base + combining marks, so stripping
 * the marks turns `München` into `Munchen` and `MÜNCHEN`/`münchen` into the same
 * string. That is a deliberately narrow promise, and the boundary deserves to be
 * stated plainly: this is diacritic folding, not transliteration and *certainly*
 * not translation.
 *
 *   `München` == `MÜNCHEN` == `münchen` == `Munchen`   (handled here)
 *   `München` != `Muenchen`                            (ue-expansion: add both to config)
 *   `München` != `Munich`                              (translation: never attempted)
 *
 * Guessing at either of the last two would be worse than not doing it. `ue` ->
 * `ü` is not reversible in German (`Neuer` is not `Nüer`), and translating place
 * names silently would make the config lie about what it matches. Both are one
 * extra array entry away for whoever writes the config, and an explicit entry is
 * legible where a hidden rule is not.
 *
 * Every non-alphanumeric run collapses to a single space, and the result is
 * padded with spaces. That gives the anchoring mechanism below word edges to
 * bite on without needing a regex, and it makes punctuation-noise like
 * `Werkstudent:in` or `Werkstudent (m/w/d)` compare as plain words.
 */
export function normalise(s: string): string {
  return ` ${s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/**
 * One config term compiled to a needle.
 *
 * Matching is plain normalised substring, not a word-boundary regex, and that is
 * the right default for the vocabulary this thing exists to match. German
 * compounds and gendered forms mean the interesting word is very often glued to
 * something else: `werkstudent` has to catch `Werkstudentin`, `Werkstudent:in`,
 * `WERKSTUDENT (m/w/d)` and `Pflichtpraktikum` has to be caught by
 * `praktikum`. A boundary-anchored match would miss most real postings.
 *
 * The cost is short English words. `intern` as a substring matches
 * `International`, `Internal` and `Internship`, and "Internal Communications
 * Manager" is not an internship -- a genuine false positive, and a common one.
 * So anchoring is opt-in per term, spelled with `|` at the edge you want pinned:
 *
 *   "intern"    -> anywhere            (matches International, Internship)
 *   "|intern|"  -> whole word only     (matches "Intern", not International)
 *   "|intern"   -> must start a word   (matches Internship, not "Winternship")
 *   "intern|"   -> must end a word     (matches "Data Intern", not Internal)
 *
 * `|` was chosen because it cannot occur in a job title and needs no escaping in
 * JSON, unlike a `\b`-style string. The tradeoff is that the default is loose:
 * a config author who writes short English stems gets recall and has to opt into
 * precision. That is the correct direction for this system -- a missed posting
 * is invisible, while a false positive is visible in the channel and gets fixed.
 */
interface Needle {
  text: string;
}

function compile(term: string): Needle | null {
  const lead = term.startsWith("|");
  const trail = term.endsWith("|");
  const core = normalise(term.replace(/^\|/, "").replace(/\|$/, "")).trim();
  if (!core) return null;
  return { text: `${lead ? " " : ""}${core}${trail ? " " : ""}` };
}

function containsAny(haystack: string | null, terms: string[] | undefined): boolean {
  if (!terms || terms.length === 0) return false;
  const hay = normalise(haystack ?? "");
  for (const term of terms) {
    const n = compile(term);
    if (n && hay.includes(n.text)) return true;
  }
  return false;
}

/** An absent or empty array is "no requirement", not "requirement nothing can meet". */
function required(terms: string[] | undefined): boolean {
  return Array.isArray(terms) && terms.length > 0;
}

/* ------------------------------------------------------------- matching --- */

const DAY_MS = 86_400_000;

export function matches(p: FetchedPosting, spec: FilterSpec): boolean {
  // titleAny first, titleNone second, so an exclusion always beats an
  // inclusion: "Senior Internal Auditor" can match `intern|` and still be
  // rejected by `senior`. Rejection winning is what makes titleNone usable as a
  // blunt instrument.
  if (required(spec.titleAny) && !containsAny(p.title, spec.titleAny)) return false;
  if (containsAny(p.title, spec.titleNone)) return false;

  if (required(spec.companyAny) && !containsAny(p.company, spec.companyAny)) return false;
  if (containsAny(p.company, spec.companyNone)) return false;

  // Remote is decided before location because it can excuse the location check
  // entirely. A fully remote German role is frequently listed as just "Remote"
  // with no city at all, so a locationAny of German cities would drop exactly
  // the postings a remote-friendly owner most wants.
  const isRemote = p.remote === true;
  if (spec.remote === "exclude" && isRemote) return false;
  if (spec.remote === "only" && !isRemote) return false;

  if (containsAny(p.location, spec.locationNone)) return false;
  if (required(spec.locationAny) && !containsAny(p.location, spec.locationAny)) {
    // `include` and `only` both mean a remote posting is wanted on its own
    // merits, so neither lets a missing city veto it. With `remote` unset the
    // location list is taken literally -- opting out of the exemption has to be
    // possible, and silence is the conservative reading.
    const exempt = isRemote && (spec.remote === "include" || spec.remote === "only");
    if (!exempt) return false;
  }

  if (spec.maxAgeDays !== undefined && p.postedAt) {
    const t = Date.parse(p.postedAt);
    // An absent -- or unparseable -- publish date is *unknown*, not old, and it
    // is not rejected. Most boards simply do not state one, and the rest of the
    // system already treats that case as unknown rather than stale (see
    // `posted_at_exact`, which exists so the freshness alert can refuse to fire
    // on a substituted date). Rejecting on absence here would silently discard
    // whole boards for a field they never publish.
    if (!Number.isNaN(t) && Date.now() - t > spec.maxAgeDays * DAY_MS) return false;
  }

  return true;
}

export function applyFilter(
  postings: FetchedPosting[],
  spec: FilterSpec,
): FetchedPosting[] {
  return postings.filter((p) => matches(p, spec));
}

/* -------------------------------------------------------------- loading --- */

const SPEC_ARRAY_FIELDS = [
  "titleAny",
  "titleNone",
  "locationAny",
  "locationNone",
  "companyAny",
  "companyNone",
] as const;

const REMOTE_MODES = new Set(["include", "exclude", "only"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateSpec(v: unknown, where: string, file: string): FilterSpec {
  if (!isObject(v)) throw bad(file, `${where} must be an object`);
  for (const field of SPEC_ARRAY_FIELDS) {
    const arr = v[field];
    if (arr === undefined) continue;
    if (!Array.isArray(arr) || arr.some((s) => typeof s !== "string")) {
      throw bad(file, `${where}.${field} must be an array of strings`);
    }
  }
  if (v.remote !== undefined && !REMOTE_MODES.has(v.remote as string)) {
    throw bad(file, `${where}.remote must be one of include | exclude | only`);
  }
  if (v.maxAgeDays !== undefined) {
    if (typeof v.maxAgeDays !== "number" || !Number.isFinite(v.maxAgeDays) || v.maxAgeDays <= 0) {
      throw bad(file, `${where}.maxAgeDays must be a positive number of days`);
    }
  }
  return v as FilterSpec;
}

function bad(file: string, problem: string): Error {
  return new Error(`invalid filter config ${file}: ${problem}`);
}

/**
 * Read the filter config, or decide there isn't one.
 *
 * The two failure modes are deliberately not symmetric. No path configured, or a
 * path that does not exist, means "no filtering" -- a legitimate setup, and the
 * one every existing deployment is already in. A file that exists but does not
 * parse or does not validate *throws*, loudly, naming the file and the problem.
 *
 * Falling back to "no filtering" on a malformed file would be the worse bug by a
 * wide margin: the poller would quietly start tracking every posting on every
 * board -- tens of thousands of rows, a Discord channel flooded past any hope of
 * reading it, and a fit-scoring budget burned on noise -- all from a stray comma
 * that nobody sees. A crash at startup is a five-minute fix. Silence is not.
 */
export function loadFilters(path: string | null): FilterConfig {
  if (!path) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read filter config ${path}: ${String(e)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw bad(path, `not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(parsed)) throw bad(path, "top level must be a JSON object");

  const cfg: FilterConfig = {};
  if (parsed.default !== undefined) {
    cfg.default = validateSpec(parsed.default, "default", path);
  }
  if (parsed.perSource !== undefined) {
    if (!isObject(parsed.perSource)) throw bad(path, "perSource must be an object");
    const per: Record<string, FilterSpec> = {};
    for (const [k, v] of Object.entries(parsed.perSource)) {
      if (!/^[^:]+:.+$/.test(k)) {
        throw bad(path, `perSource key ${JSON.stringify(k)} must look like "kind:ident" or "kind:*"`);
      }
      per[k] = validateSpec(v, `perSource[${JSON.stringify(k)}]`, path);
    }
    cfg.perSource = per;
  }
  return cfg;
}

/**
 * Resolve the spec in force for one source: `default`, then `kind:*`, then
 * `kind:ident`, each level overriding whole fields of the one before.
 *
 * Fields replace rather than concatenate, and that is the point. Merging arrays
 * would make every override a widening -- there would be no way to say "this
 * board, only Berlin" once the default listed twelve cities, and narrowing is
 * the more common thing to want. A level that omits a field inherits it
 * untouched; a level that sets it owns it. To drop an inherited list, set it to
 * `[]`, which reads as "no requirement" everywhere above.
 */
export function specFor(cfg: FilterConfig, kind: string, ident: string): FilterSpec {
  const per = cfg.perSource ?? {};
  return {
    ...(cfg.default ?? {}),
    ...(per[`${kind}:*`] ?? {}),
    ...(per[`${kind}:${ident}`] ?? {}),
  };
}

/* --------------------------------------------------------------- hashing --- */

/**
 * Fingerprint of a spec's *meaning*.
 *
 * The poller re-baselines a source whenever this changes, which makes the hash's
 * sensitivity a real design decision rather than an implementation detail. Too
 * sensitive and reformatting the JSON, sorting a list or fixing capitalisation
 * costs a needless re-baseline cycle -- a cycle that deliberately closes
 * nothing, so it also delays every genuine closure by one poll. Not sensitive
 * enough and a real narrowing slips through as a mass delisting.
 *
 * So the spec is canonicalised down to exactly what `matches` can observe before
 * being hashed: fields in fixed order, absent and empty arrays collapsed to the
 * same thing, terms normalised the same way matching normalises them (so `Berlin`
 * and ` berlin ` are one term) with anchoring pipes preserved because they *do*
 * change meaning, and each list sorted and deduplicated because an ANY-of list
 * is a set. Anything that survives that changes what gets tracked.
 */
export function filterHash(spec: FilterSpec): string {
  const canon: Record<string, unknown> = {};
  for (const field of SPEC_ARRAY_FIELDS) {
    const terms = spec[field];
    if (!required(terms)) continue;
    const set = new Set<string>();
    for (const term of terms!) {
      const n = compile(term);
      if (n) set.add(n.text);
    }
    if (set.size) canon[field] = [...set].sort();
  }
  if (spec.remote !== undefined) canon.remote = spec.remote;
  if (spec.maxAgeDays !== undefined) canon.maxAgeDays = spec.maxAgeDays;

  const ordered = Object.keys(canon)
    .sort()
    .map((k) => [k, canon[k]] as const);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 16);
}
