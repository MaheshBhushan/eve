import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { PostingRow } from "./types.ts";

/**
 * How well does this posting match the person running the bot?
 *
 * Scoring runs through the `claude` CLI in headless mode rather than an SDK.
 * The CLI is already logged in on this machine, so there is no API key to
 * provision, rotate, or bake into a systemd unit -- the poller inherits an
 * authenticated tool instead of a secret. This mirrors how the sibling
 * job-pipeline project scores postings, deliberately: same auth story, same
 * failure modes, one thing to debug.
 *
 * The profile is job-pipeline's `profile.json`, read by path and never written.
 * That project owns the file; pointing at it keeps one source of truth for
 * "who am I and what can I do" with zero code coupling between the two repos.
 */

export interface FitResult {
  score: number;
  reason: string;
}

/**
 * Hard ceiling on the child. A `claude` invocation that hangs -- a stalled
 * network read, a prompt for input that will never come -- would otherwise pin
 * the poller forever, and this process is a one-shot systemd unit with a timer
 * behind it: a hung cycle means every later cycle piles up behind it.
 */
const TIMEOUT_MS = 90_000;
/** The JD is the bulk of the prompt and boards ship enormous ones. */
const MAX_DESCRIPTION = 6_000;
/** Cap on the serialised profile so a fat resume can't crowd out the JD. */
const MAX_PROFILE = 8_000;

/**
 * Score one posting, or return null.
 *
 * Null is the whole error contract: a missing profile, a CLI that isn't
 * installed, a timeout, a model that answered in prose. Every one of those
 * degrades the posting to "unscored" -- it is still tracked, still delivered,
 * still claimable, it just carries no fit number. Scoring is a nicety layered
 * on top of the board watching; it must never be able to throw into the poll
 * cycle and take the closure detection down with it.
 */
export async function scoreFit(
  posting: PostingRow,
  profilePath: string,
  model: string,
): Promise<FitResult | null> {
  try {
    const profile = await loadProfile(profilePath);
    if (!profile) return null;
    const raw = await runClaude(buildPrompt(posting, profile), model);
    return raw ? parseResult(raw) : null;
  } catch (e) {
    console.warn(`[fit] scoring posting ${posting.id} failed:`, e);
    return null;
  }
}

/* -------------------------------------------------------------- profile --- */

/**
 * Only the capability-describing sections go into the prompt.
 *
 * `identity` is excluded on purpose and the exclusion is not cosmetic: it holds
 * a home address, a phone number and an email. None of that bears on whether
 * someone can do a job, so it can only ever be leakage -- into a model's
 * context, into a log line, into a crash dump. The rule is that the prompt
 * carries capability and eligibility, never contact details.
 */
async function loadProfile(path: string): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    console.warn(`[fit] cannot read profile at ${path}:`, e);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const p = parsed as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const section of ["resume", "work_eligibility", "application_answers"]) {
    if (p[section] !== undefined) kept[section] = p[section];
  }
  if (Object.keys(kept).length === 0) {
    console.warn(`[fit] profile at ${path} has no scorable sections`);
    return null;
  }
  return JSON.stringify(kept, null, 1).slice(0, MAX_PROFILE);
}

/* --------------------------------------------------------------- prompt --- */

/**
 * The anti-inflation instructions are the load-bearing part. Asked to rate a
 * match, a model's default is to be encouraging, and a scorer that calls
 * everything a 78 turns the high-fit ping -- one of the four alerts this whole
 * system exists to raise -- into a notification for every posting on every
 * board. So the prompt spends most of its words on what should pull a score
 * *down*, and anchors the bands explicitly.
 */
function buildPrompt(posting: PostingRow, profile: string): string {
  const jd = (posting.description ?? "").slice(0, MAX_DESCRIPTION);
  return `You are screening a job posting on behalf of the candidate described below. Score how well the candidate matches THIS posting.

CANDIDATE PROFILE (JSON):
${profile}

JOB POSTING:
Title: ${posting.title}
Company: ${posting.company}
Location: ${posting.location ?? "unstated"}
Description:
${jd}

SCORING RULES:
- Weight hard requirements far above nice-to-haves. Hard requirements are: required years of experience, required degree level or field, required spoken language, work authorisation or visa status, and explicitly named technologies the role is built on.
- A missed hard requirement is decisive. If the posting demands 8 years and the candidate has 3, or demands German and the candidate has none, or demands work authorisation the candidate lacks, the score is low no matter how well everything else lines up.
- Missing nice-to-haves barely matter. Do not reward keyword overlap on its own.
- Do NOT inflate. Most postings are not a good match for any given person and should score below 50. Reserve 75+ for a posting the candidate clearly qualifies for on every hard requirement and would be a strong applicant to. Reserve 90+ for a near-perfect fit.
- If the description is too thin to judge, score low rather than guessing high.

Reply with a single bare JSON object and nothing else:
{"score": <integer 0-100>, "reason": "<at most 25 words>"}

"reason" must name the single most decisive factor behind the score, not a summary.`;
}

/* ------------------------------------------------------------------ cli --- */

/**
 * Run the prompt through `claude -p`.
 *
 * The prompt goes over stdin, and that is not a stylistic choice twice over.
 * It is far too large to sit in argv -- boards ship JDs that blow past ARG_MAX
 * and would fail as an exec error rather than a scoring error. And `spawn` is
 * used rather than `execFile` because `execFile` has no `input` option: that
 * belongs to `execFileSync`, and passing it to the async form is accepted
 * silently, sends nothing, and leaves the model scoring an empty prompt. The
 * result looks like a working scorer producing nonsense, which is the worst
 * shape a bug can take here.
 *
 * The timeout SIGKILLs rather than SIGTERMs: this is a subprocess we have no
 * cleanup contract with, and a shutdown it can ignore is not a timeout.
 */
function runClaude(prompt: string, model: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "claude",
      ["-p", "--model", model, "--effort", "low"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let out = "";
    let err = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.warn(`[fit] claude timed out after ${TIMEOUT_MS / 1000}s`);
      finish(null);
    }, TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (err += c));

    // A CLI that isn't installed arrives here as ENOENT, not as an exception at
    // the spawn call, so it has to be caught on the object or it becomes an
    // unhandled error event and kills the poller.
    child.on("error", (e) => {
      console.warn("[fit] claude could not be run:", e);
      finish(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        console.warn(`[fit] claude exited ${code}: ${err.trim().slice(0, 300)}`);
        finish(null);
        return;
      }
      finish(out);
    });

    // EPIPE if the child died before reading; the close handler already covers
    // that outcome, so there is nothing useful to do here.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

/* ---------------------------------------------------------------- parse --- */

/**
 * Pull a FitResult out of whatever the model actually said.
 *
 * Asked for bare JSON it will usually oblige, but "usually" is not a contract:
 * it will sometimes fence the object, sometimes preface it with a sentence.
 * Rejecting those would throw away perfectly good scores, so the first
 * brace-balanced object anywhere in the output is taken, and anything that
 * isn't one is null. Null means unscored, which is a fine outcome; a wrong
 * number is not, so nothing here guesses.
 */
export function parseResult(raw: string): FitResult | null {
  const json = firstJsonObject(raw);
  if (!json) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const { score, reason } = obj as { score?: unknown; reason?: unknown };
  // Strings are not accepted here even though JSON.parse would give us one
  // happily: `"score": "high"` coerces to NaN and `"score": ""` coerces to 0,
  // and a silent 0 is indistinguishable from a genuine rejection.
  if (typeof score !== "number" || !Number.isFinite(score)) return null;

  return {
    score: Math.min(100, Math.max(0, Math.round(score))),
    reason: typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 300)
      : "no reason given",
  };
}

/** Brace matching, not a regex: JD text inside `reason` can contain braces. */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}
