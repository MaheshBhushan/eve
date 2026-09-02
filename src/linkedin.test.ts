import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCards, parseCard, parseRelativeAge, linkedin } from "./sources/linkedin.ts";

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

const NOW = Date.parse("2026-08-31T12:00:00Z");

test("parseCard maps a card to a FetchedPosting with a clean url", () => {
  const cards = extractCards(fixtureHtml());
  const first = parseCard(cards[0]!, NOW);
  assert.ok(first);
  assert.equal(first!.externalId, "1234567890");
  assert.equal(first!.title, "Werkstudent Machine Learning");
  assert.equal(first!.company, "Acme GmbH");
  assert.equal(first!.location, "Nürnberg, Bayern, Germany");
  assert.equal(first!.url, "https://www.linkedin.com/jobs/view/1234567890");
  // "2 days ago" resolved against the fetch clock beats the date-only attribute.
  assert.equal(first!.postedAt, new Date(NOW - 2 * 86_400_000).toISOString());

  const second = parseCard(cards[1]!, NOW);
  assert.ok(second);
  assert.equal(second!.externalId, "9876543210");
  assert.equal(second!.company, "Beta AG");
});

test("parseRelativeAge resolves LinkedIn's relative text to the hour or minute", () => {
  assert.equal(parseRelativeAge("3 hours ago", NOW), new Date(NOW - 3 * 3_600_000).toISOString());
  assert.equal(parseRelativeAge("  23 minutes ago  ", NOW), new Date(NOW - 23 * 60_000).toISOString());
  assert.equal(parseRelativeAge("1 week ago", NOW), new Date(NOW - 7 * 86_400_000).toISOString());
  assert.equal(parseRelativeAge("vor 3 Stunden", NOW), null, "localised text is not guessed at");
  assert.equal(parseRelativeAge("30+ days ago", NOW), null);
  assert.equal(parseRelativeAge("", NOW), null);
});

test("parseCard falls back to the date attribute when the relative text is unusable", () => {
  const li = `<li data-entity-urn="urn:li:jobPosting:5">
    <h3 class="base-search-card__title">Role</h3>
    <h4 class="base-search-card__subtitle">Co</h4>
    <time datetime="2026-08-29">vor 2 Tagen</time></li>`;
  assert.equal(parseCard(li, NOW)!.postedAt, new Date("2026-08-29").toISOString());
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
