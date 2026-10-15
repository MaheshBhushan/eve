import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { loadApplicationConfig } from "./application-config.ts";
import { deliverApplicationNotification, drainApplicationNotifications } from "./applications.ts";
import { claimApplication, enqueueApplications, finishApplication, pendingApplicationNotifications } from "./application-queue.ts";

test("Discord rejection preserves handoff notification until the configured channel acknowledges delivery", async () => {
  const db = openDb(":memory:");
  try {
    db.exec("INSERT INTO sources(kind,ident,label) VALUES ('greenhouse','fixture','Fixture'); INSERT INTO postings(source_id,key,external_id,title,company,url,posted_at) VALUES (1,'fixture','fixture','Engineer','Fixture','https://example.invalid/job',datetime('now'))");
    enqueueApplications(db, { destination: "http://localhost/review", limit: 1 });
    const job = claimApplication(db, 60)!;
    finishApplication(db, job.id, job.lease_token!, { state: "handoff", error: "Verification required; @everyone" });
    const config = loadApplicationConfig({ EVE_APPLICATION_DISCORD_CHANNEL_ID: "1560260264509841449", EVE_APPLICATION_DISCORD_TOKEN: "fixture-secret" });
    let acknowledgement: unknown = { message: "Missing Access" };
    let status = 403;
    const transport = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      return new Response(JSON.stringify(acknowledgement), { status });
    }) as typeof fetch;
    assert.equal((await drainApplicationNotifications(db, config, transport)).delivered, 0);
    assert.equal(pendingApplicationNotifications(db).length, 1);
    status = 200;
    acknowledgement = { id: "1560260264509841450", channel_id: "1560260264509841448" };
    assert.equal((await drainApplicationNotifications(db, config, transport)).delivered, 0);
    assert.equal(pendingApplicationNotifications(db).length, 1);
    acknowledgement = { id: "1560260264509841450", channel_id: config.discordChannelId };
    assert.equal((await drainApplicationNotifications(db, config, transport)).delivered, 1);
    assert.equal(pendingApplicationNotifications(db).length, 0);
  } finally { db.close(); }
});

test("Discord channel selection does not silently fall back when its bot token is missing", async () => {
  const config = loadApplicationConfig({ EVE_APPLICATION_DISCORD_CHANNEL_ID: "1560260264509841449", EVE_APPLICATION_TELEGRAM_TOKEN: "fixture", EVE_APPLICATION_TELEGRAM_CHAT_ID: "1" });
  await assert.rejects(deliverApplicationNotification(config, { id: 1, job_id: 1, payload_json: "{}" }), /not configured/);
  assert.throws(() => loadApplicationConfig({ EVE_APPLICATION_DISCORD_CHANNEL_ID: "../../other" }), /channel ID/);
});
