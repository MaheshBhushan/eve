import { test } from "node:test";
import assert from "node:assert/strict";

import { successfactors } from "./sources/successfactors.ts";

/* ------------------------------------------------------------- parse --- */

test("successfactors: parses prefix, /search/ URL, and bare host root", () => {
  assert.deepEqual(successfactors.parse("successfactors:jobs.sap.com"), {
    kind: "successfactors",
    ident: "jobs.sap.com",
    label: "jobs.sap.com",
  });
  assert.deepEqual(successfactors.parse("SUCCESSFACTORS:Jobs.SAP.com"), {
    kind: "successfactors",
    ident: "jobs.sap.com",
    label: "jobs.sap.com",
  });
  assert.deepEqual(
    successfactors.parse("https://jobs.sap.com/search/?q=&startrow=0"),
    { kind: "successfactors", ident: "jobs.sap.com", label: "jobs.sap.com" },
  );
  assert.deepEqual(successfactors.parse("https://jobs.sap.com/"), {
    kind: "successfactors",
    ident: "jobs.sap.com",
    label: "jobs.sap.com",
  });
  assert.deepEqual(
    successfactors.parse("jobs.sap.com/job/Some-Title-11435/1422986333/"),
    { kind: "successfactors", ident: "jobs.sap.com", label: "jobs.sap.com" },
  );
});

test("successfactors: rejects unrelated input", () => {
  assert.equal(successfactors.parse("greenhouse:stripe"), null);
  assert.equal(successfactors.parse("not a url at all"), null);
});

/* --------------------------------------------------------- row parsing --- */

// Trimmed fixture of the server-rendered table jobs.sap.com returns: two
// data rows (each with the phone-duplicate markup real pages contain) plus
// the aria-label header the adapter reads its page size and total from.
const ROWS_HTML = `
<html><head><title>SAP Jobs</title></head><body>
<table id="searchresults" aria-label="Search results for . Page 1 of 1, Results 1 to 2 of 2">
<tr class="data-row">
  <td class="colTitle" headers="hdrTitle">
    <span class="jobTitle hidden-phone">
      <a href="/job/Riyadh-Forward-Deployed-Data-Scientist-Expert-11435/1422986333/" class="jobTitle-link">Forward Deployed Data Scientist Expert</a>
    </span>
    <div class="jobdetail-phone visible-phone">
      <span class="jobTitle visible-phone">
        <a class="jobTitle-link" href="/job/Riyadh-Forward-Deployed-Data-Scientist-Expert-11435/1422986333/">Forward Deployed Data Scientist Expert</a>
      </span>
    </div>
  </td>
  <td class="colLocation hidden-phone" headers="hdrLocation">
    <span class="jobLocation">
      Riyadh, SA, 11435
    </span>
  </td>
</tr>
<tr class="data-row">
  <td class="colTitle" headers="hdrTitle">
    <span class="jobTitle hidden-phone">
      <a href="/job/Munich-Software-Engineer-80331/1422986334/" class="jobTitle-link">Software Engineer</a>
    </span>
  </td>
  <td class="colLocation hidden-phone" headers="hdrLocation">
    <span class="jobLocation">
      Munich, DE, 80331
    </span>
  </td>
</tr>
</table>
</body></html>
`;

// Same two rows, but the header claims 960 total -- the pagination loop
// exhausts its page cap without ever reaching that count.
const TRUNCATED_HTML = ROWS_HTML.replace(
  "Page 1 of 1, Results 1 to 2 of 2",
  "Page 1 of 39, Results 1 to 2 of 960",
);

test("successfactors: parses rows and the aria-label total via a live fetch stub", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://jobs.sap.com/search/?q=&startrow=0",
    text: async () => ROWS_HTML,
  }));

  const result = await successfactors.fetch("jobs.sap.com", null);
  assert.equal(result.postings?.length, 2);
  const [first, second] = result.postings ?? [];
  assert.ok(first && second);
  assert.equal(first.externalId, "1422986333");
  assert.equal(first.title, "Forward Deployed Data Scientist Expert");
  assert.equal(first.location, "Riyadh, SA, 11435");
  assert.equal(
    first.url,
    "https://jobs.sap.com/job/Riyadh-Forward-Deployed-Data-Scientist-Expert-11435/1422986333/",
  );
  assert.equal(second.externalId, "1422986334");
  assert.equal(second.location, "Munich, DE, 80331");
});

test("successfactors: throws rather than return a truncated snapshot", async (t) => {
  // aria-label claims 960 total but only 2 rows are ever served -- the
  // adapter must refuse, not silently hand back a short snapshot.
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://jobs.sap.com/search/?q=&startrow=0",
    text: async () => TRUNCATED_HTML,
  }));

  await assert.rejects(() => successfactors.fetch("jobs.sap.com", null));
});

test("successfactors: throws on an off-host redirect (SSO login gate)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://login.example.com/sso",
    text: async () => "<html><body>login</body></html>",
  }));

  await assert.rejects(() => successfactors.fetch("jobs.sap.com", null), /off-host|redirect/i);
});
