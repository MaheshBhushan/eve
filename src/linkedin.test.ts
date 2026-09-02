import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCards, parseCard, linkedin } from "./sources/linkedin.ts";

function fixtureHtml(): string {
  return `
<ul>
<li>
<div class="base-card" data-entity-urn="urn:li:jobPosting:1234567890">
  <h3 class="base-search-card__title">Werkstudent Machine Learning</h3>
  <h4 class="base-search-card__subtitle">Acme GmbH</h4>
  <span class="job-search-card__location">Nürnberg, Bayern, Germany</span>
  <time datetime="2026-08-29">2 days ago</time>
</div>
</li>
<li>
<div class="base-card" data-entity-urn="urn:li:jobPosting:9876543210">
  <h3 class="base-search-card__title">ML Engineer Intern</h3>
  <h4 class="base-search-card__subtitle">Beta AG</h4>
  <span class="job-search-card__location">München, Bayern, Germany</span>
  <time datetime="2026-08-27">4 days ago</time>
</div>
</li>
</ul>`;
}

test("extractCards finds both li job cards", () => {
  const cards = extractCards(fixtureHtml());
  assert.equal(cards.length, 2);
});

test("parseCard maps a card to a FetchedPosting with a clean url", () => {
  const cards = extractCards(fixtureHtml());
  const first = parseCard(cards[0]!);
  assert.ok(first);
  assert.equal(first!.externalId, "1234567890");
  assert.equal(first!.title, "Werkstudent Machine Learning");
  assert.equal(first!.company, "Acme GmbH");
  assert.equal(first!.location, "Nürnberg, Bayern, Germany");
  assert.equal(first!.url, "https://www.linkedin.com/jobs/view/1234567890");
  assert.equal(first!.postedAt, new Date("2026-08-29").toISOString());

  const second = parseCard(cards[1]!);
  assert.ok(second);
  assert.equal(second!.externalId, "9876543210");
  assert.equal(second!.company, "Beta AG");
});

test("parseCard returns null when a required field is missing", () => {
  const broken = `<li data-entity-urn="urn:li:jobPosting:1">
    <h4 class="base-search-card__subtitle">Acme GmbH</h4>
  </li>`;
  assert.equal(parseCard(broken), null);
});

test("linkedin.parse builds a canonical ident and label", () => {
  const ref = linkedin.parse("linkedin:werkstudent machine learning@Nürnberg");
  assert.ok(ref);
  assert.equal(ref!.kind, "linkedin");
  assert.equal(ref!.ident, "werkstudent machine learning@nürnberg");
  assert.equal(ref!.label, "LinkedIn: werkstudent machine learning, nürnberg");
});

test("linkedin.complete is false", () => {
  assert.equal(linkedin.complete, false);
});
