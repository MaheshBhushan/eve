import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchHtml, indeed } from "./sources/indeed.ts";

const pubDateMs = Date.UTC(2026, 7, 30, 9, 0, 0);

function fixtureHtml(): string {
  const blob = {
    metaData: {
      mosaicProviderJobCardsModel: {
        results: [
          {
            jobkey: "abc123",
            displayTitle: "Werkstudent Machine Learning",
            company: "Acme GmbH",
            formattedLocation: "Nürnberg",
            pubDate: pubDateMs,
          },
          {
            jobkey: "def456",
            title: "ML Engineer Intern",
            company: "Beta AG",
            jobLocationCity: "München",
            pubDate: pubDateMs,
          },
        ],
      },
    },
  };
  return (
    "<html><head><script>" +
    `window.mosaic.providerData["mosaic-provider-jobcards"]=${JSON.stringify(blob)};` +
    'window.mosaic.providerData["mosaic-provider-other"]={"x":1};' +
    "</script></head><body></body></html>"
  );
}

test("parseSearchHtml extracts and maps both results", () => {
  const postings = parseSearchHtml(fixtureHtml());
  assert.equal(postings.length, 2);

  const [first, second] = postings;
  assert.equal(first!.externalId, "abc123");
  assert.equal(first!.title, "Werkstudent Machine Learning");
  assert.equal(first!.company, "Acme GmbH");
  assert.equal(first!.location, "Nürnberg");
  assert.equal(first!.url, "https://de.indeed.com/viewjob?jk=abc123");
  assert.equal(first!.postedAt, new Date(pubDateMs).toISOString());

  assert.equal(second!.externalId, "def456");
  assert.equal(second!.title, "ML Engineer Intern");
  assert.equal(second!.location, "München");
});

test("parseSearchHtml throws when the provider blob is missing", () => {
  assert.throws(() => parseSearchHtml("<html>Just a moment...</html>"));
});

test("indeed.parse builds a canonical ident and label", () => {
  const ref = indeed.parse("indeed:werkstudent machine learning@Nürnberg");
  assert.ok(ref);
  assert.equal(ref!.kind, "indeed");
  assert.equal(ref!.ident, "werkstudent machine learning@nürnberg");
  assert.equal(ref!.label, "Indeed: werkstudent machine learning, nürnberg");
});

test("indeed.complete is false", () => {
  assert.equal(indeed.complete, false);
});
