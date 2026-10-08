import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, addSource, upsertPosting, queueEvent, pendingEvents } from "./db.ts";
import { drain } from "./delivery.ts";
import type { Config } from "./config.ts";
import type { TextChannel } from "discord.js";

test("the same job on two boards is announced once", async () => {
  const db = openDb(":memory:");
  const cfg = { digestThreshold: 5, pingTarget: "", matchesOnly: false } as Config;
  const job = { key: "same-job", title: "Backend Engineer", company: "Acme", location: "Berlin", remote: 0, department: null, posted_at: new Date().toISOString(), posted_at_exact: 1, closes_at: null, description: null };
  const ids = ["linkedin", "greenhouse"].map((kind, i) => {
    const source = addSource(db, kind, `acme-${i}`, kind);
    const id = upsertPosting(db, { ...job, source_id: source.id, external_id: String(i), url: `https://example.com/${i}` });
    db.prepare("UPDATE postings SET roleFamily='backend' WHERE id=?").run(id);
    queueEvent(db, source.id, id, "posting_opened");
    return id;
  });
  let sends = 0;
  await drain(db, { send: async () => { sends++; return { id: "m", edit: async () => ({}) }; } } as unknown as TextChannel, cfg);
  assert.equal(sends, 1);
  assert.equal(pendingEvents(db, 100, true).length, 0);
  // A later copy from a third board is suppressed against the delivered one.
  queueEvent(db, 1, ids[1]!, "posting_reposted");
  await drain(db, { send: async () => { sends++; return { id: "m" }; } } as unknown as TextChannel, cfg);
  assert.equal(sends, 1);
  db.close();
});

test("an open job is not re-queued for its deadline on every poll", async () => {
  const { sweepDeadlines } = await import("./events.ts");
  const db = openDb(":memory:");
  const source = addSource(db, "xing", "ai", "XING");
  const row = { source_id: source.id, key: "k", external_id: "1", title: "AI Expert", company: "X", location: "Berlin", remote: 0, department: null, url: "https://example.com", posted_at: new Date().toISOString(), posted_at_exact: 1, closes_at: new Date(Date.now() + 86_400_000).toISOString(), description: null };
  upsertPosting(db, row);
  assert.equal(sweepDeadlines(db, 3), 1);
  upsertPosting(db, row);
  assert.equal(sweepDeadlines(db, 3), 0);
  db.close();
});
