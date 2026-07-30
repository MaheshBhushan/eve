import { test } from "node:test";
import assert from "node:assert/strict";

import { personio } from "./sources/personio.ts";
import { smartrecruiters } from "./sources/smartrecruiters.ts";

/* ------------------------------------------------------------- fetch stub --- */

interface StubRoute {
  /** HTTP status. 3xx exercises the Personio unknown-tenant path. */
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

const realFetch = globalThis.fetch;

/**
 * Route by substring match on the URL. Nothing here touches the network: an
 * unrouted URL fails the test loudly rather than escaping to the internet.
 */
function stubFetch(routes: Array<[string, StubRoute]>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`unstubbed fetch: ${url}`);
    const r = hit[1];
    const status = r.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: `stub ${status}`,
      headers: new Headers(r.headers ?? {}),
      text: async () => r.body ?? "",
      json: async () => JSON.parse(r.body ?? "null"),
    } as unknown as Response;
  }) as typeof fetch;
  return seen;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------- personio: parse --- */

test("personio: parses prefix and tenant-host URL forms", () => {
  const want = { kind: "personio", ident: "getquin", label: "getquin" };
  assert.deepEqual(personio.parse("personio:getquin"), want);
  assert.deepEqual(personio.parse("PERSONIO:GetQuin"), want);
  assert.deepEqual(personio.parse("getquin.jobs.personio.de"), want);
  assert.deepEqual(personio.parse("https://GetQuin.jobs.personio.de"), want);
  // some tenants sit on the .com host
  assert.deepEqual(personio.parse("https://getquin.jobs.personio.com/"), want);
  // deep link to a single position still resolves to the tenant
  assert.deepEqual(personio.parse("https://getquin.jobs.personio.de/job/12345?x=1"), want);
  // hyphenated slugs are common
  assert.deepEqual(personio.parse("personio:neura-robotics"), {
    kind: "personio",
    ident: "neura-robotics",
    label: "neura-robotics",
  });
});

test("personio: returns null for unrecognised input", () => {
  for (const bad of [
    "",
    "getquin",
    "greenhouse:stripe",
    "personio:",
    "https://jobs.personio.de/getquin",
    "https://getquin.jobs.personio.co.uk",
    "https://api.personio.de/v1/recruiting/positions",
  ]) {
    assert.equal(personio.parse(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------------------------------- personio: fetch --- */

const PERSONIO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
<position>
    <id>2375631</id>
    <office>M&#252;nchen</office>
    <department>Customer Success Management</department>
    <name>WerkstudentIn Customer Success Management (all genders)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Your tasks</name>
            <value><![CDATA[<ul><li>Support the CSM team</li><li>Own reporting &amp; QBRs</li></ul>]]></value>
        </jobDescription>
        <jobDescription>
            <name>Your profile</name>
            <value><![CDATA[<p>Enrolled student in M&#252;nchen</p>]]></value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>intern</employmentType>
    <schedule>part-time</schedule>
    <createdAt>2026-05-04T09:12:00+00:00</createdAt>
</position>
</workzag-jobs>`;

const PERSONIO_JSON = JSON.stringify([
  {
    id: 2375631,
    name: "WerkstudentIn Customer Success Management (all genders)",
    office: "München",
    offices: ["München"],
    department: "Customer Success Management",
    schedule: "Voll- oder Teilzeit",
    employment_type: "Praktikum/Werkstudium",
    description: "",
  },
  {
    // Present in JSON only -- the XML feed omits it. Must still appear in the
    // snapshot, or the poller would read it as a closure.
    id: 2421955,
    name: "Praktikum Inside Sales (all genders)",
    office: "Berlin HQ,Remote",
    offices: ["Berlin HQ", "Remote"],
    department: "Sales",
    description: "",
  },
]);

test("personio: maps a realistic record, stripping HTML from the XML JD", async () => {
  stubFetch([
    ["/xml", { body: PERSONIO_XML, headers: { etag: '"x1"' } }],
    ["/search.json", { body: PERSONIO_JSON, headers: { etag: '"j1"' } }],
  ]);

  const { postings } = await personio.fetch("getquin", null);
  assert.ok(postings);
  assert.equal(postings.length, 2);

  const ws = postings.find((p) => p.externalId === "2375631")!;
  assert.equal(ws.title, "WerkstudentIn Customer Success Management (all genders)");
  assert.equal(ws.company, "getquin"); // no company name in either feed
  assert.equal(ws.location, "München");
  assert.equal(ws.remote, false);
  assert.equal(ws.department, "Customer Success Management");
  assert.equal(ws.url, "https://getquin.jobs.personio.de/job/2375631");
  assert.equal(ws.postedAt, "2026-05-04T09:12:00+00:00");
  assert.equal(ws.closesAt, null);

  // Section headings kept, markup and entities gone.
  assert.ok(ws.description);
  assert.match(ws.description, /Your tasks/);
  assert.match(ws.description, /- Support the CSM team/);
  assert.match(ws.description, /Own reporting & QBRs/);
  assert.match(ws.description, /Enrolled student in München/);
  assert.doesNotMatch(ws.description, /<[a-z]/i);
  assert.doesNotMatch(ws.description, /CDATA|&amp;|&#/);
});

test("personio: JSON-only posting yields postedAt null and multi-office location", async () => {
  stubFetch([
    ["/xml", { body: PERSONIO_XML }],
    ["/search.json", { body: PERSONIO_JSON }],
  ]);

  const { postings } = await personio.fetch("getquin", null);
  const p = postings!.find((x) => x.externalId === "2421955")!;
  // The JSON feed states no date; synthesising one would poison the freshness
  // alert, so null is the required answer.
  assert.equal(p.postedAt, null);
  assert.equal(p.description, null); // JSON `description` is always ""
  assert.equal(p.location, "Berlin HQ, Remote");
  assert.equal(p.remote, true);
});

test("personio: a live tenant with an empty XML feed still returns its postings", async () => {
  // Verified against `sunhat` and `fintiba`: /xml answers 200 with zero bytes
  // while /search.json lists roles normally.
  stubFetch([
    ["/xml", { body: "" }],
    ["/search.json", { body: PERSONIO_JSON }],
  ]);

  const { postings } = await personio.fetch("sunhat", null);
  assert.equal(postings!.length, 2);
  assert.deepEqual(
    postings!.map((p) => p.postedAt),
    [null, null],
  );
});

test("personio: an unknown tenant redirects and must throw", async () => {
  // Real behaviour: HTTP 307 -> https://personio.com. Following it lands on a
  // marketing page that answers 200, which would register a dead board.
  stubFetch([
    ["/xml", { status: 307, headers: { location: "https://personio.com" } }],
    ["/search.json", { status: 307, headers: { location: "https://personio.com" } }],
  ]);

  await assert.rejects(() => personio.fetch("gitpod", null), /does not exist/);
});

test("personio: a non-array search.json body throws rather than reading as empty", async () => {
  stubFetch([
    ["/xml", { body: "" }],
    ["/search.json", { body: '{"error":"nope"}' }],
  ]);
  await assert.rejects(() => personio.fetch("broken", null), /positions array/);
});

/* -------------------------------------------------- smartrecruiters: parse --- */

test("smartrecruiters: parses prefix and both careers-host URL forms", () => {
  const want = {
    kind: "smartrecruiters",
    ident: "boschgroup",
    label: "boschgroup",
  };
  assert.deepEqual(smartrecruiters.parse("smartrecruiters:boschgroup"), want);
  // the API is case-insensitive, so the canonical BoschGroup spelling folds down
  assert.deepEqual(smartrecruiters.parse("SmartRecruiters:BoschGroup"), want);
  assert.deepEqual(smartrecruiters.parse("jobs.smartrecruiters.com/BoschGroup"), want);
  assert.deepEqual(
    smartrecruiters.parse("https://careers.smartrecruiters.com/BoschGroup"),
    want,
  );
  assert.deepEqual(
    smartrecruiters.parse("https://jobs.smartrecruiters.com/BoschGroup/744000140564169-x"),
    want,
  );
});

test("smartrecruiters: returns null for unrecognised input", () => {
  for (const bad of [
    "",
    "boschgroup",
    "lever:spotify",
    "smartrecruiters:",
    "https://api.smartrecruiters.com/v1/companies/boschgroup/postings",
    "https://jobs.smartrecruiters.example.com/boschgroup",
  ]) {
    assert.equal(
      smartrecruiters.parse(bad),
      null,
      `expected null for ${JSON.stringify(bad)}`,
    );
  }
});

/* -------------------------------------------------- smartrecruiters: fetch --- */

function srPosting(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Werkstudent Data ${id}`,
    company: { identifier: "BoschGroup", name: "Bosch Group" },
    releasedDate: "2026-06-01T08:00:00.000Z",
    location: { city: "Stuttgart", region: "", country: "de", remote: false },
    department: {},
    function: { label: "Engineering" },
    ...extra,
  };
}

function srPage(offset: number, total: number, ids: string[]) {
  return JSON.stringify({
    offset,
    limit: 100,
    totalFound: total,
    content: ids.map((id) => srPosting(id)),
  });
}

test("smartrecruiters: maps a realistic record and strips the detail-page JD", async () => {
  stubFetch([
    [
      "/postings/1001",
      {
        body: JSON.stringify({
          jobAd: {
            sections: {
              additionalInformation: { text: "<p>Start: flexibel</p>" },
              jobDescription: { text: "<p>Du unterst&#252;tzt das Team.</p>" },
              qualifications: { text: "<ul><li>Immatrikuliert</li></ul>" },
            },
          },
        }),
      },
    ],
    ["/postings?", { body: srPage(0, 1, ["1001"]) }],
  ]);

  const { postings } = await smartrecruiters.fetch("boschgroup", null);
  assert.equal(postings!.length, 1);
  const p = postings![0]!;
  assert.equal(p.externalId, "1001");
  assert.equal(p.company, "Bosch Group"); // board's own name beats the slug
  // fullLocation would have been "Stuttgart, , Germany"; parts are rebuilt and
  // the lowercase ISO country code uppercased.
  assert.equal(p.location, "Stuttgart, DE");
  assert.equal(p.remote, false);
  assert.equal(p.department, "Engineering"); // department {} falls back to function
  assert.equal(p.url, "https://jobs.smartrecruiters.com/boschgroup/1001");
  assert.equal(p.postedAt, "2026-06-01T08:00:00.000Z");

  // Sections concatenated in a fixed order, HTML and entities stripped.
  assert.equal(
    p.description,
    "Du unterstützt das Team.\n\n- Immatrikuliert\n\nStart: flexibel",
  );
});

test("smartrecruiters: a posting with no releasedDate yields postedAt null", async () => {
  stubFetch([
    [
      "/postings?",
      {
        body: JSON.stringify({
          offset: 0,
          limit: 100,
          totalFound: 1,
          content: [srPosting("2002", { releasedDate: null })],
        }),
      },
    ],
  ]);

  const { postings } = await smartrecruiters.fetch("boschgroup", null);
  assert.equal(postings![0]!.postedAt, null);
  // No stated date means it is not a description-budget candidate either, so no
  // detail request is made -- the stub would have thrown on an unrouted URL.
  assert.equal(postings![0]!.description, null);
});

test("smartrecruiters: paginates to totalFound across pages", async () => {
  const ids = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => String(from + i));
  const seen = stubFetch([
    ["offset=0", { body: srPage(0, 250, ids(0, 100)) }],
    ["offset=100", { body: srPage(100, 250, ids(100, 100)) }],
    ["offset=200", { body: srPage(200, 250, ids(200, 50)) }],
    ["/postings/", { body: "{}" }], // description lookups, budgeted
  ]);

  const { postings } = await smartrecruiters.fetch("boschgroup", null);
  assert.equal(postings!.length, 250);
  assert.equal(new Set(postings!.map((p) => p.externalId)).size, 250);
  assert.equal(seen.filter((u) => u.includes("offset=")).length, 3);
  // The JD budget is a hard cap, not a per-posting cost.
  assert.equal(seen.filter((u) => /\/postings\/\d+$/.test(u)).length, 25);
});

test("smartrecruiters: throws on a truncated walk instead of a partial snapshot", async () => {
  stubFetch([
    ["offset=0", { body: srPage(0, 250, Array.from({ length: 100 }, (_, i) => String(i))) }],
    // Board stops talking: an empty page while 150 postings are still missing.
    ["offset=100", { body: srPage(100, 250, []) }],
  ]);

  await assert.rejects(
    () => smartrecruiters.fetch("boschgroup", null),
    /truncated: got 100 of 250/,
  );
});

test("smartrecruiters: throws when a later page errors", async () => {
  stubFetch([
    ["offset=0", { body: srPage(0, 250, Array.from({ length: 100 }, (_, i) => String(i))) }],
    ["offset=100", { status: 502 }],
  ]);

  await assert.rejects(() => smartrecruiters.fetch("boschgroup", null), /HTTP 502/);
});

test("smartrecruiters: an unknown company throws despite HTTP 200", async () => {
  // The trap: an unknown slug returns 200 with totalFound 0, byte-identical to a
  // real customer with nothing open. Only the careers-site 404 distinguishes them.
  const seen = stubFetch([
    ["/postings?", { body: srPage(0, 0, []) }],
    ["/api/groups", { status: 404 }],
  ]);

  await assert.rejects(
    () => smartrecruiters.fetch("nonexistentslug99xyz", null),
    /does not exist/,
  );
  assert.ok(seen.some((u) => u.includes("/api/groups")));
});

test("smartrecruiters: a real company with nothing open returns an empty snapshot", async () => {
  stubFetch([
    ["/postings?", { body: srPage(0, 0, []) }],
    ["/api/groups", { body: "[]" }],
  ]);

  const { postings } = await smartrecruiters.fetch("lidl", null);
  assert.deepEqual(postings, []);
});
