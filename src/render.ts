import { EmbedBuilder } from "discord.js";
import type { EventRow, PostingRow, SourceRow } from "./types.ts";

export const COLOR = {
  open: 0x2da44e,
  closed: 0x6e7781,
  scored: 0x8250df,
  vanished: 0xcf222e,
  highFit: 0x2da44e,
  deadline: 0xd4a72c,
  reposted: 0x0969da,
  stale: 0xd4a72c,
} as const;

/** Hard truncate with an ellipsis, for the handful of Discord field limits. */
export function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Compact age. Days alone hides the thing that matters most for a fresh
 * listing: a posting 20 minutes old and one 20 hours old both read as "0d",
 * and the freshness alert exists specifically to catch the first one.
 */
export function age(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem ? `${hours}h ${rem}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    const rem = hours % 24;
    return rem ? `${days}d ${rem}h` : `${days}d`;
  }
  return `${days}d`;
}

/**
 * Status line covering everything that isn't in the header: claim, deadline,
 * repost count, delisting. Anything not applicable is simply omitted rather
 * than printed as "none" — the line should read like a sentence, not a form.
 */
/** Where the job is, with remote folded in rather than given its own field. */
function locationLine(p: PostingRow): string {
  if (p.remote === 1) return p.location ? `${p.location} · remote` : "remote";
  return p.location || "not stated";
}

/** Empty when nothing has happened to this posting yet — the caller omits it. */
function statusLine(p: PostingRow): string {
  const parts: string[] = [];
  if (p.applied_at) parts.push(`applied ${p.applied_at.slice(0, 10)}`);
  else if (p.claimed_by) parts.push(`claimed by ${p.claimed_by}`);
  if (p.repost_count > 0) {
    parts.push(`reposted ${p.repost_count}×`);
  }
  if (p.closes_at) parts.push(`closes ${p.closes_at.slice(0, 10)}`);
  if (p.state === "closed" && p.closed_at) {
    parts.push(`delisted ${p.closed_at.slice(0, 10)}`);
  }
  return parts.join(" · ");
}

/**
 * The standing embed, edited in place as a posting moves through its life.
 *
 * `posted_at_exact` gates whether the age field is labelled "Posted" — when
 * the board didn't state a publish date and first-sighting stands in for it,
 * calling that "Posted N ago" would quietly overstate the posting's age,
 * which is exactly the number someone uses to decide whether to still apply.
 */
export function postingEmbed(source: SourceRow, p: PostingRow): EmbedBuilder {
  const closed = p.state === "closed";
  const heading = trunc(p.title, 256);

  // The four things worth reading at a glance -- role, company, where, how old --
  // each as its own field rather than one run-on line. Discord lays three inline
  // fields out as a single row, so company/location/age read as one clean strip
  // under the role instead of a sentence you have to parse.
  const e = new EmbedBuilder()
    .setColor(closed ? COLOR.closed : p.fit_score != null ? COLOR.scored : COLOR.open)
    .setTitle(closed ? `~~${heading}~~` : heading)
    .setURL(p.url)
    .addFields(
      { name: "Company", value: trunc(p.company, 1024), inline: true },
      { name: "Location", value: trunc(locationLine(p), 1024), inline: true },
      {
        // Never label a guessed date "Posted" -- when a board states no publish
        // date the system substitutes first sighting, and age is exactly the
        // number you'd use to decide whether applying is still worth it.
        name: p.posted_at_exact ? "Posted" : "First seen",
        value: `${age(p.posted_at)} ago`,
        inline: true,
      },
    );

  if (p.fit_score != null) {
    e.addFields({
      name: `Fit ${p.fit_score}/100`,
      value: trunc(p.fit_reason || "—", 1024),
      inline: false,
    });
  }

  // Only speak when there is something to say. "untouched" on every card is
  // noise that pushes the four facts above further from the eye.
  const status = statusLine(p);
  if (status) {
    e.addFields({ name: "Status", value: trunc(status, 1024), inline: false });
  }

  // Department is real but secondary -- it belongs next to the board name, not
  // competing with the role.
  const footer = [source.label, p.department].filter(Boolean).join(" · ");
  return e.setFooter({ text: trunc(footer, 2048) });
}

/**
 * Pinged, standalone events — each posts fresh rather than editing the
 * standing embed, because these are the ones meant to interrupt you.
 */
export function alertEmbed(
  source: SourceRow,
  p: PostingRow,
  ev: EventRow,
): EmbedBuilder {
  const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
  const heading = trunc(p.title, 256);
  const base = new EmbedBuilder().setURL(p.url).setFooter({ text: source.label });

  switch (ev.type) {
    case "vanished_while_claimed": {
      // The sharpest signal this system has: you meant to apply and it came
      // off the board first. The tone is about pace, not this one job — the
      // job itself is no longer actionable.
      const days = Number(payload.days_held ?? 0);
      return base
        .setColor(COLOR.vanished)
        .setTitle(`Gone: ${heading}`)
        .setDescription(
          `Claimed by ${payload.claimed_by ?? "you"} ${days} day${days === 1 ? "" : "s"} ago and it came off the board before you applied.\n` +
            `Worth tightening the gap between claiming and applying.`,
        );
    }
    case "high_fit": {
      const score = Number(payload.score ?? p.fit_score ?? 0);
      const hours = Number(payload.ageHours ?? 0);
      return base
        .setColor(COLOR.highFit)
        .setTitle(`Strong match (${score}): ${heading}`)
        .setDescription(
          `${p.company}${p.location ? ` · ${p.location}` : ""}\n` +
            `${p.fit_reason ? `${p.fit_reason}\n` : ""}` +
            `Posted ${hours}h ago — still fresh, apply now rather than queue it. \`/claim ${p.id}\` to mark it yours.`,
        );
    }
    case "deadline": {
      const closesAt = String(payload.closes_at ?? p.closes_at ?? "");
      return base
        .setColor(COLOR.deadline)
        .setTitle(`Closing soon: ${heading}`)
        .setDescription(`${p.company} — applications close ${closesAt.slice(0, 10)}.`);
    }
    case "posting_reposted": {
      const gapDays = Number(payload.gapDays ?? 0);
      const applied = Boolean(p.applied_at);
      return base
        .setColor(COLOR.reposted)
        .setTitle(`Relisted: ${heading}`)
        .setDescription(
          `${p.company} reopened this search ${gapDays} day${gapDays === 1 ? "" : "s"} after it last closed.` +
            (applied ? " You had already applied to the previous listing." : ""),
        );
    }
    case "stale": {
      const days = Number(payload.days ?? 0);
      return base
        .setColor(COLOR.stale)
        .setTitle(`Still not applied: ${heading}`)
        .setDescription(
          `Claimed ${days} day${days === 1 ? "" : "s"} ago and no application logged yet.`,
        );
    }
    default:
      // posting_opened / posting_closed are quiet events and never reach here.
      return base.setColor(COLOR.open).setTitle(heading);
  }
}

export interface DigestRow {
  source: SourceRow;
  posting: PostingRow;
  types: Set<string>;
}

/** One compact line: fit, linked title, company, location, id. */
/**
 * One posting per line, carrying the same four facts as the full card: role,
 * company, location, age. The digest is what you actually read on a busy cycle,
 * so dropping age here would mean the ranked list can't tell you the one thing
 * that decides whether a match is still worth chasing.
 */
function digestLine(row: DigestRow): string {
  const { posting } = row;
  const fit = posting.fit_score != null ? `**${posting.fit_score}**` : "—";
  const title = trunc(posting.title, 60);
  const where = posting.location
    ? ` · ${trunc(posting.location, 28)}`
    : posting.remote === 1
      ? " · remote"
      : "";
  return (
    `${fit} · [${title}](${posting.url}) — ${trunc(posting.company, 32)}${where}` +
    ` · ${age(posting.posted_at)} · \`#${posting.id}\``
  );
}

/**
 * Batch of quiet events collapsed into one embed, ranked best-fit first — in
 * a batch of thirty, the ranking is the entire value of reading it. Unscored
 * postings sort last rather than as a zero, since "unscored" isn't "bad fit".
 */
export function digestEmbed(rows: DigestRow[]): EmbedBuilder {
  const sorted = [...rows].sort((a, b) => {
    const as = a.posting.fit_score;
    const bs = b.posting.fit_score;
    if (as == null && bs == null) return 0;
    if (as == null) return 1;
    if (bs == null) return -1;
    return bs - as;
  });

  const MAX_LINES = 25;
  const MAX_CHARS = 4096;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;

  for (const row of sorted) {
    if (shown >= MAX_LINES) break;
    const line = digestLine(row);
    // Reserve room for a possible "…and N more" tail so it never gets cut off.
    if (used + line.length + 1 > MAX_CHARS - 40) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }

  const remaining = sorted.length - shown;
  if (remaining > 0) lines.push(`…and ${remaining} more`);

  return new EmbedBuilder()
    .setColor(COLOR.open)
    .setTitle(`${rows.length} posting${rows.length === 1 ? "" : "s"} updated`)
    .setDescription(lines.join("\n").slice(0, MAX_CHARS));
}
