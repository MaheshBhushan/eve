import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { commandAccessFromEnv, commandRefusal, parseIdList } from "./access.ts";

const OWNER = "123456789012345678";
const STRANGER = "876543210987654321";
const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";

describe("command access", () => {
  test("refuses everyone when the allowlist is unset", () => {
    const access = commandAccessFromEnv({});
    assert.equal(commandRefusal(access, { userId: OWNER, guildId: GUILD, channelId: CHANNEL }), "DISCORD_ALLOWED_USER_IDS is not set");
  });

  test("admits only allowlisted users", () => {
    const access = commandAccessFromEnv({ DISCORD_ALLOWED_USER_IDS: `${OWNER}, junk` });
    assert.equal(commandRefusal(access, { userId: OWNER, guildId: null, channelId: null }), null);
    assert.equal(commandRefusal(access, { userId: STRANGER, guildId: null, channelId: null }), "user is not allowlisted");
  });

  test("applies the optional server and channel gates", () => {
    const access = commandAccessFromEnv({
      DISCORD_ALLOWED_USER_IDS: OWNER,
      DISCORD_GUILD_ID: GUILD,
      DISCORD_COMMAND_CHANNEL_IDS: CHANNEL,
    });
    assert.equal(commandRefusal(access, { userId: OWNER, guildId: GUILD, channelId: CHANNEL }), null);
    assert.equal(commandRefusal(access, { userId: OWNER, guildId: null, channelId: CHANNEL }), "wrong server");
    assert.equal(commandRefusal(access, { userId: OWNER, guildId: GUILD, channelId: "333333333333333333" }), "wrong channel");
  });

  test("ignores malformed ids", () => {
    assert.deepEqual([...parseIdList("12 abc 123456789012345678,,")], ["123456789012345678"]);
  });
});
