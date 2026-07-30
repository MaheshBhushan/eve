import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliseCompany, normaliseLocation, normaliseTitle, postingKey } from "./key.ts";
import type { FetchedPosting } from "./types.ts";

function posting(over: Partial<FetchedPosting> = {}): FetchedPosting {
  return {
    externalId: "gh-4712345",
    title: "Backend Engineer",
    company: "Acme GmbH",
    location: "Berlin, Germany",
    remote: false,
    department: "Engineering",
    url: "https://boards.greenhouse.io/acme/jobs/4712345",
    postedAt: "2026-07-01T00:00:00Z",
    closesAt: null,
    description: null,
    ...over,
  };
}

describe("normaliseTitle", () => {
  test("gender and inclusion markers are stripped in every form boards write them", () => {
    const want = normaliseTitle("Backend Engineer");
    for (const v of [
      "Backend Engineer (m/w/d)",
      "Backend Engineer (w/m/d)",
      "Backend Engineer (m/f/d)",
      "Backend Engineer (m/w/x)",
      "Backend Engineer (all genders)",
      "Backend Engineer m/w/d",
      "(m/w/d) Backend Engineer",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });

  test("employment-type decoration is stripped in English and German", () => {
    const want = normaliseTitle("Data Analyst");
    for (const v of [
      "Data Analyst (Full-time)",
      "Data Analyst - Full Time",
      "Data Analyst (Part-time)",
      "Data Analyst Vollzeit",
      "Data Analyst (Teilzeit)",
      "Data Analyst - Permanent",
      "Data Analyst (Contract)",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });

  test("urgency words are stripped so a re-listing with a louder title still matches", () => {
    const want = normaliseTitle("Product Manager");
    for (const v of [
      "URGENT: Product Manager",
      "Product Manager (Urgent)",
      "Hiring now - Product Manager",
      "New - Product Manager",
      "[New] Product Manager",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });

  test("'new' inside a real role name survives — New Business Manager is a job", () => {
    assert.equal(normaliseTitle("New Business Manager"), "new business manager");
    assert.notEqual(normaliseTitle("New Business Manager"), normaliseTitle("Business Manager"));
  });

  test("requisition numbers are stripped in all the shapes boards emit", () => {
    const want = normaliseTitle("Site Reliability Engineer");
    for (const v of [
      "Site Reliability Engineer REQ-10422",
      "Site Reliability Engineer (88123)",
      "Site Reliability Engineer Job ID: 4471",
      "Site Reliability Engineer Ref 9912",
      "Site Reliability Engineer #10422",
      "Site Reliability Engineer [REQ 10422]",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });

  test("a work arrangement glued onto the title is dropped — location is its own field", () => {
    const want = normaliseTitle("Backend Engineer");
    for (const v of [
      "Backend Engineer - Remote",
      "Backend Engineer | Hybrid",
      "Backend Engineer (Remote)",
      "Backend Engineer - Fully Remote",
      "Backend Engineer, On-site",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });

  test("seniority is preserved — two seniorities are two different jobs", () => {
    const plain = normaliseTitle("Backend Engineer (m/w/d)");
    for (const v of [
      "Senior Backend Engineer (m/w/d)",
      "Junior Backend Engineer (m/w/d)",
      "Staff Backend Engineer",
      "Lead Backend Engineer",
      "Principal Backend Engineer",
      "Backend Engineer II",
    ]) {
      assert.notEqual(normaliseTitle(v), plain, v);
    }
    assert.equal(normaliseTitle("Senior Backend Engineer"), "senior backend engineer");
  });

  test("case, accents, punctuation and whitespace variants fold together", () => {
    const want = normaliseTitle("Software Engineer Backend");
    for (const v of [
      "SOFTWARE ENGINEER, BACKEND",
      "Software  Engineer  –  Backend",
      "software engineer / backend",
      "Sóftware Engineer: Backend",
      "\tSoftware Engineer — Backend  ",
    ]) {
      assert.equal(normaliseTitle(v), want, v);
    }
  });
});

describe("normaliseLocation", () => {
  test("the same office written a dozen ways collapses to one city token", () => {
    for (const v of ["Berlin", "Berlin, Germany", "Berlin, DE", "Berlin Office", "berlin  "]) {
      assert.equal(normaliseLocation(v, false), "berlin", v);
    }
  });

  test("every flavour of remote collapses to the single token 'remote'", () => {
    for (const v of [
      "Remote",
      "Remote - EU",
      "Fully Remote (Europe)",
      "REMOTE, US",
      "Work from home",
      "Remote / Anywhere",
    ]) {
      assert.equal(normaliseLocation(v, null), "remote", v);
    }
  });

  test("a null location with the remote flag set is remote", () => {
    assert.equal(normaliseLocation(null, true), "remote");
    assert.equal(normaliseLocation("", true), "remote");
  });

  test("hybrid is not remote — it implies an office you have to be near", () => {
    assert.equal(normaliseLocation("Berlin (Hybrid)", false), "berlin");
    assert.notEqual(normaliseLocation("Berlin (Hybrid)", false), "remote");
    assert.equal(normaliseLocation("Hybrid - Munich", false), "munich");
    // Even a truthy remote flag loses to an explicit hybrid location.
    assert.notEqual(normaliseLocation("Berlin (Hybrid)", true), "remote");
  });

  test("two different cities produce two different tokens", () => {
    assert.notEqual(normaliseLocation("Berlin, DE", false), normaliseLocation("Munich, DE", false));
    assert.notEqual(normaliseLocation("Berlin", false), normaliseLocation("Remote", false));
  });

  test("accented city spellings match their plain forms", () => {
    assert.equal(normaliseLocation("München, Germany", false), normaliseLocation("Munchen", false));
    assert.equal(normaliseLocation("Zürich", false), "zurich");
  });

  test("an unknown location is empty rather than guessed", () => {
    assert.equal(normaliseLocation(null, false), "");
    assert.equal(normaliseLocation(null, null), "");
  });
});

describe("normaliseCompany", () => {
  test("legal suffixes are stripped so one employer stays one employer", () => {
    for (const v of [
      "Acme GmbH",
      "Acme AG",
      "Acme Inc",
      "Acme Inc.",
      "Acme LLC",
      "Acme Ltd",
      "Acme SE",
      "Acme KG",
      "Acme BV",
      "Acme NV",
      "Acme GmbH & Co. KG",
      "ACME",
    ]) {
      assert.equal(normaliseCompany(v), "acme", v);
    }
  });

  test("a suffix word that is part of the name is not stripped from the middle", () => {
    assert.equal(normaliseCompany("SE Labs"), "se labs");
    assert.equal(normaliseCompany("AG Grid"), "ag grid");
  });
});

describe("postingKey", () => {
  test("the same role reposted under a new ATS id keeps its identity", () => {
    const first = postingKey(
      posting({ externalId: "gh-4712345", title: "Backend Engineer (m/w/d)" }),
    );
    const repost = postingKey(
      posting({
        externalId: "gh-9987654", // brand new id, same search reopened weeks later
        title: "Backend Engineer (all genders) - Full-time REQ-10422",
        location: "Berlin, DE",
        url: "https://boards.greenhouse.io/acme/jobs/9987654",
        postedAt: "2026-09-14T00:00:00Z",
      }),
    );
    assert.equal(first, repost);
  });

  test("one role on two different boards produces one shared key", () => {
    const greenhouse = postingKey(
      posting({
        externalId: "gh-4712345",
        company: "Acme GmbH",
        url: "https://boards.greenhouse.io/acme/jobs/4712345",
      }),
    );
    const aggregator = postingKey(
      posting({
        externalId: "ashby-3f9c1a20-0000-4000-8000-000000000000",
        company: "Acme",
        location: "Berlin",
        url: "https://jobs.ashbyhq.com/acme/3f9c1a20",
      }),
    );
    assert.equal(greenhouse, aggregator);
  });

  test("the key is a short stable hex hash", () => {
    const k = postingKey(posting());
    assert.match(k, /^[0-9a-f]{12}$/);
    assert.equal(k, postingKey(posting()));
  });

  test("seniority, city and company each fork the key", () => {
    const base = postingKey(posting());
    assert.notEqual(base, postingKey(posting({ title: "Senior Backend Engineer" })));
    assert.notEqual(base, postingKey(posting({ location: "Munich, Germany" })));
    assert.notEqual(base, postingKey(posting({ company: "Globex GmbH" })));
    assert.notEqual(base, postingKey(posting({ location: null, remote: true })));
  });

  test("a location the board glued onto the title does not fork the key", () => {
    assert.equal(
      postingKey(posting({ title: "Backend Engineer - Berlin" })),
      postingKey(posting({ title: "Backend Engineer" })),
    );
    assert.equal(
      postingKey(posting({ title: "Backend Engineer - Remote", location: null, remote: true })),
      postingKey(posting({ title: "Backend Engineer", location: null, remote: true })),
    );
  });
});
