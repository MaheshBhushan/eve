import { test } from "node:test";
import assert from "node:assert/strict";

import { isoDate } from "./sources/index.ts";
import { parseFeed } from "./sources/rss.ts";
import { parseWeworkRemotely, weworkremotely } from "./sources/weworkremotely.ts";
import { parseRemoteOk, remoteok } from "./sources/remoteok.ts";
import { parseWorkingNomads, workingnomads } from "./sources/workingnomads.ts";
import { himalayas, parseHimalayasPage } from "./sources/himalayas.ts";
import { arbeitnow, parseArbeitnowPage } from "./sources/arbeitnow.ts";
import { ADAPTERS, parseRef } from "./sources/registry.ts";

/*
 * Fixtures are trimmed, sanitized samples of the live responses observed on
 * 2026-09-22 (see docs/research/job-source-observations.json). They are small
 * on purpose: the interesting behaviour is in shape handling — namespaced tags,
 * CDATA, metadata rows, epoch-vs-ISO dates, blank locations — not in volume.
 */

async function withFetch<T>(
  handler: (url: string) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input) =>
    handler(String(input))) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------ date norm --- */

test("isoDate normalizes seconds, milliseconds and ISO; rejects nonsense", () => {
  const expected = new Date(1790080189 * 1000).toISOString();
  assert.equal(isoDate(1790080189), expected, "unix seconds");
  assert.equal(isoDate("1790080189"), expected, "unix seconds as string");
  assert.equal(isoDate(1790080189000), expected, "unix milliseconds");
  assert.equal(isoDate("2026-09-22T11:13:20+00:00"), "2026-09-22T11:13:20.000Z", "ISO");
  assert.equal(isoDate("Tue, 22 Sep 2026 11:13:20 +0000"), "2026-09-22T11:13:20.000Z", "RFC 2822");
  assert.equal(isoDate(null), null);
  assert.equal(isoDate("not a date"), null);
  assert.equal(isoDate(0), null, "epoch zero is not a publish date");
  assert.equal(isoDate(1_700_000_000_000_000), null, "out-of-range magnitudes are unknown");
});

/* ------------------------------------------------------------------ RSS --- */

function rssItem(inner: string): string {
  return `<item>${inner}</item>`;
}

function rss(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Test feed</title>${inner}</channel></rss>`;
}

test("rss: namespaces, content:encoded, CDATA and single-vs-array categories survive", () => {
  const feed = parseFeed(
    rss(
      rssItem(`
        <media:content url="https://example.test/logo.png" type="image/png"/>
        <title>One category</title>
        <category>Back-End</category>
        <content:encoded><![CDATA[<p>Body from encoded</p>]]></content:encoded>
      `) +
        rssItem(`
        <title>Two categories</title>
        <category>DevOps</category>
        <category>Sysadmin</category>
        <description><![CDATA[<p>Body in CDATA description</p>]]></description>
      `),
    ),
  );

  assert.equal(feed.title, "Test feed");
  assert.equal(feed.items.length, 2);
  assert.deepEqual(feed.items[0]!.categories, ["Back-End"]);
  assert.deepEqual(feed.items[1]!.categories, ["DevOps", "Sysadmin"]);
  assert.equal(feed.items[0]!.description, "<p>Body from encoded</p>");
  assert.equal(feed.items[1]!.description, "<p>Body in CDATA description</p>");
  // Attribute-only extension elements must not leak into the tag map.
  assert.equal(feed.items[0]!.tags.content, undefined);
});

test("rss: a missing pubDate stays unknown and is never substituted", () => {
  const feed = parseFeed(rss(rssItem("<title>Undated</title>")));
  assert.equal(feed.items[0]!.pubDate, null);
});

test("rss: a feed over the item cap fails explicitly instead of truncating", () => {
  const items = Array.from({ length: 5_001 }, (_, i) => rssItem(`<title>Job ${i}</title>`));
  assert.throws(() => parseFeed(rss(items.join(""))), /over the 5000 cap/);
});

test("rss: a DTD entity bomb is refused outright", () => {
  const levels = ["<!ENTITY a \"aaaaaaaaaa\">"];
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  for (let i = 1; i < names.length; i++) {
    const prev = names[i - 1]!;
    levels.push(`<!ENTITY ${names[i]!} "${Array.from({ length: 10 }, () => `&${prev};`).join("")}">`);
  }
  const bomb = `<?xml version="1.0"?><!DOCTYPE bomb [${levels.join("")}]>
<rss><channel>${rssItem("<title>&h;</title>")}</channel></rss>`;
  assert.throws(() => parseFeed(bomb), /DOCTYPE/);
});

test("rss: numeric character references are decoded in titles", () => {
  const feed = parseFeed(rss(rssItem("<title>Werkstudent M&#252;nchen</title>")));
  assert.equal(feed.items[0]!.title, "Werkstudent München");
});

test("rss: HTML at a feed URL is a parse error, not an empty feed", () => {
  assert.throws(() => parseFeed("<html><body>Sign in</body></html>"));
});

/* ------------------------------------------------------------------ WWR --- */

const WWR_XML = rss(
  rssItem(`
    <media:content url="https://example.test/logo.png" type="image/png"/>
    <title>Acme GmbH: Backend Engineer (Python)</title>
    <region>Anywhere in the World</region>
    <country>Germany</country>
    <state></state>
    <skills>python,django</skills>
    <category>Back-End Programming</category>
    <type>Full-Time</type>
    <description>&lt;p&gt;Build &amp;amp; ship APIs.&lt;/p&gt;</description>
    <pubDate>Tue, 22 Sep 2026 11:13:20 +0000</pubDate>
    <expires_at>Thu, 22 Oct 2026 11:13:20 +0000</expires_at>
    <guid>https://weworkremotely.com/remote-jobs/acme-backend-engineer</guid>
    <link>https://weworkremotely.com/remote-jobs/acme-backend-engineer</link>
  `) +
    rssItem(`
    <title>Support Engineer</title>
    <region>North America Only</region>
    <country>United States of America</country>
    <description><![CDATA[<p>Help customers</p>]]></description>
    <guid>https://weworkremotely.com/remote-jobs/support-engineer</guid>
    <link>https://weworkremotely.com/remote-jobs/support-engineer</link>
  `),
);

test("WWR: splits Company: Role, keeps restriction evidence and expiry", () => {
  const [first, second] = parseWeworkRemotely(WWR_XML);
  assert.equal(first!.externalId, "https://weworkremotely.com/remote-jobs/acme-backend-engineer");
  assert.equal(first!.company, "Acme GmbH");
  assert.equal(first!.title, "Backend Engineer (Python)");
  assert.equal(first!.location, "Germany, Anywhere in the World");
  assert.equal(first!.remote, true);
  assert.equal(first!.department, "Back-End Programming");
  assert.equal(first!.postedAt, "2026-09-22T11:13:20.000Z");
  assert.equal(first!.closesAt, "2026-10-22T11:13:20.000Z");
  assert.equal(first!.description, "Build & ship APIs.");

  // No colon: the whole string is the title and no invented employer is split off.
  assert.equal(second!.company, "Unknown employer");
  assert.equal(second!.title, "Support Engineer");
  assert.equal(second!.location, "United States of America, North America Only");
  assert.equal(second!.postedAt, null, "no pubDate stays unknown");
});

test("WWR: a valid feed with zero items is an empty window, not an error", () => {
  assert.deepEqual(parseWeworkRemotely(rss("")), []);
});

test("WWR: an itemless-but-nonempty feed that cannot parse throws", () => {
  const garbage = rss(rssItem("<region>Nowhere</region>"));
  assert.throws(() => parseWeworkRemotely(garbage), /none parsed/);
});

test("WWR: adapter is incomplete and honours a 304", async () => {
  assert.equal(weworkremotely.complete, false);
  assert.equal(weworkremotely.domain?.("all"), "weworkremotely.com");
  await withFetch(
    () => new Response(null, { status: 304 }),
    async () => {
      const result = await weworkremotely.fetch("all", 'W/"x"');
      assert.equal(result.postings, null, "304 is not-modified");
    },
  );
});

/* ------------------------------------------------------------- Remote OK --- */

test("Remote OK: the metadata row never becomes a job", () => {
  const payload = [
    { last_updated: 1790067601, legal: "API terms: link back to Remote OK" },
    {
      id: "1137411",
      slug: "senior-net-engineer-1137411",
      epoch: 1789862431,
      date: "2026-09-20T00:00:31+00:00",
      company: "OkWhen",
      position: "Senior .NET Software Engineer",
      description: "<p>Do the thing</p>",
      location: "",
      url: "https://remoteok.com/remote-jobs/remote-senior-net-engineer-1137411",
      apply_url: "https://remoteok.com/remote-jobs/remote-senior-net-engineer-1137411",
    },
    {
      id: 1137410,
      epoch: 1789862431,
      company: "Bjak",
      position: "Frontend Engineer",
      description: "<p>React</p>",
      location: "Ireland",
      apply_url: "https://remoteok.com/remote-jobs/frontend-engineer-1137410",
    },
  ];

  const postings = parseRemoteOk(payload);
  assert.equal(postings.length, 2, "metadata row is filtered structurally");
  assert.equal(postings[0]!.externalId, "1137411");
  assert.equal(postings[0]!.location, null, "blank location is unknown, not 'Remote'");
  assert.equal(postings[0]!.postedAt, "2026-09-20T00:00:31.000Z");
  assert.equal(postings[1]!.externalId, "1137410", "numeric id is stringified");
  assert.equal(postings[1]!.postedAt, new Date(1789862431 * 1000).toISOString(), "epoch fallback");
  assert.equal(postings[1]!.url, "https://remoteok.com/remote-jobs/frontend-engineer-1137410");
});

test("Remote OK: a non-array body throws", () => {
  assert.throws(() => parseRemoteOk({ jobs: [] }), /expected a JSON array/);
});

test("Remote OK: HTML served at the API endpoint is an error", async () => {
  await withFetch(
    () => new Response("<html>blocked</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      await assert.rejects(() => remoteok.fetch("all", null), /expected JSON/);
    },
  );
});

/* ------------------------------------------------------- Working Nomads --- */

test("Working Nomads: source URL is the identity and restrictions are preserved", () => {
  const payload = [
    {
      url: "https://www.workingnomads.com/job/go/1880339/",
      title: "Virtual Bookkeeper",
      description: "<p>Books</p>",
      company_name: "Strong Roots Accounting",
      category_name: "Finance",
      tags: "bookkeeping,quickbooks",
      location: "Anywhere in the world",
      pub_date: "2026-09-22T02:36:00-04:00",
    },
    { url: "https://www.workingnomads.com/job/go/1/", title: "", company_name: "Broken" },
  ];

  const postings = parseWorkingNomads(payload);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]!.externalId, "https://www.workingnomads.com/job/go/1880339/");
  assert.equal(postings[0]!.department, "Finance");
  assert.equal(postings[0]!.postedAt, "2026-09-22T06:36:00.000Z", "offset normalized to UTC");
  assert.equal(postings[0]!.remote, true);
});

test("Working Nomads: a non-array body throws", () => {
  assert.throws(() => parseWorkingNomads({ jobs: [] }), /expected a JSON array/);
});

/* ---------------------------------------------------------------- Himalayas --- */

function himalayasJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid: "https://himalayas.app/companies/acme/jobs/backend-1",
    title: "Backend Engineer",
    companyName: "Acme",
    description: "<p>Build things</p>",
    applicationLink: "https://himalayas.app/companies/acme/jobs/backend-1",
    locationRestrictions: ["Germany"],
    timezoneRestrictions: [1],
    categories: ["Engineering"],
    pubDate: 1790080189,
    expiryDate: 1795264188,
    ...over,
  };
}

test("Himalayas: seconds-scale pubDate, restrictions and cursor survive", () => {
  const page = parseHimalayasPage({
    jobs: [himalayasJob()],
    nextCursor: "MjAyNi0wOS0yMlQxMTow",
    totalCount: 103940,
  });
  assert.equal(page.nextCursor, "MjAyNi0wOS0yMlQxMTow");
  const job = page.postings[0]!;
  assert.equal(job.postedAt, new Date(1790080189 * 1000).toISOString(), "seconds, not milliseconds");
  assert.equal(job.closesAt, new Date(1795264188 * 1000).toISOString());
  assert.equal(job.location, "Germany · UTC +1");
});

test("Himalayas: ISO and millisecond dates both normalize; empty restrictions say Worldwide", () => {
  const page = parseHimalayasPage({
    jobs: [
      himalayasJob({ pubDate: "2026-09-22T11:13:20Z", locationRestrictions: [], timezoneRestrictions: [] }),
      himalayasJob({ guid: "2", pubDate: 1790080189000, locationRestrictions: ["India", "United Kingdom"], timezoneRestrictions: [-5, 5.5] }),
    ],
    nextCursor: null,
  });
  assert.equal(page.postings[0]!.postedAt, "2026-09-22T11:13:20.000Z");
  assert.equal(page.postings[0]!.location, "Worldwide");
  assert.equal(page.postings[1]!.postedAt, new Date(1790080189000).toISOString());
  assert.equal(page.postings[1]!.location, "India, United Kingdom · UTC -5, +5.5");
});

test("Himalayas: missing or malformed restrictions stay unknown, never Worldwide", () => {
  // The field is absent entirely: unknown eligibility, not open to everyone.
  const missing = parseHimalayasPage({ jobs: [himalayasJob({ locationRestrictions: undefined, timezoneRestrictions: undefined })] });
  assert.equal(missing.postings[0]!.location, null, "no restriction evidence at all is null");

  // Countries absent but time zones stated: the country claim is explicitly
  // unknown, the zone claim is kept.
  const countriesMissing = parseHimalayasPage({
    jobs: [himalayasJob({ locationRestrictions: undefined, timezoneRestrictions: [1] })],
  });
  assert.equal(countriesMissing.postings[0]!.location, "Hiring countries not stated · UTC +1");

  // A country entry that cannot be read invalidates the whole list: dropping it
  // and keeping the rest would understate a restriction.
  const badEntry = parseHimalayasPage({
    jobs: [himalayasJob({ locationRestrictions: ["Germany", { name: "United States" }] })],
  });
  assert.equal(badEntry.postings[0]!.location, "Hiring countries not stated · UTC +1");

  // A string time-zone offset is evidence and must be kept, not discarded.
  const stringZones = parseHimalayasPage({
    jobs: [himalayasJob({ locationRestrictions: [], timezoneRestrictions: ["UTC+05:30"] })],
  });
  assert.equal(stringZones.postings[0]!.location, "Worldwide · UTC UTC+05:30");

  // Empty but valid arrays are the one spelling that means unrestricted.
  const empty = parseHimalayasPage({ jobs: [himalayasJob({ locationRestrictions: [], timezoneRestrictions: [] })] });
  assert.equal(empty.postings[0]!.location, "Worldwide");
});

test("Himalayas: jobs present but none usable throws instead of returning zero jobs", () => {
  assert.throws(() => parseHimalayasPage({ jobs: [{ title: "No guid" }] }), /none usable/);
  assert.throws(() => parseHimalayasPage({}), /no jobs array/);
});

test("Himalayas: walks pages by cursor, stops on repeat, never trusts a looping provider", async () => {
  const requested: string[] = [];
  await withFetch(
    (url) => {
      requested.push(url);
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) {
        return Response.json({ jobs: [himalayasJob()], nextCursor: "cursor-1", totalCount: 3 });
      }
      if (cursor === "cursor-1") {
        return Response.json({ jobs: [himalayasJob({ guid: "2", title: "Second" })], nextCursor: "cursor-1", totalCount: 3 });
      }
      return Response.json({ jobs: [], nextCursor: null });
    },
    async () => {
      const result = await himalayas.fetch("all", null);
      assert.equal(result.postings?.length, 2);
      assert.equal(requested.length, 2, "a repeated cursor must stop the walk");
      assert.match(requested[0]!, /limit=20/);
      assert.match(requested[1]!, /cursor=cursor-1/);
    },
  );
});

test("Himalayas: the head walk stops at the previous watermark and the background walk resumes", async () => {
  const cursor = JSON.stringify({ wm: 1790080189, bg: "bg-1" });
  const requested: string[] = [];
  await withFetch(
    (url) => {
      requested.push(url);
      const c = new URL(url).searchParams.get("cursor");
      if (c === "bg-1") {
        return Response.json({
          jobs: [himalayasJob({ guid: "bg-job", title: "Historical", pubDate: 1700000000 })],
          nextCursor: "bg-2",
        });
      }
      if (c === "bg-2") {
        return Response.json({
          jobs: [himalayasJob({ guid: "bg-job-2", title: "Older still", pubDate: 1600000000 })],
          nextCursor: null,
        });
      }
      // Head page: one new job, plus one older than the watermark on the same
      // page — the walk must stop after this page instead of re-walking history.
      return Response.json({
        jobs: [
          himalayasJob({ guid: "new", title: "New", pubDate: 1790089999 }),
          himalayasJob({ guid: "old", title: "Old", pubDate: 1790080188 }),
        ],
        nextCursor: "head-2",
      });
    },
    async () => {
      const result = await himalayas.fetch("all", null, cursor);
      assert.equal(requested.length, 3, "one head page, then two resumed background pages");
      assert.match(requested[0]!, /limit=20/);
      assert.doesNotMatch(requested[0]!, /cursor=/);
      assert.match(requested[1]!, /cursor=bg-1/, "the background walk resumes from the stored cursor");
      assert.match(requested[2]!, /cursor=bg-2/);
      assert.equal(result.postings?.length, 4);
      const state = JSON.parse(result.cursor!);
      assert.equal(state.wm, 1790089999, "the watermark advances to the newest seen");
      assert.equal(state.bg, null, "a completed background walk clears its cursor");
    },
  );
});

test("Himalayas: a finished background walk clears its cursor", async () => {
  const cursor = JSON.stringify({ wm: 1790089999, bg: "bg-last" });
  await withFetch(
    (url) => {
      const c = new URL(url).searchParams.get("cursor");
      if (c === "bg-last") {
        return Response.json({ jobs: [himalayasJob({ guid: "tail", pubDate: 1600000000 })], nextCursor: null });
      }
      // Everything on the head page predates the watermark, so the head walk
      // stops immediately.
      return Response.json({ jobs: [himalayasJob({ guid: "known", pubDate: 1790080188 })], nextCursor: "head-2" });
    },
    async () => {
      const result = await himalayas.fetch("all", null, cursor);
      assert.equal(JSON.parse(result.cursor!).bg, null, "the next walk starts from the head");
    },
  );
});

test("Himalayas: the first run caps the head grab and hands off to the background walk", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Response.json({
        jobs: [himalayasJob({ guid: `job-${calls}`, pubDate: 1790080189 - calls })],
        nextCursor: `c${calls}`,
      });
    },
    async () => {
      const result = await himalayas.fetch("all", null, null);
      // FIRST_HEAD_PAGES (5) head pages, then MAX_BG_PAGES (25) background pages.
      assert.equal(calls, 30, "both walks are bounded");
      assert.equal(JSON.parse(result.cursor!).bg, "c30", "the walk is resumable");
    },
  );
});

/* ---------------------------------------------------------------- Arbeitnow --- */

function arbeitnowPage(jobs: unknown[], next: string | null = null): Response {
  return Response.json({ data: jobs, links: { next }, meta: { per_page: 250 } });
}

test("Arbeitnow: epoch seconds, double-escaped HTML and a blank location stays unknown", () => {
  const page = parseArbeitnowPage(
    {
      data: [
        {
          slug: "backend-berlin-1",
          company_name: "Acme GmbH",
          title: "Backend Engineer",
          description: "<p>Python</p>",
          remote: false,
          url: "https://www.arbeitnow.com/jobs/companies/acme/backend-berlin-1",
          tags: ["Software Development"],
          job_types: ["berufserfahren"],
          location: "Berlin",
          created_at: 1790082027,
        },
      ],
      links: { next: "https://www.arbeitnow.com/api/job-board-api?page=2" },
    },
    "de",
  );
  const job = page.postings[0]!;
  assert.equal(job.postedAt, new Date(1790082027 * 1000).toISOString());
  assert.equal(job.department, "Software Development");
  assert.equal(job.description, "Python");
  assert.equal(page.next, "https://www.arbeitnow.com/api/job-board-api?page=2");

  const uk = parseArbeitnowPage(
    {
      data: [
        {
          slug: "uk-role-2",
          company_name: "Scopely",
          title: "Production Director",
          description: "&lt;p&gt;Games&lt;/p&gt;",
          remote: false,
          url: "https://www.arbeitnow.co.uk/jobs/companies/scopely/production-director",
          tags: [],
          job_types: [],
          location: "",
          created_at: 1790081714,
        },
      ],
      links: { next: null },
    },
    "uk",
  );
  assert.equal(uk.postings[0]!.description, "Games", "entity-escaped HTML is decoded");
  assert.equal(uk.postings[0]!.location, null, "a blank location is unknown, not a UK claim");
  assert.equal(uk.postings[0]!.department, null);
});

test("Arbeitnow: a blank location is never inferred, on either board", () => {
  const page = parseArbeitnowPage(
    {
      data: [
        {
          slug: "x",
          company_name: "Acme",
          title: "Engineer",
          description: "",
          remote: false,
          url: "https://www.arbeitnow.com/jobs/companies/acme/x",
          tags: [],
          job_types: [],
          location: "",
          created_at: 1790082027,
        },
      ],
      links: {},
    },
    "de",
  );
  assert.equal(page.postings[0]!.location, null);
});

test("Arbeitnow: follows links.next on the same host and refuses another host", async () => {
  await withFetch(
    (url) => {
      if (url.includes("page=2")) {
        return arbeitnowPage([
          {
            slug: "second",
            company_name: "Acme",
            title: "Role Two",
            description: "<p>x</p>",
            remote: true,
            url: "https://www.arbeitnow.com/jobs/companies/acme/second",
            tags: [],
            job_types: [],
            location: "",
            created_at: 1790082028,
          },
        ]);
      }
      return arbeitnowPage(
        [
          {
            slug: "first",
            company_name: "Acme",
            title: "Role One",
            description: "<p>x</p>",
            remote: true,
            url: "https://www.arbeitnow.com/jobs/companies/acme/first",
            tags: [],
            job_types: [],
            location: "",
            created_at: 1790082027,
          },
        ],
        "https://www.arbeitnow.com/api/job-board-api?page=2",
      );
    },
    async () => {
      const result = await arbeitnow.fetch("de", null);
      assert.equal(result.postings?.length, 2);
    },
  );

  await withFetch(
    () => arbeitnowPage([], "https://evil.example/api/job-board-api?page=2"),
    async () => {
      await assert.rejects(() => arbeitnow.fetch("de", null), /refusing/);
    },
  );
});

test("Arbeitnow: ident selects the host and the label", () => {
  assert.deepEqual(arbeitnow.parse("arbeitnow:uk"), { kind: "arbeitnow", ident: "uk", label: "Arbeitnow UK" });
  assert.deepEqual(arbeitnow.parse("https://www.arbeitnow.co.uk/"), { kind: "arbeitnow", ident: "uk", label: "Arbeitnow UK" });
  assert.deepEqual(arbeitnow.parse("arbeitnow:de"), { kind: "arbeitnow", ident: "de", label: "Arbeitnow Germany" });
  assert.deepEqual(arbeitnow.parse("www.arbeitnow.com/"), { kind: "arbeitnow", ident: "de", label: "Arbeitnow Germany" });
  assert.equal(arbeitnow.parse("arbeitnow:fr"), null);
});

/* ------------------------------------------------------------- registry --- */

test("new feed adapters are registered and declare themselves incomplete", () => {
  const kinds = new Set(ADAPTERS.map((a) => a.kind));
  for (const kind of ["weworkremotely", "remoteok", "workingnomads", "himalayas", "arbeitnow"] as const) {
    assert.ok(kinds.has(kind), `${kind} is registered`);
  }
  for (const adapter of [weworkremotely, remoteok, workingnomads, himalayas, arbeitnow]) {
    assert.equal(adapter.complete, false, `${adapter.kind} must not claim completeness`);
  }
});

test("parseRef resolves prefix and URL forms for the new sources", () => {
  assert.deepEqual(parseRef("wwr:all"), { kind: "weworkremotely", ident: "all", label: "We Work Remotely" });
  assert.deepEqual(parseRef("https://weworkremotely.com/"), { kind: "weworkremotely", ident: "all", label: "We Work Remotely" });
  assert.deepEqual(parseRef("remoteok:all"), { kind: "remoteok", ident: "all", label: "Remote OK" });
  assert.deepEqual(parseRef("workingnomads:all"), { kind: "workingnomads", ident: "all", label: "Working Nomads" });
  assert.deepEqual(parseRef("himalayas:all"), { kind: "himalayas", ident: "all", label: "Himalayas" });
  // Cross-adapter inputs must not cross-match.
  assert.equal(remoteok.parse("himalayas:all"), null);
  assert.equal(himalayas.parse("remoteok:all"), null);
});
