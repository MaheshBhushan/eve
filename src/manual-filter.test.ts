import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, loadFilters, specFor, filterHash } from "./filter.ts";
import type { FetchedPosting } from "./types.ts";

const cfg = loadFilters("config/filters.manual.json");
const spec = specFor(cfg, "greenhouse", "any");
const job = (title: string, location: string, remote: boolean | null = null): FetchedPosting => ({
  externalId: title + location, title, company: "Acme", location, remote, department: null,
  url: "https://example.com", postedAt: null, closesAt: null,
  description: "Build LLM applications with RAG, embeddings and LangGraph in Python and Docker.",
});
const kept = (p: FetchedPosting) => applyFilter([p], spec).length === 1;

test("Germany admits only working student, internship and thesis roles", () => {
  assert.ok(kept(job("Werkstudent (m/w/d) Generative AI", "München, Bayern")));
  assert.ok(kept(job("Masterarbeit: LLM Agents in der Produktion", "Nürnberg")));
  assert.ok(kept(job("AI Engineering Intern", "Berlin, Germany")));
  assert.ok(!kept(job("AI Engineer", "Berlin, Germany")));
  assert.ok(!kept(job("Remote AI Engineer", "Germany (Remote)", true)));
});

test("outside Germany admits only remote roles open from anywhere", () => {
  assert.ok(kept(job("AI Engineer", "Remote, Worldwide", true)));
  assert.ok(kept(job("LLM Engineer", "EMEA", true)));
  assert.ok(!kept(job("AI Engineer", "London, United Kingdom")));
  assert.ok(!kept(job("AI Engineer", "Remote - United States", true)));
  assert.ok(!kept(job("AI Engineer", "Bengaluru, India", true)));
  assert.ok(!kept(job("Senior AI Engineer", "Remote, Worldwide", true)));
});

test("branches change the filter hash", () => {
  assert.notEqual(filterHash(spec), filterHash({ ...spec, anyOf: undefined }));
});
