// Who may run slash commands. Commands change the database (and some spend model
// credits), so the bot only answers allowlisted Discord users. With no allowlist the
// bot refuses every command: a public invite must never hand control to strangers.
//
//   DISCORD_ALLOWED_USER_IDS     required; comma/space-separated Discord user ids
//   DISCORD_GUILD_ID             optional; only accept commands from this server
//   DISCORD_COMMAND_CHANNEL_IDS  optional; only accept commands in these channels

export interface CommandAccess {
  userIds: ReadonlySet<string>;
  guildId: string | null;
  channelIds: ReadonlySet<string>;
}

export interface CommandOrigin {
  userId: string;
  guildId: string | null;
  channelId: string | null;
}

const SNOWFLAKE = /^\d{17,20}$/;

export function parseIdList(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter((part) => SNOWFLAKE.test(part)));
}

export function commandAccessFromEnv(env: NodeJS.ProcessEnv = process.env): CommandAccess {
  const guild = (env.DISCORD_GUILD_ID ?? "").trim();
  return {
    userIds: parseIdList(env.DISCORD_ALLOWED_USER_IDS),
    guildId: SNOWFLAKE.test(guild) ? guild : null,
    channelIds: parseIdList(env.DISCORD_COMMAND_CHANNEL_IDS),
  };
}

/** Returns why a command is refused, or null when it may run. */
export function commandRefusal(access: CommandAccess, origin: CommandOrigin): string | null {
  if (access.userIds.size === 0) return "DISCORD_ALLOWED_USER_IDS is not set";
  if (!access.userIds.has(origin.userId)) return "user is not allowlisted";
  if (access.guildId && origin.guildId !== access.guildId) return "wrong server";
  if (access.channelIds.size > 0 && (!origin.channelId || !access.channelIds.has(origin.channelId)))
    return "wrong channel";
  return null;
}
