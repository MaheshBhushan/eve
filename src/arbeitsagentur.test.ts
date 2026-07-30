import { test } from "node:test";
import assert from "node:assert/strict";

import {
  arbeitsagentur,
  makeIdent,
  splitIdent,
  toPosting,
  MAX_RESULTS,
} from "./sources/arbeitsagentur.ts";

/* --------------------------------------------------------------- parse --- */

test("parses both prefixes and canonicalises equivalent spellings", () => {
  const forms = [
    "arbeitsagentur:werkstudent@berlin",
    "ARBEITSAGENTUR:Werkstudent@Berlin",
    "ba:Werkstudent @ berlin",
    "  ba:werkstudent@BERLIN  ",
    "ba:werkstudent  @  berlin",
  ];
  const idents = forms.map((f) => arbeitsagentur.parse(f)?.ident);
  // One search must be one ident: it is the SQLite uniqueness key.
  assert.deepEqual(new Set(idents), new Set(["ba:werkstudent@berlin"]));
});

test("radius, recency and nationwide forms", () => {
  assert.equal(arbeitsagentur.parse("arbeitsagentur:werkstudent@berlin+50")?.ident,
    "ba:werkstudent@berlin+50");
  assert.equal(arbeitsagentur.parse("ba:werkstudent")?.ident, "ba:werkstudent");
  assert.equal(arbeitsagentur.parse("ba:data science@münchen+25~7")?.ident,
    "ba:data science@münchen+25~7");
  // A radius without a location is meaningless and must not create a variant.
  assert.equal(arbeitsagentur.parse("ba:werkstudent+50")?.ident, "ba:werkstudent");
});

test("labels are human-readable", () => {
  assert.equal(arbeitsagentur.parse("ba:werkstudent@berlin+50")?.label,
    "Werkstudent · Berlin (50km)");
  assert.equal(arbeitsagentur.parse("ba:praktikum")?.label, "Praktikum · Deutschland");
  assert.equal(arbeitsagentur.parse("ba:werkstudent@berlin~7")?.label,
    "Werkstudent · Berlin · ≤7d");
});

test("returns null for unrecognised input instead of throwing", () => {
  for (const bad of [
    "",
    "werkstudent@berlin",
    "greenhouse:stripe",
    "https://boards.greenhouse.io/stripe",
    "arbeitsagentur:",
    "ba:@berlin",
    "bank:werkstudent",
  ]) {
    assert.equal(arbeitsagentur.parse(bad), null, bad);
  }
});

test("splitIdent round-trips and rejects foreign idents", () => {
  for (const ident of [
    "ba:werkstudent",
    "ba:werkstudent@berlin",
    "ba:werkstudent@berlin+50",
    "ba:data science@münchen+25~14",
  ]) {
    assert.equal(makeIdent(splitIdent(ident)), ident);
  }
  assert.deepEqual(splitIdent("ba:werkstudent@berlin+50"), {
    query: "werkstudent",
    location: "berlin",
    radius: 50,
    sinceDays: null,
  });
  for (const foreign of ["stripe", "greenhouse:stripe", "", "ba:"]) {
    assert.throws(() => splitIdent(foreign), /not an arbeitsagentur ident/);
  }
});

/* ------------------------------------------------------------- mapping --- */

const REAL = {
  beruf: "Architekt/in",
  titel: "  Werkstudent (m/w/d)  ",
  refnr: "13635-6bba649a_JB5203202-S",
  arbeitsort: {
    plz: "12099",
    ort: "Berlin",
    strasse: "null", // the literal string, not JSON null — see clean()
    region: "Berlin",
    land: "Deutschland",
  },
  arbeitgeber: "Westfalia Immobilienverwaltung GmbH",
  aktuelleVeroeffentlichungsdatum: "2026-07-23",
  modifikationsTimestamp: "2026-07-23T14:12:44.77",
  eintrittsdatum: "2026-07-23",
  externeUrl: "https://www.jobexport.de/job/5203202.html?exp=81",
};

test("maps a realistic record", () => {
  assert.deepEqual(toPosting(REAL), {
    externalId: "13635-6bba649a_JB5203202-S",
    title: "Werkstudent (m/w/d)",
    company: "Westfalia Immobilienverwaltung GmbH",
    // region equals the city, so it is not repeated
    location: "Berlin",
    remote: null,
    department: "Architekt/in",
    url: "https://www.jobexport.de/job/5203202.html?exp=81",
    postedAt: "2026-07-23",
    // eintrittsdatum is a start date, not an application deadline
    closesAt: null,
    description: null,
  });
});

test("builds the jobdetail URL when externeUrl is absent, and dirty values vanish", () => {
  const p = toPosting({
    ...REAL,
    externeUrl: undefined,
    arbeitgeber: "   ",
    arbeitsort: { ort: "Potsdam", region: "Brandenburg", strasse: "null", plz: "14467" },
  });
  assert.equal(
    p.url,
    "https://www.arbeitsagentur.de/jobsuche/jobdetail/13635-6bba649a_JB5203202-S",
  );
  // refnr contains `_` and `-`, which encodeURIComponent leaves intact
  assert.ok(!p.url.includes("%"));
  assert.equal(p.company, "unbekannt");
  assert.equal(p.location, "Potsdam, Brandenburg");
});

test("a \"null\" string is treated as absent everywhere", () => {
  const p = toPosting({
    ...REAL,
    beruf: "null",
    externeUrl: "null",
    aktuelleVeroeffentlichungsdatum: "null",
    arbeitsort: { ort: "null", region: "Bayern" },
  });
  assert.equal(p.department, null);
  assert.equal(p.postedAt, null);
  assert.equal(p.location, "Bayern");
  assert.ok(p.url.startsWith("https://www.arbeitsagentur.de/"));
});

test("a record without refnr is a hard error, not a posting with a blank id", () => {
  assert.throws(() => toPosting({ ...REAL, refnr: "null" }), /without refnr/);
});

/* --------------------------------------------------------------- fetch --- */

interface Stub {
  urls: string[];
}

/**
 * Monkey-patches globalThis.fetch. `pages` is keyed by the `page` query param;
 * any /jobdetails/ request answers with a description.
 */
function stubFetch(
  t: { after(fn: () => void): void },
  pages: Record<string, { stellenangebote?: unknown; maxErgebnisse?: number }>,
): Stub {
  const original = globalThis.fetch;
  const stub: Stub = { urls: [] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    stub.urls.push(url);
    const body = url.includes("/jobdetails/")
      ? { stellenangebotsBeschreibung: "Ihre Aufgaben\n • Digitalisierung" }
      : pages[new URL(url).searchParams.get("page") ?? "1"];
    if (!body) return new Response("", { status: 404, statusText: "Not Found" });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return stub;
}

const job = (n: number) => ({
  ...REAL,
  refnr: `REF-${n}`,
  titel: `Werkstudent ${n}`,
  externeUrl: `https://example.invalid/${n}`,
});

test("paginates, deduplicates a repeated refnr, and stops at the total", async (t) => {
  const stub = stubFetch(t, {
    // 101 distinct jobs spread over two pages, with REF-1 repeated on page 2 —
    // exactly what a re-ranked result set does mid-pagination.
    "1": { maxErgebnisse: 101, stellenangebote: Array.from({ length: 100 }, (_, i) => job(i)) },
    "2": { maxErgebnisse: 101, stellenangebote: [job(1), job(100)] },
  });

  const { postings, etag } = await arbeitsagentur.fetch("ba:werkstudent@berlin+25", null);
  assert.ok(postings);
  assert.equal(postings.length, 101);
  assert.equal(new Set(postings.map((p) => p.externalId)).size, 101);
  // This endpoint sends no ETag, and we do not invent one.
  assert.equal(etag, null);

  const searches = stub.urls.filter((u) => u.includes("/jobs?"));
  assert.equal(searches.length, 2, "stopped as soon as the total was reached");
  assert.ok(searches[0]!.includes("was=werkstudent"));
  assert.ok(searches[0]!.includes("wo=berlin"));
  assert.ok(searches[0]!.includes("umkreis=25"));
  assert.ok(searches[0]!.includes("size=100"));
});

test("sets veroeffentlichtseit when the ident carries a recency window", async (t) => {
  const stub = stubFetch(t, { "1": { maxErgebnisse: 1, stellenangebote: [job(1)] } });
  await arbeitsagentur.fetch("ba:werkstudent@berlin+25~7", null);
  assert.ok(stub.urls[0]!.includes("veroeffentlichtseit=7"));
});

test("fetches descriptions for a bounded number of postings only", async (t) => {
  const stub = stubFetch(t, {
    "1": { maxErgebnisse: 40, stellenangebote: Array.from({ length: 40 }, (_, i) => job(i)) },
  });
  const { postings } = await arbeitsagentur.fetch("ba:werkstudent@berlin", null);
  const details = stub.urls.filter((u) => u.includes("/jobdetails/"));
  assert.equal(details.length, 25, "per-cycle detail budget is enforced");
  const described = postings!.filter((p) => p.description !== null);
  assert.equal(described.length, 25);
  assert.match(described[0]!.description!, /Digitalisierung/);
});

test("a failing detail request costs a description, not the snapshot", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).includes("/jobdetails/")) throw new Error("boom");
    return new Response(
      JSON.stringify({ maxErgebnisse: 1, stellenangebote: [job(1)] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const { postings } = await arbeitsagentur.fetch("ba:werkstudent@berlin", null);
  assert.equal(postings!.length, 1);
  assert.equal(postings![0]!.description, null);
});

test("refuses an over-cap search instead of returning a truncated snapshot", async (t) => {
  const stub = stubFetch(t, {
    "1": { maxErgebnisse: 33487, stellenangebote: [job(1)] },
  });
  await assert.rejects(
    () => arbeitsagentur.fetch("ba:praktikum", null),
    (e: Error) => {
      assert.match(e.message, new RegExp(`exceeds the ${MAX_RESULTS} cap`));
      // The message has to tell the owner what to actually do about it.
      assert.match(e.message, /Narrow the search/);
      return true;
    },
  );
  // It bailed on page 1 rather than paginating 33k results.
  assert.equal(stub.urls.length, 1);
});

test("declares itself a complete source, because it throws rather than truncate", () => {
  assert.notEqual(arbeitsagentur.complete, false);
});

test("a shortfall against the stated total fails the poll", async (t) => {
  // The API promises 150 but page 2 comes back empty: a snapshot of 100 here
  // would look like 50 simultaneous closures.
  stubFetch(t, {
    "1": { maxErgebnisse: 150, stellenangebote: Array.from({ length: 100 }, (_, i) => job(i)) },
    "2": { maxErgebnisse: 150, stellenangebote: [] },
  });
  await assert.rejects(
    () => arbeitsagentur.fetch("ba:werkstudent@berlin", null),
    /collected 100 of 150/,
  );
});

test("a total that shrinks mid-pagination is tolerated", async (t) => {
  // Two ads were withdrawn while we paged; 100 of a now-100 set is complete.
  stubFetch(t, {
    "1": { maxErgebnisse: 102, stellenangebote: Array.from({ length: 100 }, (_, i) => job(i)) },
    "2": { maxErgebnisse: 100, stellenangebote: [] },
  });
  const { postings } = await arbeitsagentur.fetch("ba:werkstudent@berlin", null);
  assert.equal(postings!.length, 100);
});

test("end of results (no stellenangebote key) ends pagination cleanly", async (t) => {
  stubFetch(t, {
    "1": { maxErgebnisse: 150, stellenangebote: Array.from({ length: 100 }, (_, i) => job(i)) },
    "2": { maxErgebnisse: 100 },
  });
  const { postings } = await arbeitsagentur.fetch("ba:werkstudent@berlin", null);
  assert.equal(postings!.length, 100);
});

test("a malformed first page is an error", async (t) => {
  stubFetch(t, { "1": { maxErgebnisse: 5 } });
  await assert.rejects(
    () => arbeitsagentur.fetch("ba:werkstudent@berlin", null),
    /no stellenangebote array/,
  );
});
