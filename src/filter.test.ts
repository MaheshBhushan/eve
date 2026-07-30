import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.ts";
import {
  addSource,
  getFilterHash,
  listPostingsForSource,
  openDb,
  pendingEvents,
} from "./db.ts";
import {
  applyFilter,
  filterHash,
  loadFilters,
  matches,
  normalise,
  specFor,
  type FilterConfig,
  type FilterSpec,
} from "./filter.ts";
import { pollSource } from "./poller.ts";
import type { Adapter } from "./sources/index.ts";
import type { FetchedPosting, SourceRow } from "./types.ts";

/* ------------------------------------------------------------- fixtures --- */

function posting(over: Partial<FetchedPosting> = {}): FetchedPosting {
  return {
    externalId: "1001",
    title: "Werkstudent Data Engineering (m/w/d)",
    company: "Acme GmbH",
    location: "Berlin, Deutschland",
    remote: false,
    department: "Engineering",
    url: "https://boards.example/acme/1001",
    postedAt: null,
    closesAt: null,
    description: null,
    ...over,
  };
}

function tmpDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "eve-filter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* ------------------------------------------------------------ the fields --- */

test("an empty spec passes everything through", () => {
  const board = [posting(), posting({ title: "CFO", location: "Tokyo" })];
  assert.equal(applyFilter(board, {}).length, 2);
  assert.equal(applyFilter(board, { titleAny: [], locationAny: [] }).length, 2);
});

test("titleAny keeps only matching titles", () => {
  const spec: FilterSpec = { titleAny: ["werkstudent", "praktikum"] };
  assert.equal(matches(posting(), spec), true);
  assert.equal(matches(posting({ title: "Pflichtpraktikum Marketing" }), spec), true);
  assert.equal(matches(posting({ title: "Backend Engineer" }), spec), false);
});

test("titleNone beats titleAny", () => {
  const spec: FilterSpec = { titleAny: ["werkstudent"], titleNone: ["senior"] };
  assert.equal(matches(posting({ title: "Senior Werkstudent Wrangler" }), spec), false);
  assert.equal(matches(posting(), spec), true);
});

test("locationAny and locationNone gate on location", () => {
  const spec: FilterSpec = { locationAny: ["deutschland"], locationNone: ["dresden"] };
  assert.equal(matches(posting(), spec), true);
  assert.equal(matches(posting({ location: "Wien, Osterreich" }), spec), false);
  assert.equal(matches(posting({ location: "Dresden, Deutschland" }), spec), false);
  // A null location cannot satisfy a location requirement.
  assert.equal(matches(posting({ location: null }), spec), false);
});

test("companyAny and companyNone gate on company", () => {
  assert.equal(matches(posting(), { companyAny: ["acme"] }), true);
  assert.equal(matches(posting(), { companyAny: ["globex"] }), false);
  assert.equal(matches(posting(), { companyNone: ["acme"] }), false);
  // Absent companyAny means any company.
  assert.equal(matches(posting(), { companyNone: ["globex"] }), true);
});

/* ----------------------------------------------------- case and diacritics --- */

test("matching is case- and diacritic-insensitive", () => {
  const spec: FilterSpec = { locationAny: ["munchen"] };
  for (const loc of ["München", "MÜNCHEN", "münchen", "Munchen", "MUNCHEN"]) {
    assert.equal(matches(posting({ location: loc }), spec), true, loc);
  }
  // A config written with the umlaut folds to the same needle.
  assert.equal(matches(posting({ location: "MÜNCHEN" }), { locationAny: ["München"] }), true);
});

test("ue-transliteration and translation are explicitly NOT handled", () => {
  // Documented boundary: these are separate config entries, not inferred. The
  // folding is diacritic-only -- guessing at either would make the config lie.
  assert.equal(matches(posting({ location: "Muenchen" }), { locationAny: ["munchen"] }), false);
  assert.equal(matches(posting({ location: "Munich" }), { locationAny: ["munchen"] }), false);
  // ...and adding both entries is all it takes.
  const spec: FilterSpec = { locationAny: ["münchen", "muenchen", "munich"] };
  for (const loc of ["München", "Muenchen", "Munich"]) {
    assert.equal(matches(posting({ location: loc }), spec), true, loc);
  }
});

test("normalise collapses punctuation and pads with spaces", () => {
  assert.equal(normalise("Werkstudent:in (m/w/d)"), " werkstudent in m w d ");
});

/* --------------------------------------------- German suffixes vs anchoring --- */

test("werkstudent matches gendered and punctuated forms", () => {
  const spec: FilterSpec = { titleAny: ["werkstudent"] };
  for (const title of [
    "Werkstudent (m/w/d)",
    "Werkstudent:in Softwareentwicklung",
    "WERKSTUDENT",
    "Werkstudentin Data Science",
    "Werkstudent*in",
    "Werkstudenten gesucht",
  ]) {
    assert.equal(matches(posting({ title }), spec), true, title);
  }
});

test("praktikum catches German compounds", () => {
  const spec: FilterSpec = { titleAny: ["praktikum"] };
  for (const title of ["Pflichtpraktikum Controlling", "Praktikum Marketing", "Auslandspraktikum"]) {
    assert.equal(matches(posting({ title }), spec), true, title);
  }
});

test("an unanchored `intern` is the false-positive trap", () => {
  // Kept as a test rather than a comment: this is why anchoring exists.
  const loose: FilterSpec = { titleAny: ["intern"] };
  assert.equal(matches(posting({ title: "International Sales Associate" }), loose), true);
  assert.equal(matches(posting({ title: "Internal Communications Manager" }), loose), true);
});

test("`|intern|` matches the word and nothing else", () => {
  const spec: FilterSpec = { titleAny: ["|intern|"] };
  assert.equal(matches(posting({ title: "Intern, Data Platform" }), spec), true);
  assert.equal(matches(posting({ title: "Software Engineering Intern" }), spec), true);
  assert.equal(matches(posting({ title: "Intern (f/m/x)" }), spec), true);
  assert.equal(matches(posting({ title: "International Sales Associate" }), spec), false);
  assert.equal(matches(posting({ title: "Internal Communications Manager" }), spec), false);
  assert.equal(matches(posting({ title: "Internship, Robotics" }), spec), false);
});

test("one-sided anchors pin a single edge", () => {
  // Leading: must start a word.
  const lead: FilterSpec = { titleAny: ["|intern"] };
  assert.equal(matches(posting({ title: "Internship, Robotics" }), lead), true);
  assert.equal(matches(posting({ title: "International Sales" }), lead), true);
  assert.equal(matches(posting({ title: "Winternship" }), lead), false);

  // Trailing: must end a word.
  const trail: FilterSpec = { titleAny: ["intern|"] };
  assert.equal(matches(posting({ title: "Data Science Intern" }), trail), true);
  assert.equal(matches(posting({ title: "Internal Auditor" }), trail), false);
});

test("the shipped example config keeps students and drops senior lookalikes", () => {
  const cfg = loadFilters(join(import.meta.dirname, "..", "config", "filters.example.json"));
  const spec = specFor(cfg, "greenhouse", "acme");
  const keep = [
    posting({ title: "Werkstudent:in Machine Learning", location: "München" }),
    posting({ title: "Pflichtpraktikum Data Analytics", location: "Berlin, Germany" }),
    posting({ title: "Masterand Robotics", location: "Stuttgart" }),
    posting({ title: "Intern, Platform Engineering", location: "Köln" }),
    posting({ title: "Working Student Backend", location: "Remote", remote: true }),
  ];
  const drop = [
    posting({ title: "Internal Communications Manager", location: "Berlin" }),
    posting({ title: "Senior Data Engineer", location: "Berlin" }),
    posting({ title: "Head of Internal Audit", location: "Berlin" }),
    posting({ title: "Werkstudent Vertrieb", location: "Wien, Österreich" }),
  ];
  for (const p of keep) assert.equal(matches(p, spec), true, p.title);
  for (const p of drop) assert.equal(matches(p, spec), false, p.title);
});

/* ---------------------------------------------------------------- remote --- */

test("remote: exclude drops board-flagged remote postings", () => {
  const spec: FilterSpec = { locationAny: ["deutschland"], remote: "exclude" };
  assert.equal(matches(posting({ remote: true }), spec), false);
  assert.equal(matches(posting({ remote: false }), spec), true);
  assert.equal(matches(posting({ remote: null }), spec), true);
});

test("remote: only keeps just the remote ones, location notwithstanding", () => {
  const spec: FilterSpec = { locationAny: ["deutschland"], remote: "only" };
  assert.equal(matches(posting({ remote: true, location: "Remote, EU" }), spec), true);
  assert.equal(matches(posting({ remote: false }), spec), false);
  assert.equal(matches(posting({ remote: null }), spec), false);
});

test("remote: include exempts a remote posting from the location list", () => {
  const spec: FilterSpec = { locationAny: ["deutschland"], remote: "include" };
  assert.equal(matches(posting({ remote: true, location: "Remote" }), spec), true);
  assert.equal(matches(posting({ remote: true, location: null }), spec), true);
  assert.equal(matches(posting({ remote: false, location: "Remote" }), spec), false);
  assert.equal(matches(posting({ remote: false }), spec), true);
});

test("with remote unset the location list is taken literally", () => {
  const spec: FilterSpec = { locationAny: ["deutschland"] };
  assert.equal(matches(posting({ remote: true, location: "Remote" }), spec), false);
});

/* ------------------------------------------------------------ maxAgeDays --- */

test("maxAgeDays rejects only postings the board says are old", () => {
  const day = 86_400_000;
  const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
  const spec: FilterSpec = { maxAgeDays: 30 };
  assert.equal(matches(posting({ postedAt: iso(5 * day) }), spec), true);
  assert.equal(matches(posting({ postedAt: iso(90 * day) }), spec), false);
});

test("a posting with no stated publish date is unknown, not old", () => {
  // Deliberate, and consistent with the rest of the system: `posted_at_exact`
  // exists precisely so an absent board date is treated as unknown rather than
  // trusted. Rejecting on absence would discard whole boards that never publish
  // one -- which is most of them.
  const spec: FilterSpec = { maxAgeDays: 30 };
  assert.equal(matches(posting({ postedAt: null }), spec), true);
  assert.equal(matches(posting({ postedAt: "not a date" }), spec), true);
});

/* ---------------------------------------------------------------- specFor --- */

test("specFor merges default, then kind:*, then kind:ident", () => {
  const cfg: FilterConfig = {
    default: { titleAny: ["werkstudent"], locationAny: ["deutschland"], maxAgeDays: 30 },
    perSource: {
      "greenhouse:*": { maxAgeDays: 14 },
      "greenhouse:acme": { locationAny: ["berlin"] },
    },
  };
  assert.deepEqual(specFor(cfg, "lever", "globex"), {
    titleAny: ["werkstudent"],
    locationAny: ["deutschland"],
    maxAgeDays: 30,
  });
  assert.deepEqual(specFor(cfg, "greenhouse", "other"), {
    titleAny: ["werkstudent"],
    locationAny: ["deutschland"],
    maxAgeDays: 14,
  });
  assert.deepEqual(specFor(cfg, "greenhouse", "acme"), {
    titleAny: ["werkstudent"],
    locationAny: ["berlin"],
    maxAgeDays: 14,
  });
});

test("an override narrows rather than widening", () => {
  const cfg: FilterConfig = {
    default: { locationAny: ["berlin", "hamburg", "munchen"] },
    perSource: { "greenhouse:acme": { locationAny: ["berlin"] } },
  };
  const spec = specFor(cfg, "greenhouse", "acme");
  assert.equal(matches(posting({ location: "Berlin" }), spec), true);
  // Would still pass if the arrays had been concatenated. They must not be.
  assert.equal(matches(posting({ location: "Hamburg" }), spec), false);
});

test("an override can clear an inherited requirement with an empty array", () => {
  const cfg: FilterConfig = {
    default: { locationAny: ["berlin"] },
    perSource: { "greenhouse:acme": { locationAny: [] } },
  };
  assert.equal(matches(posting({ location: "Tokyo" }), specFor(cfg, "greenhouse", "acme")), true);
});

test("specFor on an empty config is the pass-everything spec", () => {
  assert.deepEqual(specFor({}, "greenhouse", "acme"), {});
});

/* ------------------------------------------------------------- filterHash --- */

test("filterHash ignores key order, whitespace, casing and list order", () => {
  const a = JSON.parse(
    '{"titleAny":["Werkstudent","praktikum"],"locationAny":["Berlin"],"maxAgeDays":30}',
  ) as FilterSpec;
  const b = JSON.parse(
    '{ "maxAgeDays" : 30 ,\n  "locationAny" : [ " berlin " ] ,\n' +
      '  "titleAny" : [ "PRAKTIKUM" , "werkstudent" ] }',
  ) as FilterSpec;
  assert.equal(filterHash(a), filterHash(b));
});

test("filterHash treats absent and empty arrays alike", () => {
  assert.equal(filterHash({ titleAny: ["a"] }), filterHash({ titleAny: ["a"], titleNone: [] }));
  assert.equal(filterHash({}), filterHash({ titleAny: [], locationNone: [] }));
});

test("filterHash changes on any semantic change", () => {
  const base: FilterSpec = { titleAny: ["werkstudent"], locationAny: ["berlin"], remote: "include" };
  const h = filterHash(base);
  assert.notEqual(h, filterHash({ ...base, titleAny: ["werkstudent", "praktikum"] }));
  assert.notEqual(h, filterHash({ ...base, locationAny: ["hamburg"] }));
  assert.notEqual(h, filterHash({ ...base, remote: "exclude" }));
  assert.notEqual(h, filterHash({ ...base, maxAgeDays: 30 }));
  assert.notEqual(h, filterHash({ ...base, titleNone: ["senior"] }));
  // Anchoring is meaning, not cosmetics.
  assert.notEqual(filterHash({ titleAny: ["intern"] }), filterHash({ titleAny: ["|intern|"] }));
});

/* ------------------------------------------------------------ loadFilters --- */

test("loadFilters(null) and a missing file both mean no filtering", (t) => {
  assert.deepEqual(loadFilters(null), {});
  assert.deepEqual(loadFilters(join(tmpDir(t), "nope.json")), {});
  assert.deepEqual(specFor(loadFilters(null), "greenhouse", "acme"), {});
});

test("a malformed filter file throws and names the file", (t) => {
  const dir = tmpDir(t);
  const cases: Array<[string, string, RegExp]> = [
    ["trailing-comma.json", '{"default":{"titleAny":["a",]}}', /not valid JSON/],
    ["not-object.json", "[1,2,3]", /top level must be a JSON object/],
    ["bad-spec.json", '{"default":"werkstudent"}', /default must be an object/],
    ["bad-array.json", '{"default":{"titleAny":"werkstudent"}}', /titleAny must be an array/],
    ["bad-item.json", '{"default":{"titleAny":[1]}}', /titleAny must be an array/],
    ["bad-remote.json", '{"default":{"remote":"maybe"}}', /remote must be one of/],
    ["bad-age.json", '{"default":{"maxAgeDays":-3}}', /maxAgeDays must be a positive/],
    ["bad-per.json", '{"perSource":[]}', /perSource must be an object/],
    ["bad-key.json", '{"perSource":{"greenhouse":{}}}', /must look like/],
  ];
  for (const [name, body, re] of cases) {
    const path = join(dir, name);
    writeFileSync(path, body);
    assert.throws(() => loadFilters(path), (e: Error) => re.test(e.message) && e.message.includes(path), name);
  }
});

test("the shipped example config loads", () => {
  const cfg = loadFilters(join(import.meta.dirname, "..", "config", "filters.example.json"));
  assert.ok(cfg.default?.titleAny?.includes("werkstudent"));
  assert.ok(cfg.perSource && Object.keys(cfg.perSource).length > 0);
});

/* ================================================== poller: re-baselining === */

/*
 * These drive whole poll cycles against in-memory boards. No network, no LLM
 * (profilePath is null, which switches the fit scorer off entirely).
 */

function freshDb(t: { after(fn: () => void): void }): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "eve-filter-db-"));
  const db = openDb(join(dir, "radar.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    dbPath: ":memory:",
    discordToken: "x",
    discordChannelId: "x",
    digestThreshold: 5,
    pingTarget: "@here",
    profilePath: null,
    fitModel: "sonnet",
    fitThreshold: 75,
    freshHours: 48,
    fitBudget: 25,
    staleDays: 7,
    deadlineDays: 3,
    maxFailures: 5,
    massDelistRatio: 0.5,
    filtersPath: null,
    browserUseDir: null,
    browserUsePython: "python3",
    browserTimeoutMin: 10,
    ...over,
  };
}

/** An adapter serving whatever `board` currently points at. */
function fakeAdapter(board: () => FetchedPosting[]): Adapter {
  return {
    kind: "greenhouse",
    parse: () => null,
    fetch: async () => ({ postings: board(), etag: null }),
  };
}

const BOARD: FetchedPosting[] = [
  posting({ externalId: "1", title: "Werkstudent Data Engineering", url: "u1" }),
  posting({ externalId: "2", title: "Praktikum Marketing", url: "u2" }),
  posting({ externalId: "3", title: "Werkstudent Robotics", url: "u3" }),
];

function closureTypes(db: DatabaseSync): string[] {
  return pendingEvents(db, 100)
    .map((e) => e.type)
    .filter((t) => t === "posting_closed" || t === "vanished_while_claimed");
}

test("tightening a filter re-baselines: nothing closes, nothing is announced closed", async (t) => {
  const db = freshDb(t);
  const source = addSource(db, "greenhouse", "acme", "Acme") as SourceRow;
  const adapter = fakeAdapter(() => BOARD);

  // Cycle 1: no filter at all. First sight of the source, so this is itself a
  // re-baseline (stored hash is NULL) -- there is nothing to close yet anyway.
  const first = await pollSource(db, cfg(), source, adapter, {});
  assert.equal(first.rebaselined, true);
  assert.equal(first.filtered, 0);
  assert.equal(first.seen, 3);
  const hash0 = getFilterHash(db, source.id);
  assert.ok(hash0);

  // Cycle 2: the owner narrows the filter to Werkstudent roles. The Praktikum
  // posting is still open on the board, but it is now absent from the filtered
  // snapshot -- which without the re-baseline rule would read as a closure.
  const filters: FilterConfig = { default: { titleAny: ["werkstudent"] } };
  const second = await pollSource(db, cfg(), source, adapter, filters);
  assert.equal(second.rebaselined, true);
  assert.equal(second.filtered, 1);
  assert.equal(second.closed, 0);
  assert.deepEqual(closureTypes(db), [], "a filter change must emit no closure events");

  const rows = listPostingsForSource(db, source.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.state).sort(),
    ["open", "open", "open"],
    "the de-scoped posting stays open -- it was never closed by the company",
  );
  assert.notEqual(getFilterHash(db, source.id), hash0, "the new hash is stored");
});

test("a steady-state cycle with an unchanged filter closes normally", async (t) => {
  const db = freshDb(t);
  const source = addSource(db, "greenhouse", "acme", "Acme") as SourceRow;
  const filters: FilterConfig = { default: { titleAny: ["werkstudent"] } };
  let board = BOARD;
  const adapter = fakeAdapter(() => board);

  // Cycle 1 re-baselines on the NULL hash and stores it.
  const first = await pollSource(db, cfg(), source, adapter, filters);
  assert.equal(first.rebaselined, true);
  assert.equal(first.seen, 2, "only the two Werkstudent postings are tracked");
  assert.equal(first.filtered, 1);

  // Cycle 2: same filter, same board. Nothing to do, and crucially not a
  // re-baseline any more.
  const steady = await pollSource(db, cfg(), source, adapter, filters);
  assert.equal(steady.rebaselined, false);
  assert.equal(steady.closed, 0);

  // Cycle 3: the company actually delists one. Same filter, so the absence is
  // real and gets closed and announced.
  board = [BOARD[0]!];
  const third = await pollSource(db, cfg(), source, adapter, filters);
  assert.equal(third.rebaselined, false);
  assert.equal(third.closed, 1);
  assert.deepEqual(closureTypes(db), ["posting_closed"]);
  const closed = listPostingsForSource(db, source.id).filter((r) => r.state === "closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.title, "Werkstudent Robotics");
});

test("filtered-out postings are never stored, so they cost no scoring budget", async (t) => {
  const db = freshDb(t);
  const source = addSource(db, "greenhouse", "acme", "Acme") as SourceRow;
  const filters: FilterConfig = { default: { titleAny: ["praktikum"] } };
  const report = await pollSource(db, cfg(), source, fakeAdapter(() => BOARD), filters);
  assert.equal(report.filtered, 2);
  const rows = listPostingsForSource(db, source.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "Praktikum Marketing");
});

test("a re-baseline cycle is not refused by the mass-delist guard", async (t) => {
  // A tightening that drops most of a board looks exactly like a mass delisting.
  // If the guard ran, the cycle would be refused, the old hash would stay put,
  // and the source would re-refuse every cycle until it muted itself.
  const db = freshDb(t);
  const source = addSource(db, "greenhouse", "acme", "Acme") as SourceRow;
  const big = Array.from({ length: 10 }, (_, i) =>
    posting({ externalId: `${i}`, title: `Werkstudent Team ${i}`, url: `u${i}` }),
  );
  big.push(posting({ externalId: "x", title: "Praktikum Marketing", url: "ux" }));
  const adapter = fakeAdapter(() => big);

  await pollSource(db, cfg(), source, adapter, {});
  assert.equal(listPostingsForSource(db, source.id).length, 11);

  const report = await pollSource(db, cfg(), source, adapter, {
    default: { titleAny: ["praktikum"] },
  });
  assert.equal(report.skipped, false, "the guard must not refuse a re-baseline");
  assert.equal(report.rebaselined, true);
  assert.equal(report.filtered, 10);
  assert.equal(report.closed, 0);
  assert.deepEqual(closureTypes(db), []);
  assert.equal(
    listPostingsForSource(db, source.id).filter((r) => r.state === "open").length,
    11,
  );
});
