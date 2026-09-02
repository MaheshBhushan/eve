import { test } from "node:test";
import assert from "node:assert/strict";

import { xing } from "./sources/xing.ts";
import { parseRuntimeConfig, extractPostings } from "./sources/xing.ts";

/* ------------------------------------------------------------- parse --- */

test("xing: parses prefix and URL forms", () => {
  assert.deepEqual(xing.parse("xing:werkstudent machine learning@Nürnberg"), {
    kind: "xing",
    ident: "xing:werkstudent machine learning@nürnberg",
    label: "XING: werkstudent machine learning, nürnberg",
  });
  assert.deepEqual(
    xing.parse(
      "https://www.xing.com/jobs/search?keywords=werkstudent+machine+learning&location=N%C3%BCrnberg",
    ),
    {
      kind: "xing",
      ident: "xing:werkstudent machine learning@nürnberg",
      label: "XING: werkstudent machine learning, nürnberg",
    },
  );
  assert.equal(xing.parse("linkedin:foo@bar"), null);
  assert.equal(xing.parse(""), null);
});

/* ------------------------------------------------------- extraction --- */

const FIXTURE_CRATE = {
  serverData: {
    APOLLO_STATE: {
      ROOT_QUERY: {
        'jobSearchByQuery({"query":"ml"})': {
          collection: [
            { __ref: "VisibleJob:1.1" },
            { jobDetail: { __ref: "VisibleJob:2.2" } },
          ],
        },
      },
      "VisibleJob:1.1": {
        id: "1",
        title: "Werkstudent Machine Learning",
        companyInfo: { company: { __ref: "Company:42" } },
        location: { city: "Nürnberg" },
        employmentType: { localizationValue: "part_time" },
        url: "https://www.xing.com/jobs/1",
        refreshedAt: "2026-08-01T00:00:00Z",
        activatedAt: "2026-07-15T00:00:00Z",
        activeUntil: undefined,
      },
      "VisibleJob:2.2": {
        id: "2",
        title: "Werkstudent ML Engineer",
        companyInfo: { companyNameOverride: "Overridden GmbH" },
        location: { city: "Nürnberg" },
        url: "https://www.xing.com/jobs/2",
        refreshedAt: "2026-08-02T00:00:00Z",
      },
      "Company:42": {
        companyName: "Acme AI GmbH",
      },
    },
  },
};

// Serialize with a bare `undefined` token the way XING's real page does --
// JSON.stringify drops `undefined` keys entirely, so splice one in by hand.
function fixtureHtml(): string {
  const json = JSON.stringify(FIXTURE_CRATE);
  // JSON.stringify drops undefined-valued keys entirely, so splice one back
  // in by hand -- this is exactly the bare `undefined` token XING's real
  // runtime-config literal carries and JSON.parse rejects.
  const withUndefined = json.replace(
    '"refreshedAt":"2026-08-01T00:00:00Z"',
    '"refreshedAt":"2026-08-01T00:00:00Z","activeUntil":undefined',
  );
  return `<html><body><script id="runtime-config">window.crate=${withUndefined}</script></body></html>`;
}

test("xing: parseRuntimeConfig extracts and repairs the crate literal", () => {
  const crate = parseRuntimeConfig(fixtureHtml());
  assert.deepEqual(
    (crate as any).serverData.APOLLO_STATE["VisibleJob:1.1"].activeUntil,
    null,
  );
});

test("xing: parseRuntimeConfig throws when the script tag is missing", () => {
  assert.throws(() => parseRuntimeConfig("<html><body>nope</body></html>"));
});

test("xing: extractPostings dereferences direct and nested __ref, and both company forms", () => {
  const crate = parseRuntimeConfig(fixtureHtml());
  const postings = extractPostings(crate);
  assert.equal(postings.length, 2);

  const [first, second] = postings;
  assert.equal(first!.externalId, "1");
  assert.equal(first!.title, "Werkstudent Machine Learning");
  assert.equal(first!.company, "Acme AI GmbH");
  assert.equal(first!.location, "Nürnberg");
  assert.equal(first!.url, "https://www.xing.com/jobs/1");
  assert.equal(first!.postedAt, new Date("2026-07-15T00:00:00Z").toISOString());
  assert.equal(first!.closesAt, null);

  assert.equal(second!.externalId, "2");
  assert.equal(second!.company, "Overridden GmbH");
  // no activatedAt/publishedAt/createdAt on this one -- postedAt must stay null,
  // never fall back to refreshedAt.
  assert.equal(second!.postedAt, null);
});

test("xing: extractPostings throws on a missing jobSearchByQuery key", () => {
  const crate = {
    serverData: { APOLLO_STATE: { ROOT_QUERY: {} } },
  };
  assert.throws(() => extractPostings(crate));
});
