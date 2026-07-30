import { test } from "node:test";
import assert from "node:assert/strict";
import { alertEmbed, digestEmbed, postingEmbed, trunc, age, type DigestRow } from "./render.ts";
import type { EventRow, PostingRow, SourceRow } from "./types.ts";

const source: SourceRow = {
  id: 1,
  kind: "greenhouse",
  ident: "acme",
  label: "Acme",
  etag: null,
  last_poll: null,
  fail_count: 0,
  added_at: "2026-01-01T00:00:00Z",
};

function posting(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    id: 1,
    source_id: 1,
    key: "k",
    external_id: "e1",
    title: "Backend Engineer",
    company: "Acme",
    location: "Berlin",
    remote: 1,
    department: "Engineering",
    url: "https://example.com/job/1",
    posted_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    posted_at_exact: 1,
    closes_at: null,
    first_seen: "2026-01-01T00:00:00Z",
    last_seen: "2026-01-01T00:00:00Z",
    state: "open",
    closed_at: null,
    repost_count: 0,
    description: null,
    fit_score: null,
    fit_reason: null,
    fit_scored_at: null,
    message_id: null,
    claimed_by: null,
    claimed_at: null,
    applied_at: null,
    stale_notified_at: null,
    deadline_notified_at: null,
    ...overrides,
  };
}

function event(type: EventRow["type"], payload: Record<string, unknown>): EventRow {
  return {
    id: 1,
    source_id: 1,
    posting_id: 1,
    type,
    payload_json: JSON.stringify(payload),
    created_at: "2026-01-01T00:00:00Z",
    delivered_at: null,
  };
}

test("closed posting renders struck-through and in the closed colour", () => {
  const e = postingEmbed(source, posting({ state: "closed", closed_at: "2026-01-05T00:00:00Z" }));
  const data = e.toJSON();
  assert.match(data.title!, /^~~.*~~$/);
  assert.equal(data.color, 0x6e7781);
});

test("posted_at_exact = 0 shows First seen, never a posted date", () => {
  const e = postingEmbed(source, posting({ posted_at_exact: 0 }));
  const data = e.toJSON();
  const field = data.fields!.find((f) => f.name === "First seen" || f.name === "Posted");
  assert.ok(field);
  assert.equal(field!.name, "First seen");
});

test("posted_at_exact = 1 shows Posted", () => {
  const e = postingEmbed(source, posting({ posted_at_exact: 1 }));
  const data = e.toJSON();
  const field = data.fields!.find((f) => f.name === "Posted" || f.name === "First seen");
  assert.equal(field!.name, "Posted");
});

test("fit score and reason appear when scored", () => {
  const e = postingEmbed(
    source,
    posting({ fit_score: 88, fit_reason: "Strong backend match" }),
  );
  const data = e.toJSON();
  // The score lives in the field name so it reads at a glance; the reason is
  // the value.
  const field = data.fields!.find((f) => f.name.startsWith("Fit"));
  assert.ok(field);
  assert.match(field!.name, /88/);
  assert.match(field!.value, /Strong backend match/);
});

test("fit field absent when not scored", () => {
  const e = postingEmbed(source, posting());
  const data = e.toJSON();
  assert.ok(!data.fields!.some((f) => f.name.startsWith("Fit")));
});

test("the card leads with role, company, location and age", () => {
  const e = postingEmbed(
    source,
    posting({
      title: "Werkstudent Data (m/w/d)",
      company: "Bosch",
      location: "Berlin",
      remote: 0,
    }),
  );
  const data = e.toJSON();
  assert.match(data.title!, /Werkstudent Data/);

  const byName = new Map(data.fields!.map((f) => [f.name, f]));
  assert.equal(byName.get("Company")!.value, "Bosch");
  assert.equal(byName.get("Location")!.value, "Berlin");
  assert.match(byName.get("Posted")!.value, /ago$/);

  // All three inline, so Discord lays them out as one row under the role.
  for (const n of ["Company", "Location", "Posted"]) {
    assert.equal(byName.get(n)!.inline, true, `${n} should be inline`);
  }
});

test("a remote posting says so in the location field", () => {
  const withCity = postingEmbed(source, posting({ location: "Berlin", remote: 1 })).toJSON();
  assert.equal(
    withCity.fields!.find((f) => f.name === "Location")!.value,
    "Berlin · remote",
  );

  const noCity = postingEmbed(source, posting({ location: null, remote: 1 })).toJSON();
  assert.equal(noCity.fields!.find((f) => f.name === "Location")!.value, "remote");

  const neither = postingEmbed(source, posting({ location: null, remote: null })).toJSON();
  assert.equal(neither.fields!.find((f) => f.name === "Location")!.value, "not stated");
});

test("an untouched posting shows no status field at all", () => {
  const e = postingEmbed(source, posting()).toJSON();
  assert.ok(!e.fields!.some((f) => f.name === "Status"));
});

test("department moves to the footer, out of the role's way", () => {
  const e = postingEmbed(source, posting({ department: "Engineering" })).toJSON();
  assert.match(e.footer!.text, /Engineering/);
  assert.ok(!e.fields!.some((f) => f.value.includes("Engineering")));
});

test("digest lines carry the age too", () => {
  const e = digestEmbed([
    { source, posting: posting({ title: "Werkstudent BI", company: "Bosch", location: "Berlin" }), types: new Set() },
  ]).toJSON();
  assert.match(e.description!, /Werkstudent BI/);
  assert.match(e.description!, /Bosch/);
  assert.match(e.description!, /Berlin/);
  // age() renders as <1h / 12h / 30d
  assert.match(e.description!, /·\s*(<1h|\d+[hd])\s*·/);
});

test("vanished_while_claimed alert mentions payload facts and is red", () => {
  const ev = event("vanished_while_claimed", { claimed_by: "mahesh", claimed_at: "x", days_held: 4 });
  const e = alertEmbed(source, posting(), ev);
  const data = e.toJSON();
  assert.equal(data.color, 0xcf222e);
  assert.match(data.description!, /4 days/);
  assert.match(data.description!, /mahesh/);
});

test("high_fit alert shows score, reason, age, claim instruction", () => {
  const ev = event("high_fit", { score: 92, ageHours: 5 });
  const e = alertEmbed(source, posting({ fit_score: 92, fit_reason: "great match" }), ev);
  const data = e.toJSON();
  assert.match(data.title!, /92/);
  assert.match(data.description!, /great match/);
  assert.match(data.description!, /5h/);
  assert.match(data.description!, /\/claim/);
});

test("deadline alert shows the stated close date", () => {
  const ev = event("deadline", { closes_at: "2026-08-01T00:00:00Z" });
  const e = alertEmbed(source, posting({ closes_at: "2026-08-01T00:00:00Z" }), ev);
  const data = e.toJSON();
  assert.match(data.description!, /2026-08-01/);
  assert.equal(data.color, 0xd4a72c);
});

test("posting_reposted alert mentions gap and prior application", () => {
  const ev = event("posting_reposted", { gapDays: 30, previousExternalId: "e0" });
  const e = alertEmbed(source, posting({ applied_at: "2026-01-01T00:00:00Z" }), ev);
  const data = e.toJSON();
  assert.match(data.description!, /30 days/);
  assert.match(data.description!, /already applied/);
});

test("stale alert reports days claimed without application", () => {
  const ev = event("stale", { days: 9 });
  const e = alertEmbed(source, posting(), ev);
  const data = e.toJSON();
  assert.match(data.description!, /9 days/);
});

test("digest sorts by fit descending with unscored last", () => {
  const rows: DigestRow[] = [
    { source, posting: posting({ id: 1, fit_score: 50 }), types: new Set(["posting_opened"]) },
    { source, posting: posting({ id: 2, fit_score: null }), types: new Set(["posting_opened"]) },
    { source, posting: posting({ id: 3, fit_score: 90 }), types: new Set(["posting_opened"]) },
  ];
  const e = digestEmbed(rows);
  const desc = e.toJSON().description!;
  const idx90 = desc.indexOf("**90**");
  const idx50 = desc.indexOf("**50**");
  const idxUnscored = desc.indexOf("— · [");
  assert.ok(idx90 < idx50);
  // unscored posting's line should come after both scored ones
  const lines = desc.split("\n");
  const unscoredLineIdx = lines.findIndex((l) => l.includes("#2"));
  const scoredLineIdx = lines.findIndex((l) => l.includes("#1"));
  assert.ok(unscoredLineIdx > scoredLineIdx);
});

test("digest with many rows stays within description limit and shows a tail", () => {
  const rows: DigestRow[] = Array.from({ length: 60 }, (_, i) =>
    ({ source, posting: posting({ id: i + 1, fit_score: 100 - i, title: `Job number ${i}` }), types: new Set(["posting_opened"]) }),
  );
  const e = digestEmbed(rows);
  const desc = e.toJSON().description!;
  assert.ok(desc.length <= 4096);
  assert.match(desc, /and \d+ more/);
});

test("truncation of an absurdly long title keeps the embed valid", () => {
  const longTitle = "X".repeat(1000);
  const e = postingEmbed(source, posting({ title: longTitle }));
  const data = e.toJSON();
  assert.ok(data.title!.length <= 256);
});

test("trunc helper", () => {
  assert.equal(trunc("hello", 10), "hello");
  assert.equal(trunc("hello world", 5), "hell…");
});

test("age helper scales resolution", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  assert.equal(age("2026-01-02T00:00:00Z", now), "0m");
  assert.equal(age("2026-01-01T23:00:00Z", now), "1h");
  assert.equal(age("2025-12-26T00:00:00Z", now), "7d");
});
