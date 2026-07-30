/**
 * No network, no browser, no Python. Everything here is the pure part of the
 * browser adapter: reference parsing, ident canonicalisation, and the
 * validation gate that stands between an LLM's output and the database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  browser,
  parsePostings,
  resolveRunner,
  splitIdent,
  type BrowserEnv,
} from "./sources/browser.ts";

const env = (over: Partial<BrowserEnv> = {}): BrowserEnv => ({
  browserUseDir: "/tmp",
  browserUsePython: "python3",
  browserTimeoutMin: 10,
  ...over,
});

/* ------------------------------------------------------------- parsing --- */

test("parses the prefixed form for all three sites", () => {
  for (const site of ["linkedin", "indeed", "stepstone"] as const) {
    const ref = browser.parse(`${site}:machine learning engineer@Berlin`);
    assert.ok(ref, `${site} should parse`);
    assert.equal(ref.kind, "browser");
    assert.equal(ref.ident, `${site}:machine learning engineer@berlin`);
    assert.match(ref.label, /machine learning engineer/);
  }
});

test("parses a search URL from each site", () => {
  const cases: Array<[string, string]> = [
    [
      "https://www.linkedin.com/jobs/search/?keywords=Machine%20Learning%20Engineer&location=Berlin&f_TPR=r86400",
      "linkedin:machine learning engineer@berlin",
    ],
    [
      "https://de.indeed.com/jobs?q=Machine+Learning+Engineer&l=Berlin&from=searchOnHP",
      "indeed:machine learning engineer@berlin",
    ],
    [
      "https://www.stepstone.de/jobs?what=Machine%20Learning%20Engineer&where=Berlin",
      "stepstone:machine learning engineer@berlin",
    ],
  ];
  for (const [url, ident] of cases) {
    const ref = browser.parse(url);
    assert.ok(ref, `${url} should parse`);
    assert.equal(ref.ident, ident);
  }
});

test("equivalent inputs canonicalise to one ident", () => {
  // The ident is the SQLite uniqueness key for a watched source: if these
  // diverged, the same search would be polled twice and every posting would
  // appear twice in the channel.
  const idents = [
    "linkedin:Machine Learning Engineer@Berlin",
    "linkedin:  machine   learning  engineer @ berlin ",
    "LinkedIn:MACHINE LEARNING ENGINEER@BERLIN",
    "https://www.linkedin.com/jobs/search/?keywords=machine+learning+engineer&location=Berlin",
    "https://www.linkedin.com/jobs/search?keywords=Machine%20Learning%20Engineer&location=berlin&start=25",
  ].map((s) => browser.parse(s)?.ident);

  assert.equal(new Set(idents).size, 1, `diverged: ${JSON.stringify(idents)}`);
  assert.equal(idents[0], "linkedin:machine learning engineer@berlin");
});

test("a missing location becomes an explicit 'anywhere'", () => {
  assert.equal(browser.parse("indeed:rust developer")?.ident, "indeed:rust developer@anywhere");
  assert.equal(browser.parse("indeed:rust developer@")?.ident, "indeed:rust developer@anywhere");
  assert.equal(
    browser.parse("https://www.indeed.com/jobs?q=rust+developer")?.ident,
    "indeed:rust developer@anywhere",
  );
});

test("returns null for anything it does not handle, and never throws", () => {
  for (const bad of [
    "",
    "   ",
    "acme",
    "greenhouse:acme",
    "https://boards.greenhouse.io/acme",
    "https://example.com/jobs?q=engineer",
    // a LinkedIn URL that isn't a search: no query to repeat
    "https://www.linkedin.com/jobs/view/3812345678",
    "linkedin:",
    "linkedin:@Berlin",
    "not a url ://///",
  ]) {
    assert.equal(browser.parse(bad), null, `expected null for ${bad!}`);
  }
});

test("splitIdent round-trips and rejects foreign idents", () => {
  const { site, query, location } = splitIdent("linkedin:ml engineer@berlin");
  assert.deepEqual({ site, query, location }, {
    site: "linkedin",
    query: "ml engineer",
    location: "berlin",
  });
  assert.throws(() => splitIdent("greenhouse:acme"), /not a browser-search ident/);
});

/* -------------------------------------------------------- partial source --- */

test("declares itself an incomplete source", () => {
  // The poller reads this to decide whether an absence may close a posting.
  assert.equal(browser.complete, false);
  assert.equal(browser.kind, "browser");
});

/* ---------------------------------------------------------- json output --- */

const good = JSON.stringify([
  {
    externalId: "3812345678",
    title: "Machine Learning Engineer",
    company: "Acme GmbH",
    location: "Berlin, Germany",
    remote: null,
    department: null,
    url: "https://www.linkedin.com/jobs/view/3812345678",
    postedAt: "2026-07-27T09:00:00.000Z",
    closesAt: null,
    description: null,
  },
  {
    externalId: "abc123",
    title: "MLOps Engineer",
    company: "Beta AG",
    location: null,
    remote: true,
    url: "https://de.indeed.com/viewjob?jk=abc123",
    postedAt: null,
  },
]);

test("accepts a well-formed payload", () => {
  const rows = parsePostings(good);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.title, "Machine Learning Engineer");
  assert.equal(rows[0]!.postedAt, "2026-07-27T09:00:00.000Z");
  // Absent optionals normalise to null rather than undefined.
  assert.equal(rows[1]!.postedAt, null);
  assert.equal(rows[1]!.location, null);
  assert.equal(rows[1]!.department, null);
  assert.equal(rows[1]!.closesAt, null);
  assert.equal(rows[1]!.remote, true);
});

test("tolerates surrounding whitespace but not surrounding prose", () => {
  assert.equal(parsePostings(`\n  ${good}\n`).length, 2);
  assert.throws(() => parsePostings(`here you go: ${good}`), /did not print JSON/);
});

test("rejects every shape of malformed output", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /no output/],
    ["   \n", /no output/],
    ["Traceback (most recent call last):", /did not print JSON/],
    ['{"results": []}', /not a JSON array/],
    ["[null]", /is not an object/],
    ['[{"title":"x","company":"y","url":"https://e.com/1"}]', /missing externalId/],
    ['[{"externalId":"1","company":"y","url":"https://e.com/1"}]', /missing title/],
    ['[{"externalId":"1","title":"x","url":"https://e.com/1"}]', /missing company/],
    ['[{"externalId":"1","title":"x","company":"y"}]', /missing url/],
    ['[{"externalId":"1","title":"x","company":"y","url":"   "}]', /missing url/],
    // A hallucinated non-http link must never reach the channel as a job link.
    ['[{"externalId":"1","title":"x","company":"y","url":"javascript:alert(1)"}]', /not http/],
    [
      '[{"externalId":"1","title":"x","company":"y","url":"https://e.com/1","postedAt":"2 days ago"}]',
      /neither null nor a date/,
    ],
    [
      '[{"externalId":"1","title":"x","company":"y","url":"https://e.com/1","remote":"yes"}]',
      /not a boolean/,
    ],
    [
      '[{"externalId":"1","title":"x","company":"y","url":"https://e.com/1","location":7}]',
      /location is not a string/,
    ],
  ];
  for (const [payload, re] of cases) {
    assert.throws(() => parsePostings(payload), re, `should reject: ${payload}`);
  }
});

/* -------------------------------------------------------- configuration --- */

test("an unconfigured browserUseDir names the env var to set", () => {
  assert.throws(
    () => resolveRunner(env({ browserUseDir: null })),
    (e: Error) =>
      /not configured/.test(e.message) &&
      /RADAR_BROWSER_USE_DIR/.test(e.message) &&
      /RADAR_BROWSER_USE_PYTHON/.test(e.message),
  );
});

test("a browserUseDir that does not exist says so", () => {
  assert.throws(
    () => resolveRunner(env({ browserUseDir: "/nope/not/here" })),
    /RADAR_BROWSER_USE_DIR points at \/nope\/not\/here, which does not exist/,
  );
});

test("an absolute interpreter that does not exist explains the venv", () => {
  assert.throws(
    () => resolveRunner(env({ browserUsePython: "/nope/bin/python" })),
    /RADAR_BROWSER_USE_PYTHON points at \/nope\/bin\/python.*venv/s,
  );
});

test("a configured runner resolves", () => {
  assert.deepEqual(resolveRunner(env()), { python: "python3", dir: "/tmp" });
});
