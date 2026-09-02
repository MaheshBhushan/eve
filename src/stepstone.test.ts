import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchHtml, stepstone } from "./sources/stepstone.ts";

function fixtureHtml(): string {
  return `<html><body>
<div class="res-aft8zo">
  <h2><a class="res-xaz43y" data-genesis-element="ANCHOR" href="/stellenangebote--Werkstudent-Machine-Learning-Acme-GmbH--14391264-inline.html" data-testid="job-item-title" data-at="job-item-title" tabindex="-1">
    <div class="res-xrpel9"><div class="res-kyg8or"><div class="res-ewgtgq">Werkstudent Machine Learning</div></div></div>
  </a></h2>
  <div><span data-at="job-item-company-name"><span class="res-215qah"><style data-emotion="res 215qah">.res-215qah{box-sizing:border-box;}</style><span class="res-8wkck8"><svg><path d="M1"></path></svg></span><span class="res-du9bhi"><div class="res-ewgtgq">Acme GmbH</div></span></span></span></div>
  <div><span data-at="job-item-location"><span class="res-8wkck8"><svg><path d="M1"></path></svg></span><span class="res-du9bhi">Nürnberg</span></span></div>
  <span data-at="job-item-timeago"><time class="">vor 6 Tagen</time></span>
</div>
<div class="res-aft8zo">
  <h2><a class="res-xaz43y" data-genesis-element="ANCHOR" href="/stellenangebote--Werkstudent-Data-Science-Beta-AG--14400001-inline.html" data-testid="job-item-title" data-at="job-item-title" tabindex="-1">
    <div class="res-xrpel9"><div class="res-kyg8or"><div class="res-ewgtgq">Werkstudent Data Science</div></div></div>
  </a></h2>
  <div><span data-at="job-item-company-name"><span class="res-215qah"><style data-emotion="res 215qah">.res-215qah{box-sizing:border-box;}</style><span class="res-8wkck8"><svg><path d="M1"></path></svg></span><span class="res-du9bhi"><div class="res-ewgtgq">Beta AG</div></span></span></span></div>
  <div><span data-at="job-item-location"><span class="res-8wkck8"><svg><path d="M1"></path></svg></span><span class="res-du9bhi">M&#252;nchen</span></span></div>
  <span data-at="job-item-timeago"><time class="">vor 2 Tagen</time></span>
</div>
</body></html>`;
}

test("parseSearchHtml extracts both cards", () => {
  const postings = parseSearchHtml(fixtureHtml());
  assert.equal(postings.length, 2);

  const [first, second] = postings;
  assert.equal(first!.externalId, "14391264");
  assert.equal(first!.title, "Werkstudent Machine Learning");
  assert.equal(first!.company, "Acme GmbH");
  assert.equal(first!.location, "Nürnberg");
  assert.equal(
    first!.url,
    "https://www.stepstone.de/stellenangebote--Werkstudent-Machine-Learning-Acme-GmbH--14391264-inline.html",
  );
  assert.equal(first!.postedAt, null);

  assert.equal(second!.externalId, "14400001");
  assert.equal(second!.company, "Beta AG");
  assert.equal(second!.location, "München");
});

test("parseSearchHtml returns [] when there are genuinely no cards", () => {
  assert.deepEqual(parseSearchHtml("<html><body>no results</body></html>"), []);
});

test("stepstone.parse builds a canonical ident and label from the prefix form", () => {
  const ref = stepstone.parse("stepstone:werkstudent machine learning@Nürnberg");
  assert.deepEqual(ref, {
    kind: "stepstone",
    ident: "stepstone:werkstudent machine learning@nürnberg",
    label: "StepStone: werkstudent machine learning, nürnberg",
  });
});

test("stepstone.parse builds an ident from a /jobs/<q>/in-<loc> URL", () => {
  const ref = stepstone.parse("https://www.stepstone.de/jobs/werkstudent-machine-learning/in-nuernberg");
  assert.deepEqual(ref, {
    kind: "stepstone",
    ident: "stepstone:werkstudent machine learning@nuernberg",
    label: "StepStone: werkstudent machine learning, nuernberg",
  });
});

test("stepstone declares itself a partial source", () => {
  assert.equal(stepstone.complete, false);
});
