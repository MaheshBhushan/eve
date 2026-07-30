/**
 * Scraped job-search adapter: LinkedIn, Indeed, StepStone.
 *
 * ============================ READ THIS FIRST ============================
 * THIS ADAPTER IS NOT A SNAPSHOT SOURCE. `browser.complete === false`.
 *
 * Every other adapter answers "what is open on this board right now?" with a
 * complete list, which is what lets the poller treat an absence as a closure.
 * A scraped search cannot answer that question at all. It returns a *ranked,
 * paginated, personalised* slice: page 1 for "machine learning engineer@Berlin"
 * is whatever the site felt like ranking highest this minute. A posting can
 * drop off it because it got outranked, because the site A/B-tested the
 * ranker, or because a cookie banner ate three results — none of which mean
 * the job closed.
 *
 * We could have chased completeness (option (a): page until exhaustion, throw
 * otherwise). We deliberately did not. These sites cap search pagination in the
 * hundreds of results, deduplicate and re-rank between pages, and inject
 * "promoted" rows, so "I reached the last page" is not evidence that the set is
 * complete — it is only evidence that the site stopped talking. An adapter that
 * *claimed* completeness on that basis would be lying in the one place the
 * system cannot tolerate a lie: it would close every posting that fell off the
 * results, silently destroying claims and firing false
 * "vanished_while_claimed" alerts for jobs that are still open.
 *
 * So this adapter declares itself partial and the burden moves to the poller:
 *
 *   THE POLLER MUST CHECK `adapter.complete === false` AND, WHEN IT IS FALSE,
 *   NEVER INFER CLOSURE FROM ABSENCE. Postings from a partial source are
 *   upserted and refreshed on every poll; they are never transitioned to
 *   "closed", never emit posting_closed, and never emit vanished_while_claimed.
 *   They still work fully for the alerts that only need presence: new posting,
 *   high_fit, deadline, repost. Ageing them out, if ever wanted, needs an
 *   explicit last_seen rule — not the snapshot diff.
 *
 * The `Adapter` interface is shared with the ATS adapters and is not changed
 * here; `complete` rides on the exported object as an extra readonly property.
 * =========================================================================
 *
 * RISK / LEGAL. Scraping LinkedIn, Indeed and StepStone very likely violates
 * their terms of service. A driven browser signed into your own account can get
 * that account rate-limited, challenged, or permanently flagged. Use it on an
 * account you can afford to lose, and keep the poll interval slow.
 *
 * There are deliberately NO evasion techniques here: no proxy rotation, no
 * fingerprint spoofing, no CAPTCHA solving. If a site blocks the agent, the
 * correct behaviour is to fail loudly so the poller's failure counter mutes the
 * source. Working around a block is both the site telling us to stop and the
 * point at which this stops being a scraper and starts being an attack.
 *
 * OPT-IN. Unconfigured, this adapter parses references but refuses to fetch.
 * It only runs once RADAR_BROWSER_USE_DIR points at a browser-use checkout.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, FetchResult, ParsedRef } from "./index.ts";
import type { FetchedPosting } from "../types.ts";
import { loadConfig } from "../config.ts";

/** Sites we know how to drive. The prefix doubles as the canonical site key. */
const SITES = ["linkedin", "indeed", "stepstone"] as const;
type Site = (typeof SITES)[number];

/** Hostname substring -> site key, for the URL form of a reference. */
const HOSTS: Array<[string, Site]> = [
  ["linkedin.", "linkedin"],
  ["indeed.", "indeed"],
  ["stepstone.", "stepstone"],
];

/**
 * Query/location parameter names per site, in priority order. Each site has
 * several spellings in the wild (mobile vs desktop vs localised domains), and
 * a pasted URL may carry any of them.
 */
const QUERY_PARAMS = ["keywords", "q", "what", "ke", "text"];
const LOCATION_PARAMS = ["location", "l", "where", "ws", "geoLocation"];

/** How many results the Python side is asked to collect per search. */
const RESULT_LIMIT = 50;

/**
 * Canonical form of one free-text field.
 *
 * `ident` is the uniqueness key for a watched source in SQLite, so "Machine
 * Learning Engineer" typed by one person and "machine  learning engineer"
 * pasted from a URL by another must collapse to the same row — otherwise the
 * same search gets polled twice and every posting is duplicated. NFKC first so
 * full-width and composed characters normalise; then case-fold, then collapse
 * whitespace (including the `+` and `%20` a URL brings along).
 */
function canon(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[+_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Locationless searches are legitimate ("remote anywhere"); name them. */
const ANY_LOCATION = "anywhere";

function makeIdent(site: Site, query: string, location: string): string {
  const q = canon(query);
  const l = canon(location) || ANY_LOCATION;
  return `${site}:${q}@${l}`;
}

/** Inverse of `makeIdent`. Throws on garbage: idents come from our own DB. */
export function splitIdent(ident: string): {
  site: Site;
  query: string;
  location: string;
} {
  const colon = ident.indexOf(":");
  const at = ident.lastIndexOf("@");
  const site = ident.slice(0, colon) as Site;
  if (colon < 0 || at < colon || !SITES.includes(site)) {
    throw new Error(`not a browser-search ident: ${ident}`);
  }
  return {
    site,
    query: ident.slice(colon + 1, at),
    location: ident.slice(at + 1),
  };
}

function label(site: Site, query: string, location: string): string {
  const l = canon(location);
  return `${site}: ${canon(query)}${l ? ` @ ${l}` : ""}`;
}

/** `linkedin:machine learning engineer@Berlin` and friends. */
function parsePrefixed(input: string): ParsedRef | null {
  const m = /^(linkedin|indeed|stepstone)\s*:\s*(.+)$/i.exec(input);
  if (!m) return null;
  const site = m[1]!.toLowerCase() as Site;
  const rest = m[2]!;
  // Split on the LAST `@` -- job titles rarely contain one, locations never do.
  const at = rest.lastIndexOf("@");
  const query = at >= 0 ? rest.slice(0, at) : rest;
  const location = at >= 0 ? rest.slice(at + 1) : "";
  if (!canon(query)) return null;
  return {
    kind: "browser",
    ident: makeIdent(site, query, location),
    label: label(site, query, location),
  };
}

/** A pasted search-results URL from one of the three sites. */
function parseUrl(input: string): ParsedRef | null {
  if (!/^https?:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const hit = HOSTS.find(([needle]) => host.includes(needle));
  if (!hit) return null;
  const site = hit[1];

  const pick = (names: string[]) => {
    for (const n of names) {
      const v = url.searchParams.get(n);
      if (v && v.trim()) return v;
    }
    return "";
  };
  const query = pick(QUERY_PARAMS);
  // A site URL with no query at all isn't a search -- it's a browse page or a
  // single posting, and we have no search to repeat. Decline it.
  if (!canon(query)) return null;
  const location = pick(LOCATION_PARAMS);
  return {
    kind: "browser",
    ident: makeIdent(site, query, location),
    label: label(site, query, location),
  };
}

/* ------------------------------------------------ python subprocess --- */

const SCRIPT = fileURLToPath(new URL("../../scripts/board_search.py", import.meta.url));

/** The slice of Config this adapter needs; kept narrow so tests can fake it. */
export interface BrowserEnv {
  browserUseDir: string | null;
  browserUsePython: string;
  browserTimeoutMin: number;
}

/**
 * Resolve the interpreter and checkout, or explain exactly what to configure.
 *
 * browser-use is a heavy Python dependency with a Playwright browser behind it;
 * there is no sane default, and a vague "browser search failed" here costs an
 * afternoon of debugging. So the two failure modes each name their env var.
 */
export function resolveRunner(env: BrowserEnv): { python: string; dir: string } {
  if (!env.browserUseDir) {
    throw new Error(
      "browser adapter is not configured: set RADAR_BROWSER_USE_DIR to a " +
        "browser-use checkout (e.g. /path/to/browser-use) and " +
        "RADAR_BROWSER_USE_PYTHON to a Python interpreter that has browser-use " +
        "and its Playwright browsers installed.",
    );
  }
  if (!existsSync(env.browserUseDir)) {
    throw new Error(
      `RADAR_BROWSER_USE_DIR points at ${env.browserUseDir}, which does not exist.`,
    );
  }
  const python = env.browserUsePython;
  // An absolute path we can check now; a bare name (`python3`) we can only
  // check by running it, and spawn's ENOENT already says so clearly.
  if (path.isAbsolute(python) && !existsSync(python)) {
    throw new Error(
      `RADAR_BROWSER_USE_PYTHON points at ${python}, which does not exist. ` +
        "The browser-use checkout ships no virtualenv of its own -- create one " +
        "(python3 -m venv .venv && .venv/bin/pip install browser-use && " +
        ".venv/bin/playwright install chromium) and point this at its python.",
    );
  }
  return { python, dir: env.browserUseDir };
}

function isIsoOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

/**
 * Parse and validate the Python script's stdout.
 *
 * Exported for tests, and separate from the spawn so the validation is
 * exercised without a browser. An LLM-driven extractor is exactly the kind of
 * producer that will one day emit prose, a truncated array, or a posting with a
 * hallucinated URL; every one of those must become a thrown Error the poller
 * counts as a failure, never a half-populated posting written to the DB.
 */
export function parsePostings(stdout: string): FetchedPosting[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("board_search.py produced no output");

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `board_search.py did not print JSON: ${trimmed.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error("board_search.py output is not a JSON array");
  }

  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`board_search.py result ${i} is not an object`);
    }
    const r = item as Record<string, unknown>;
    const str = (k: string): string => {
      const v = r[k];
      if (typeof v !== "string" || !v.trim()) {
        throw new Error(`board_search.py result ${i}: missing ${k}`);
      }
      return v.trim();
    };
    const optStr = (k: string): string | null => {
      const v = r[k];
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") {
        throw new Error(`board_search.py result ${i}: ${k} is not a string`);
      }
      return v.trim() || null;
    };

    const url = str("url");
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`board_search.py result ${i}: url is not http(s): ${url}`);
    }
    const postedAt = r["postedAt"] ?? null;
    if (!isIsoOrNull(postedAt)) {
      throw new Error(
        `board_search.py result ${i}: postedAt is neither null nor a date`,
      );
    }
    const remote = r["remote"] ?? null;
    if (remote !== null && typeof remote !== "boolean") {
      throw new Error(`board_search.py result ${i}: remote is not a boolean`);
    }

    return {
      externalId: str("externalId"),
      title: str("title"),
      company: str("company"),
      location: optStr("location"),
      remote,
      department: optStr("department"),
      url,
      // null here is load-bearing: it tells the poller the site never stated a
      // publish date, so posting_at_exact stays 0 and the freshness alert --
      // which only trusts stated dates -- stays quiet rather than pinging on a
      // guess.
      postedAt: postedAt === null ? null : new Date(postedAt).toISOString(),
      closesAt: null,
      description: optStr("description"),
    } satisfies FetchedPosting;
  });
}

/**
 * Run the Python searcher under a hard timeout.
 *
 * A browser agent can wedge on a CAPTCHA, an infinite-scroll page or a login
 * wall and simply never return. That must not stall the poll cycle, so the
 * child is killed on the config's deadline and the kill is escalated to SIGKILL
 * -- a hung Chromium ignores SIGTERM often enough to matter.
 */
function runScript(args: string[], env: BrowserEnv): Promise<string> {
  const { python, dir } = resolveRunner(env);
  const timeoutMs = Math.max(1, env.browserTimeoutMin) * 60_000;

  return new Promise((resolve, reject) => {
    const child = spawn(python, [SCRIPT, ...args], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: dir, PYTHONUNBUFFERED: "1" },
    });

    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    // stderr is the agent's log stream; keep only the tail for the error text.
    child.stderr.on("data", (d: string) => (err = (err + d).slice(-4000)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not run ${python}: ${e.message}. Set RADAR_BROWSER_USE_PYTHON ` +
            "to an interpreter with browser-use installed.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `browser search exceeded ${env.browserTimeoutMin} min and was killed`,
          ),
        );
      } else if (code !== 0) {
        reject(
          new Error(
            `board_search.py exited ${code}: ${err.trim().slice(-600) || "(no stderr)"}`,
          ),
        );
      } else {
        resolve(out);
      }
    });
  });
}

export const browser: Adapter & { readonly complete: false } = {
  kind: "browser",

  /**
   * Partiality flag, read by the poller. See the header: absence of a posting
   * from this adapter's result means "not on the page we saw", NOT "closed".
   */
  complete: false,

  parse(input: string): ParsedRef | null {
    const s = input.trim();
    if (!s) return null;
    try {
      return parseUrl(s) ?? parsePrefixed(s);
    } catch {
      // parse() is on the /watch path; an unparseable argument must read as
      // "no adapter matched", never as a stack trace in the channel.
      return null;
    }
  },

  async fetch(ident: string, etag: string | null): Promise<FetchResult> {
    const { site, query, location } = splitIdent(ident);
    const cfg = loadConfig();
    const out = await runScript(
      [
        "--site",
        site,
        "--query",
        query,
        "--location",
        location === ANY_LOCATION ? "" : location,
        "--limit",
        String(RESULT_LIMIT),
      ],
      cfg,
    );
    // No ETag exists for a scraped page, and we must not invent one: an etag
    // would let the poller skip a cycle, and this source is already the least
    // trustworthy one we have.
    return { postings: parsePostings(out), etag: null };
  },
};
