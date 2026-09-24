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
  getSourceById,
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
import { jevContext } from "./jev.ts";
import { ensureTelemetryStart, evaluatePosting, recoverStaleAttempts, telemetryStartMs } from "./jev-service.ts";
import { scoreFit } from "./fit.ts";
import {
  jevInventoryExtras,
  jevStats,
  jevTelemetry,
  renderStatsReport,
  statsWindow,
  type StatsPeriod,
  type StatsView,
} from "./stats.ts";
import { postingKey } from "./key.ts";
import { digestEmbed, postingEmbed, trunc, type DigestRow } from "./render.ts";
import { adapterFor, parseRef } from "./sources/registry.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PostingUpsert, SourceRow } from "./types.ts";

/** How many of a newly seeded board's postings /watch echoes back. */
const SEED_DIGEST_COUNT = 8;

export const commands = [
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Jev usage, outcomes and the waiting queue")
    .addStringOption((o) =>
      o
        .setName("period")
        .setDescription("Time window (default: last 24 hours)")
        .addChoices(
          { name: "last 24 hours", value: "24h" },
          { name: "today (local)", value: "today" },
          { name: "last 7 days", value: "7d" },
          { name: "since tracking began", value: "all" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("view")
        .setDescription("Which report (default: summary)")
        .addChoices(
          { name: "summary", value: "summary" },
          { name: "errors", value: "errors" },
          { name: "by source", value: "sources" },
        ),
    ),
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

  // A company board is named after its company; a search keeps the label the
  // adapter built from the query, or every search would be named after
  // whichever employer happened to rank first.
  const isSearch = adapter.complete === false || parsed.kind === "arbeitsagentur";
  const label = isSearch ? parsed.label : postings[0]?.company || parsed.label;
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

async function onStats(i: ChatInputCommandInteraction, db: DatabaseSync, cfg: Config) {
  if (cfg.fitProvider !== "typesafe") return i.editReply("Jev scoring is not enabled.");
  const context = await jevContext(cfg);
  if (!context) return i.editReply("Jev stats need a readable configured profile.");
  const period = (i.options.getString("period") ?? "24h") as StatsPeriod;
  const view = (i.options.getString("view") ?? "summary") as StatsView;
  const nowMs = Date.now();
  // Read-only: no model call is made from /stats, and the ledger queries are
  // bounded to one window over indexed columns.
  const window = statsWindow(period, nowMs, cfg.statsTimezone, telemetryStartMs(db));
  const telemetry = jevTelemetry(db, window);
  const inventory = jevStats(db, cfg, context.version);
  const extras = jevInventoryExtras(db, context.version);
  const text = renderStatsReport({ window, telemetry, inventory, extras, cfg, view, nowMs });
  return i.editReply(text.length > 1990 ? `${text.slice(0, 1980)}…` : text);
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
  if (cfg.fitProvider === "typesafe") {
    const context = await jevContext(cfg);
    const source = getSourceById(db, posting.source_id);
    const key = process.env.TYPESAFE_API_KEY;
    if (!context || !source || !key) return i.editReply(`Couldn't score #${id} — try again later.`);
    ensureTelemetryStart(db);
    // Same accounted path as the poller, so manual calls appear in /stats.
    const evaluation = await evaluatePosting(db, cfg, context, key, posting, {
      origin: "manual_fit",
      source,
      filters: loadFilters(cfg.filtersPath),
    });
    if (evaluation.status !== "model_result" || !evaluation.result) {
      return i.editReply(
        `Couldn't score #${id} — ${evaluation.errorKind ?? evaluation.status.replace(/_/g, " ")}.`,
      );
    }
    const result = evaluation.result;
    return i.editReply(`Fit for #${id}: **${result.score}/100**, confidence **${Math.round(result.confidence * 100)}%** — ${result.reason}`);
  }
  const result = await scoreFit(posting, cfg.profilePath, cfg.fitModel);
  if (!result) return i.editReply(`Couldn't score #${id} — see the bot logs.`);

  setFit(db, id, result.score, result.reason);
  return i.editReply(`Fit for #${id}: **${result.score}** — ${result.reason}`);
}

const cfg = loadConfig();
// SQLite is synchronous, and a long lock wait blocks whatever follows it. The
// startup migration no longer takes a writer lock unless it has stale rows, and
// every interaction is deferred before its handler touches the database — so a
// few seconds here only delays post-acknowledgement work, while a 100 ms budget
// made batch writes (markDelivered) fail whenever the poller was mid-cycle and
// re-deliver everything on the next tick.
const db = openDb(cfg.dbPath, 3000);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// discord.js re-emits an unhandled rejection from an event handler as an
// 'error' event, and an 'error' event with no listener terminates the process.
client.on(Events.Error, (e) => console.error("[bot] client error:", e));

client.once(Events.ClientReady, async (c) => {
  console.log(`[bot] ready as ${c.user.tag}`);
  try {
    const channel = (await c.channels.fetch(cfg.discordChannelId)) as TextChannel;

    // Usage tracking starts once and never resets; attempts left open by a crash
    // become unknown rather than fabricated successes or failures. Housekeeping
    // is best-effort: a write-lock collision here must not stop delivery.
    try {
      ensureTelemetryStart(db);
      recoverStaleAttempts(db);
    } catch (e) {
      console.warn("[bot] telemetry housekeeping skipped:", e);
    }

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
  } catch (e) {
    // A startup failure must be loud but not leave a half-initialised process
    // that looks online and delivers nothing: exit so systemd retries cleanly.
    console.error("[bot] startup failed; exiting for a clean restart:", e);
    process.exit(1);
  }
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    await i.deferReply();
    if (i.commandName === "watch") await onWatch(i, db);
    else if (i.commandName === "unwatch") await onUnwatch(i, db);
    else if (i.commandName === "boards") await onBoards(i, db, cfg);
    else if (i.commandName === "stats") await onStats(i, db, cfg);
    else if (i.commandName === "status") await onStatus(i, db);
    else if (i.commandName === "posting") await onPosting(i, db);
    else if (i.commandName === "claim") await onClaim(i, db);
    else if (i.commandName === "applied") await onApplied(i, db);
    else if (i.commandName === "fit") await onFit(i, db, cfg);
  } catch (e) {
    console.error(`[bot] ${i.commandName} failed:`, e);
    const message = "That failed — please try again. Check the bot logs if it persists.";
    if (i.deferred || i.replied) await i.editReply(message).catch(() => {});
    else await i.reply({ content: message, ephemeral: true }).catch(() => {});
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
