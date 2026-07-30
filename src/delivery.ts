import type { DatabaseSync } from "node:sqlite";
import type { TextChannel } from "discord.js";
import type { Config } from "./config.ts";
import { getPosting, listSources, markDelivered, pendingEvents, setMessageId } from "./db.ts";
import { alertEmbed, digestEmbed, postingEmbed, type DigestRow } from "./render.ts";
import type { EventRow, EventType, PostingRow, SourceRow } from "./types.ts";

/** Events that always post fresh with a ping instead of editing in place. */
const ALERTS = new Set<EventType>([
  "vanished_while_claimed",
  "high_fit",
  "deadline",
  "posting_reposted",
  "stale",
]);

/**
 * Drain the pending queue into the channel.
 *
 * Nothing is marked delivered until Discord confirms, so a gateway drop or a
 * crash mid-drain re-delivers rather than silently losing events. That is why
 * the poller and the bot are separate processes over one DB.
 */
export async function drain(
  db: DatabaseSync,
  channel: TextChannel,
  cfg: Config,
): Promise<number> {
  const events = pendingEvents(db, 200);
  if (events.length === 0) return 0;

  const sources = new Map(listSources(db).map((s) => [s.id, s]));
  const done: number[] = [];

  const alerts = events.filter((e) => ALERTS.has(e.type));
  const quiet = events.filter((e) => !ALERTS.has(e.type));

  // Alerts first — they are the actionable ones and must not be buried under
  // a digest of routine openings.
  for (const ev of alerts) {
    const source = sources.get(ev.source_id);
    const posting = source && getPosting(db, ev.posting_id);
    if (!source || !posting) {
      done.push(ev.id); // orphaned by an /unwatch; drop it rather than wedge the queue
      continue;
    }
    try {
      await channel.send({
        content: cfg.pingTarget,
        embeds: [alertEmbed(source, posting, ev)],
        allowedMentions: { parse: ["users", "everyone"] },
      });
      done.push(ev.id);
    } catch (e) {
      console.error(`[deliver] alert ${ev.id} failed:`, e);
    }
  }

  // Group by posting up front: several events on one posting are one thing
  // that happened, not several, and the digest threshold counts postings.
  const grouped = new Map<number, DigestRow>();
  for (const ev of quiet) {
    const source = sources.get(ev.source_id);
    const posting = source && getPosting(db, ev.posting_id);
    if (!source || !posting) {
      done.push(ev.id);
      continue;
    }
    const row = grouped.get(posting.id);
    if (row) row.types.add(ev.type);
    else grouped.set(posting.id, { source, posting, types: new Set([ev.type]) });
  }

  if (grouped.size > cfg.digestThreshold) {
    // Too many to read one by one; collapse into a single ranked digest.
    try {
      await channel.send({ embeds: [digestEmbed([...grouped.values()])] });
      done.push(...quiet.map((e) => e.id));
    } catch (e) {
      console.error("[deliver] digest failed:", e);
    }
  } else {
    // One embed per posting; repeat events on the same posting edit that embed.
    const byPosting = new Map<number, EventRow[]>();
    for (const ev of quiet) {
      byPosting.set(ev.posting_id, [...(byPosting.get(ev.posting_id) ?? []), ev]);
    }
    for (const [postingId, group] of byPosting) {
      const row = grouped.get(postingId);
      if (!row) {
        done.push(...group.map((e) => e.id));
        continue;
      }
      try {
        await upsertPostingMessage(db, channel, row.source, row.posting);
        done.push(...group.map((e) => e.id));
      } catch (e) {
        console.error(`[deliver] posting ${postingId} failed:`, e);
      }
    }
  }

  markDelivered(db, done);
  return done.length;
}

/**
 * Post the posting's embed, or edit the existing one. A 404 means the
 * message was deleted — clear message_id and repost rather than wedging the
 * queue forever.
 */
async function upsertPostingMessage(
  db: DatabaseSync,
  channel: TextChannel,
  source: SourceRow,
  posting: PostingRow,
): Promise<void> {
  const embed = postingEmbed(source, posting);

  if (posting.message_id) {
    try {
      const msg = await channel.messages.fetch(posting.message_id);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (e: unknown) {
      if ((e as { status?: number }).status !== 404) throw e;
      setMessageId(db, posting.id, null);
    }
  }

  const sent = await channel.send({ embeds: [embed] });
  setMessageId(db, posting.id, sent.id);
}
