import { test } from "node:test";
import assert from "node:assert/strict";

import { greenhouse } from "./sources/greenhouse.ts";
import { lever } from "./sources/lever.ts";
import { ashby } from "./sources/ashby.ts";
import { workday } from "./sources/workday.ts";
import { stripHtml } from "./sources/index.ts";

/* ------------------------------------------------------------- parse --- */

test("greenhouse: parses prefix and board URL forms", () => {
  assert.deepEqual(greenhouse.parse("greenhouse:stripe"), {
    kind: "greenhouse",
    ident: "stripe",
    label: "stripe",
  });
  assert.deepEqual(greenhouse.parse("GREENHOUSE:Stripe"), {
    kind: "greenhouse",
    ident: "stripe",
    label: "stripe",
  });
  assert.deepEqual(greenhouse.parse("boards.greenhouse.io/stripe"), {
    kind: "greenhouse",
    ident: "stripe",
    label: "stripe",
  });
  assert.deepEqual(greenhouse.parse("https://job-boards.greenhouse.io/stripe"), {
    kind: "greenhouse",
    ident: "stripe",
    label: "stripe",
  });
  // deep link to a single posting still resolves to the board
  assert.deepEqual(
    greenhouse.parse("https://boards.greenhouse.io/stripe/jobs/12345?gh_src=abc"),
    { kind: "greenhouse", ident: "stripe", label: "stripe" },
  );
});

test("lever: parses prefix and both hosted-domain forms", () => {
  assert.deepEqual(lever.parse("lever:spotify"), {
    kind: "lever",
    ident: "spotify",
    label: "spotify",
  });
  assert.deepEqual(lever.parse("https://jobs.lever.co/spotify"), {
    kind: "lever",
    ident: "spotify",
    label: "spotify",
  });
  assert.deepEqual(lever.parse("jobs.eu.lever.co/spotify"), {
    kind: "lever",
    ident: "spotify",
    label: "spotify",
  });
  assert.deepEqual(
    lever.parse("https://jobs.lever.co/spotify/abcd-1234-efgh"),
    { kind: "lever", ident: "spotify", label: "spotify" },
  );
});

test("ashby: parses prefix and jobs.ashbyhq.com form", () => {
  assert.deepEqual(ashby.parse("ashby:ramp"), {
    kind: "ashby",
    ident: "ramp",
    label: "ramp",
  });
  assert.deepEqual(ashby.parse("https://jobs.ashbyhq.com/ramp"), {
    kind: "ashby",
    ident: "ramp",
    label: "ramp",
  });
  assert.deepEqual(
    ashby.parse("jobs.ashbyhq.com/ramp/abc-123-def?utm_source=x"),
    { kind: "ashby", ident: "ramp", label: "ramp" },
  );
});

test("unrecognised input returns null for every adapter, never throws", () => {
  const junk = ["not a url at all", "https://example.com/careers", "greenhouse:", ""];
  for (const input of junk) {
    assert.equal(greenhouse.parse(input), null, input);
    assert.equal(lever.parse(input), null, input);
    assert.equal(ashby.parse(input), null, input);
  }
  // cross-adapter inputs shouldn't cross-match
  assert.equal(greenhouse.parse("lever:spotify"), null);
  assert.equal(lever.parse("ashby:ramp"), null);
  assert.equal(ashby.parse("greenhouse:stripe"), null);
});

/* ------------------------------------------------------ greenhouse JD --- */

test("stripHtml handles Greenhouse's double-escaped content once decoded", () => {
  // What Greenhouse's JSON literally contains: entity-escaped HTML, not
  // real tags. Feeding this straight to stripHtml would leave the literal
  // "&lt;h2&gt;" text visible; the adapter must decode entities first.
  const doubleEscaped = "&lt;h2&gt;Who we are&lt;/h2&gt;&lt;p&gt;A fintech co.&lt;/p&gt;";

  // stripHtml's own tag-stripping regex runs before its entity-decoding
  // step, so on double-escaped input it finds no real "<" to strip and
  // only unescapes the entities afterwards -- leaving literal tags in
  // the "stripped" text instead of removing them.
  const strippedRaw = stripHtml(doubleEscaped);
  assert.ok(strippedRaw && strippedRaw.includes("<h2>"), "raw stripHtml leaves literal tags behind");

  const decoded = doubleEscaped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  const strippedDecoded = stripHtml(decoded);
  assert.equal(strippedDecoded, "Who we are\n A fintech co.");
});

/* --------------------------------------------------------- lever error -- */

test("lever: {ok:false} body throws instead of yielding an empty snapshot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: "Document not found" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => lever.fetch("no-such-slug", null),
      /Document not found/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* -------------------------------------------------------- workday --- */

test("workday: parses prefix and myworkdayjobs.com URL forms", () => {
  assert.deepEqual(workday.parse("workday:nvidia.wd5/NVIDIAExternalCareerSite"), {
    kind: "workday",
    ident: "nvidia.wd5/NVIDIAExternalCareerSite",
    label: "NVIDIAExternalCareerSite",
  });
  assert.deepEqual(
    workday.parse("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"),
    { kind: "workday", ident: "nvidia.wd5/NVIDIAExternalCareerSite", label: "NVIDIAExternalCareerSite" },
  );
  assert.deepEqual(
    workday.parse("nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite"),
    { kind: "workday", ident: "nvidia.wd5/NVIDIAExternalCareerSite", label: "NVIDIAExternalCareerSite" },
  );
  assert.equal(workday.parse("not a url at all"), null);
});

test("workday: paginates a fixed total and builds the job URL from externalPath", async () => {
  const originalFetch = globalThis.fetch;
  const pages = [
    {
      total: 2,
      jobPostings: [
        {
          title: "Senior Engineer",
          externalPath: "/job/US-CA-Santa-Clara/Senior-Engineer_JR001",
          locationsText: "US, CA, Santa Clara",
          postedOn: "Posted Today",
          bulletFields: ["JR001"],
        },
      ],
    },
    {
      // Workday's `total` is unreliable past offset 0 on real tenants -- the
      // adapter must keep paginating against the total from the first page.
      total: 0,
      jobPostings: [
        {
          title: "Staff Engineer",
          externalPath: "/job/India-Bengaluru/Staff-Engineer_JR002",
          locationsText: "India, Bengaluru",
          postedOn: "Posted Today",
          bulletFields: ["JR002"],
        },
      ],
    },
  ];
  let call = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(pages[call++]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const result = await workday.fetch("nvidia.wd5/NVIDIAExternalCareerSite", null);
    assert.ok(result.postings);
    const postings = result.postings!;
    assert.equal(postings.length, 2);
    assert.equal(postings[0]!.title, "Senior Engineer");
    assert.equal(
      postings[0]!.url,
      "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Senior-Engineer_JR001",
    );
    assert.equal(postings[0]!.postedAt, null);
    assert.equal(postings[1]!.externalId, "JR002");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* --------------------------------------------------------- ashby shape -- */

test("ashby: filters isListed:false and trims leading-space titles", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        apiVersion: "1",
        jobs: [
          {
            id: "job-1",
            title: " Senior Engineer",
            location: "New York, NY",
            secondaryLocations: [{ location: "Remote - US" }, { location: "Remote - EU" }],
            publishedAt: "2026-01-01T00:00:00.000Z",
            isListed: true,
            isRemote: false,
            jobUrl: "https://jobs.ashbyhq.com/ramp/job-1",
            descriptionPlain: "Do the thing.",
          },
          {
            id: "job-2",
            title: "Hidden Role",
            location: "Remote",
            publishedAt: "2026-01-01T00:00:00.000Z",
            isListed: false,
            jobUrl: "https://jobs.ashbyhq.com/ramp/job-2",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const result = await ashby.fetch("ramp", null);
    assert.ok(result.postings);
    const postings = result.postings!;
    assert.equal(postings.length, 1, "unlisted job must be filtered out");
    const [job] = postings;
    assert.equal(job!.title, "Senior Engineer", "leading space must be trimmed");
    assert.equal(job!.location, "New York, NY (+2 more)");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
