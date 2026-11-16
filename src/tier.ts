/**
 * Application tier: how likely a posting is to survive a first screen, judged
 * only on the knockouts that ended most past applications. A 2026-11-15 review
 * of 202 tailored packages found a German-language gap in 119 and an
 * experience-floor gap in 44; documents with 100 percent keyword coverage were
 * still rejected on those two.
 *
 *   A  no German above the candidate's level is required, no experience floor
 *      above one year. Tailor and send.
 *   B  German at B1, or "good German" without a level, is required. The
 *      candidate is working toward B1, so this is a stretch worth one try.
 *   C  German at B2 or above (or "very good", "fluent", "verhandlungssicher"),
 *      or two or more years of professional experience, is required. Expect a
 *      screen-out; tailor only on purpose.
 *
 * Deterministic and offline on purpose: it reads the stored description, costs
 * nothing per posting, and gives the same answer on every run. The LLM fit score
 * judges relevance; this judges the knockouts the fit score kept under-weighting.
 */

export type Tier = "A" | "B" | "C";

export interface TierResult {
  tier: Tier;
  /** Short quoted evidence for every rule that fired, for the card. */
  reasons: string[];
}

interface TierInput {
  title: string;
  description: string | null;
}

// "nice to have" and its German equivalents mark a requirement as optional.
// Checked in the same sentence as the match, so "German is a plus" never
// downgrades a posting.
const OPTIONAL =
  /\b(plus|nice[- ]to[- ]have|von vorteil|wünschenswert|wuenschenswert|ideally|idealerweise|preferred|bonus|advantage|vorteilhaft|gerne)\b/i;

const GERMAN = String.raw`(deutsch\w*|german)`;

// Level words that mean B2 or above.
const STRONG =
  String.raw`(sehr gut\w*|fließend\w*|fliessend\w*|verhandlungssicher\w*|exzellent\w*|ausgezeichnet\w*|hervorragend\w*|very good|strong|excellent|fluent|fluency|business[- ]fluent|proficient|native|muttersprach\w*|c1|c2|b2)`;
// Level words that mean roughly B1.
const MEDIUM = String.raw`(gut\w*|solid\w*|good|b1|working knowledge|conversational)`;

// After "Deutsch", the level word must come before any other language is named:
// in "Gute Deutsch- und sehr gute Englischkenntnisse" the "sehr gute" belongs to
// English, and the German requirement is only "gute".
const AFTER_GERMAN = String.raw`(?:(?!engl)[^.;\n]){0,30}\(?\s*`;
// `\w*` in the guard stops the level word backtracking ("sehr gut" + "e Englisch").
const NOT_ENGLISH = String.raw`(?!\w*\s*engl)`;
const STRONG_NEAR = new RegExp(`${STRONG}[^.;\\n]{0,40}${GERMAN}|${GERMAN}${AFTER_GERMAN}${STRONG}${NOT_ENGLISH}`, "i");
const MEDIUM_NEAR = new RegExp(`${MEDIUM}[^.;\\n]{0,40}${GERMAN}|${GERMAN}${AFTER_GERMAN}${MEDIUM}${NOT_ENGLISH}`, "i");
// "Deutschkenntnisse" or "German skills" named as a requirement with no level.
const BARE_GERMAN =
  /\b(deutschkenntnisse|deutsch\s+in\s+wort\s+und\s+schrift|german\s+(language\s+)?(skills|required)|knowledge of german)\b/i;

// "3+ years", "at least 2 years", "mindestens 2 Jahre", "2-3 Jahre Berufserfahrung".
const YEARS = [
  /(\d+)\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)\b[^.;\n]{0,40}\b(experience|erfahrung)/i,
  /(?:mindestens|min\.|at least|minimum(?: of)?)\s*(\d+)\s*(?:jahre?|years?)/i,
  /(\d+)\s*\+?\s*(?:-\s*\d+\s*)?jahre?\b[^.;\n]{0,30}(berufserfahrung|erfahrung)/i,
];

function sentences(text: string): string[] {
  return text.split(/(?<=[.;!?\n])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** The matched words plus a little context, so a long bullet still shows why it fired. */
function quote(s: string, m: RegExpExecArray): string {
  const from = Math.max(0, m.index - 25);
  const to = Math.min(s.length, m.index + m[0].length + 25);
  const t = s.slice(from, to).replace(/\s+/g, " ").trim();
  return `"${from > 0 ? "…" : ""}${t}${to < s.length ? "…" : ""}"`;
}

export function postingTier(p: TierInput): TierResult {
  const text = `${p.title}\n${p.description ?? ""}`;
  const c: string[] = [];
  const b: string[] = [];

  for (const s of sentences(text)) {
    if (OPTIONAL.test(s)) continue;
    const strong = STRONG_NEAR.exec(s);
    const medium = strong ? null : (MEDIUM_NEAR.exec(s) ?? BARE_GERMAN.exec(s));
    if (strong) c.push(`German: ${quote(s, strong)}`);
    else if (medium) b.push(`German: ${quote(s, medium)}`);

    for (const re of YEARS) {
      const m = re.exec(s);
      if (m && Number(m[1]) >= 2 && Number(m[1]) <= 15) {
        c.push(`Experience: ${quote(s, m)}`);
        break;
      }
    }
  }

  if (c.length) return { tier: "C", reasons: c.slice(0, 3) };
  if (b.length) return { tier: "B", reasons: b.slice(0, 3) };
  return { tier: "A", reasons: [] };
}

export const TIER_LABEL: Record<Tier, string> = {
  A: "Tier A · apply",
  B: "Tier B · German B1 stretch",
  C: "Tier C · knockout likely",
};

/** Sort key: A before B before C. */
export const TIER_RANK: Record<Tier, number> = { A: 0, B: 1, C: 2 };
