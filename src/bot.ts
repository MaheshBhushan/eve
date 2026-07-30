import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { loadConfig, type Config } from "./config.ts";
import {
  addSource,
  claimPosting,
  getPosting,
  getSource,
  listOpenPostings,
  listSources,
  openDb,
  removeSource,
  setApplied,
  setFilterHash,
  setFit,
  setSourceLabel,
  upsertPosting,
} from "./db.ts";
import { drain } from "./delivery.ts";
import { applyFilter, filterHash, loadFilters, specFor } from "./filter.ts";
import { scoreFit } from "./fit.ts";
import { postingKey } from "./key.ts";
import { digestEmbed, postingEmbed, trunc, type DigestRow } from "./render.ts";
import { adapterFor, parseRef } from "./sources/registry.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PostingUpsert, SourceRow } from "./types.ts";

/** How many of a newly seeded board's postings /watch echoes back. */
const SEED_DIGEST_COUNT = 8;

export const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Track a company job board for openings, closures, reposts and fit")
    .addStringOption((o) =>
      o
        .setName("board")
        .setDescription("greenhouse:stripe, lever:spotify, ashby:ramp, or a board URL")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("Stop tracking a board and forget its postings")
    .addStringOption((o) =>
      o.setName("board").setDescription("greenhouse:stripe, lever:spotify, ashby:ramp, or a board URL").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("boards")
    .setDescription("Every tracked board, its open count, and its poll health"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Open postings, ranked by fit")
    .addBooleanOption((o) =>
      o.setName("mine").setDescription("Only postings you've claimed or applied to"),
    ),
  new SlashCommandBuilder()
    .setName("posting")
    .setDescription("Full detail for one posting")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("posting id, from /status or /boards").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Mark a posting as one you intend to apply to")
    .addIntegerOption((o) => o.setName("id").setDescription("posting id").setRequired(true))
    .addBooleanOption((o) =>
      o.setName("release").setDescription("drop the claim instead"),
    ),
  new SlashCommandBuilder()
    .setName("applied")
    .setDescription("Mark a posting as applied")
    .addIntegerOption((o) => o.setName("id").setDescription("posting id").setRequired(true))
    .addBooleanOption((o) =>
      o.setName("undo").setDescription("undo a misclick instead"),
    ),
  new SlashCommandBuilder()
    .setName("fit")
    .setDescription("Score (or rescore) a posting against your profile")
    .addIntegerOption((o) => o.setName("id").setDescription("posting id").setRequired(true)),
].map((c) => c.toJSON());

const BOARD_HELP =
  "Couldn't read that as a board. Try `greenhouse:stripe`, `lever:spotify`, `ashby:ramp`, " +
  "or paste the board's URL.";

/** Boolean -> 0/1/null the way the postings table stores `remote`. */
function toRemoteFlag(remote: boolean | null): number | null {
  return remote == null ? null : remote ? 1 : 0;
}

function sourceById(db: DatabaseSync, sourceId: number): SourceRow | undefined {
  return listSources(db).find((s) => s.id === sourceId);
}

async function onWatch(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const raw = i.options.getString("board", true);
  const parsed = parseRef(raw);
  if (!parsed) return i.editReply(BOARD_HELP);

  if (getSource(db, parsed.kind, parsed.ident)) {
    return i.editReply(`Already watching \`${parsed.kind}:${parsed.ident}\`.`);
  }

  // A typo'd slug still answers HTTP 200 with an error body on some boards, so
  // a real fetch -- not a URL shape check -- is the only honest existence
  // proof. Nothing is registered until this succeeds.
  const adapter = adapterFor(parsed.kind);
  let result;
  try {
    result = await adapter.fetch(parsed.ident, null);
  } catch (e) {
    return i.editReply(
      `Couldn't load \`${parsed.kind}:${parsed.ident}\`: ${(e as Error).message}`,
    );
  }
  const postings = result.postings;
  if (postings === null) {
    return i.editReply(`Couldn't load \`${parsed.kind}:${parsed.ident}\`: empty response.`);
  }

  const label = postings[0]?.company || parsed.label;
  const source = addSource(db, parsed.kind, parsed.ident, label);
  if (source.label !== label) setSourceLabel(db, source.id, label);

  // Seed through the same filter the poller uses, and record the hash we seeded
  // under. Seeding unfiltered would be actively harmful, not merely wasteful:
  // every stored posting is a fit-scoring candidate, so a 4700-posting board
  // would spend thousands of LLM calls on roles the filter exists to reject —
  // and then the first filtered poll would find them all absent and close them
  // en masse. Baseline and steady state have to be built the same way.
  const spec = specFor(loadFilters(cfg.filtersPath), parsed.kind, parsed.ident);
  const kept = applyFilter(postings, spec);
  setFilterHash(db, source.id, filterHash(spec));

  // Seed the board silently. Closure is inferred from absence in the next
  // snapshot; without a baseline the very first poll would read every
  // pre-existing posting as brand new.
  for (const p of kept) {
    const exact = p.postedAt != null;
    const row: PostingUpsert = {
      source_id: source.id,
      key: postingKey(p),
      external_id: p.externalId,
      title: p.title,
      company: p.company,
      location: p.location,
      remote: toRemoteFlag(p.remote),
      department: p.department,
      url: p.url,
      posted_at: p.postedAt ?? new Date().toISOString(),
      posted_at_exact: exact ? 1 : 0,
      closes_at: p.closesAt,
      description: p.description,
    };
    upsertPosting(db, row);
  }

  const seeded = listOpenPostings(db, source.id).slice(0, SEED_DIGEST_COUNT);
  const rows: DigestRow[] = seeded.map((posting) => ({
    source: { ...source, label },
    posting,
    types: new Set<string>(),
  }));

  return i.editReply({
    content:
      `Now watching \`${parsed.kind}:${parsed.ident}\` (${label}) — seeded ${kept.length} of ${
        postings.length
      } open posting${postings.length === 1 ? "" : "s"}${
        kept.length === postings.length ? "" : ` (${postings.length - kept.length} filtered out)`
      }. You'll hear about new ones, closures, reposts and high fits from here.` +
      (kept.length === 0
        ? "\n\nNothing matched your filter, so the board is being tracked but is quiet. That is normal for a small board — it will speak up when a matching role opens."
        : ""),
    embeds: rows.length ? [digestEmbed(rows)] : [],
  });
}

async function onUnwatch(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const raw = i.options.getString("board", true);
  const parsed = parseRef(raw);
  if (!parsed) return i.editReply(BOARD_HELP);

  const gone = removeSource(db, parsed.kind, parsed.ident);
  return i.editReply(
    gone
      ? `Stopped watching \`${parsed.kind}:${parsed.ident}\`.`
      : `Not watching \`${parsed.kind}:${parsed.ident}\`.`,
  );
}

function health(source: SourceRow, cfg: Config): string {
  if (source.fail_count >= cfg.maxFailures) return `MUTED at ${cfg.maxFailures} failures`;
  if (!source.last_poll) return "never polled";
  if (source.fail_count > 0) return `polled, ${source.fail_count} recent failures`;
  return "ok";
}

async function onBoards(i: ChatInputCommandInteraction, db: DatabaseSync, cfg: Config) {
  const sources = listSources(db);
  if (sources.length === 0) {
    return i.editReply("Nothing tracked yet — try `/watch greenhouse:stripe`.");
  }

  const rows = sources.map((s) => {
    const open = listOpenPostings(db, s.id).length;
    return [
      trunc(`${s.label} (${s.kind}:${s.ident})`, 40).padEnd(40),
      String(open).padStart(5),
      health(s, cfg),
    ].join("  ");
  });

  return i.editReply(
    `\`\`\`\n${"board".padEnd(40)}  ${"open".padStart(5)}  health\n${rows.join("\n")}\n\`\`\``,
  );
}

async function onStatus(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const mine = i.options.getBoolean("mine") ?? false;
  let postings = listOpenPostings(db);
  if (mine) postings = postings.filter((p) => p.claimed_by || p.applied_at);
  if (postings.length === 0) {
    return i.editReply(mine ? "Nothing claimed or applied to yet." : "No open postings tracked.");
  }

  const rows: DigestRow[] = postings
    .map((posting) => {
      const source = sourceById(db, posting.source_id);
      return source ? { source, posting, types: new Set<string>() } : null;
    })
    .filter((r): r is DigestRow => r !== null);

  return i.editReply({ embeds: [digestEmbed(rows)] });
}

async function onPosting(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const id = i.options.getInteger("id", true);
  const posting = getPosting(db, id);
  if (!posting) return i.editReply(`No posting #${id}. Check \`/status\` for valid ids.`);

  const source = sourceById(db, posting.source_id);
  if (!source) return i.editReply(`Posting #${id} has no surviving source record.`);

  const embed = postingEmbed(source, posting);
  if (posting.description) {
    embed.addFields({ name: "Description", value: trunc(posting.description, 1024) });
  }
  return i.editReply({ embeds: [embed] });
}

async function onClaim(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const id = i.options.getInteger("id", true);
  if (!getPosting(db, id)) return i.editReply(`No posting #${id}. Check \`/status\` for valid ids.`);

  const release = i.options.getBoolean("release") ?? false;
  claimPosting(db, id, release ? null : i.user.username);
  return i.editReply(
    release
      ? `Released #${id}.`
      : `Claimed #${id}. If it comes off the board before you apply, you'll get pinged.`,
  );
}

async function onApplied(i: ChatInputCommandInteraction, db: DatabaseSync) {
  const id = i.options.getInteger("id", true);
  if (!getPosting(db, id)) return i.editReply(`No posting #${id}. Check \`/status\` for valid ids.`);

  const undo = i.options.getBoolean("undo") ?? false;
  setApplied(db, id, !undo);
  return i.editReply(
    undo
      ? `Unmarked #${id} as applied.`
      : `Marked #${id} as applied. Stale nudges stop, and a later delisting closes quietly instead of alerting.`,
  );
}

async function onFit(i: ChatInputCommandInteraction, db: DatabaseSync, cfg: Config) {
  const id = i.options.getInteger("id", true);
  const posting = getPosting(db, id);
  if (!posting) return i.editReply(`No posting #${id}. Check \`/status\` for valid ids.`);

  if (!cfg.profilePath) {
    return i.editReply("Fit scoring is off — set `RADAR_PROFILE` to a profile.json path and restart the bot.");
  }
  if (!posting.description) {
    return i.editReply(`#${id} has no stored description to score against.`);
  }

  // scoreFit shells out to the claude CLI and can take up to its own 90s
  // timeout; the interaction was deferred on receipt, and a deferred reply is
  // good for 15 minutes, so this has ample room even on a slow model.
  const result = await scoreFit(posting, cfg.profilePath, cfg.fitModel);
  if (!result) return i.editReply(`Couldn't score #${id} — see the bot logs.`);

  setFit(db, id, result.score, result.reason);
  return i.editReply(`Fit for #${id}: **${result.score}** — ${result.reason}`);
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  const channel = (await c.channels.fetch(cfg.discordChannelId)) as TextChannel;

  // Drain on connect: anything the poller queued while the gateway was down is
  // still sitting in the events table, which is the point of the split.
  const tick = async () => {
    try {
      const n = await drain(db, channel, cfg);
      if (n) console.log(`[bot] delivered ${n} events`);
    } catch (e) {
      console.error("[bot] drain failed:", e);
    }
  };
  await tick();

  // Resuming from suspend can leave the websocket open but dead: the process is
  // healthy, so Restart=always never fires, and the bot sits there looking
  // online while delivering nothing. discord.js reconnects on its own within a
  // few seconds, so only a sustained outage counts. Exiting hands the problem
  // to systemd, which knows how to start us cleanly.
  let unhealthy = 0;
  const HEALTH_STRIKES = 4; // ~2 minutes at the 30s tick

  setInterval(async () => {
    if (client.isReady()) {
      unhealthy = 0;
      await tick();
      return;
    }
    if (++unhealthy >= HEALTH_STRIKES) {
      console.error(
        `[bot] gateway not ready for ${(HEALTH_STRIKES * 30) / 60} minutes; exiting for restart`,
      );
      process.exit(1);
    }
    console.warn(`[bot] gateway not ready (${unhealthy}/${HEALTH_STRIKES})`);
  }, 30_000);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  await i.deferReply();
  try {
    if (i.commandName === "watch") await onWatch(i, db);
    else if (i.commandName === "unwatch") await onUnwatch(i, db);
    else if (i.commandName === "boards") await onBoards(i, db, cfg);
    else if (i.commandName === "status") await onStatus(i, db);
    else if (i.commandName === "posting") await onPosting(i, db);
    else if (i.commandName === "claim") await onClaim(i, db);
    else if (i.commandName === "applied") await onApplied(i, db);
    else if (i.commandName === "fit") await onFit(i, db, cfg);
  } catch (e) {
    console.error(`[bot] ${i.commandName} failed:`, e);
    await i.editReply("That failed — check the logs.").catch(() => {});
  }
});

if (process.argv.includes("--register")) {
  const rest = new REST().setToken(cfg.discordToken);
  // The first token segment is the base64 application id, but that has not
  // always held across token formats — DISCORD_APP_ID wins when set.
  const appId =
    process.env.DISCORD_APP_ID ||
    Buffer.from(cfg.discordToken.split(".")[0]!, "base64").toString();
  if (!/^\d{17,20}$/.test(appId)) {
    console.error(
      `Could not derive the application id from the token (got "${appId}").\n` +
        "Set DISCORD_APP_ID in .env — it's the Application ID on your app's General Information page.",
    );
    process.exit(1);
  }
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log(`[bot] registered ${commands.length} commands`);
  process.exit(0);
}

await client.login(cfg.discordToken);
