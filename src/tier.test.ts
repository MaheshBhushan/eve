import { test } from "node:test";
import assert from "node:assert/strict";
import { postingTier } from "./tier.ts";

const tier = (description: string, title = "Werkstudent AI Engineering") => postingTier({ title, description }).tier;

test("very good German is a knockout", () => {
  assert.equal(tier("Very strong German in speaking and writing is required."), "C");
  assert.equal(tier("Fluent German and English required."), "C");
  assert.equal(tier("Verhandlungssichere Deutschkenntnisse in Wort und Schrift."), "C");
  assert.equal(tier("German (C1) is mandatory."), "C");
});

test("a strong English level next to good German stays tier B", () => {
  assert.equal(tier("Gute Deutsch- und sehr gute Englischkenntnisse runden Dein Profil ab."), "B");
});

test("B1 or unlevelled German is a stretch, not a knockout", () => {
  assert.equal(tier("Gute Deutschkenntnisse."), "B");
  assert.equal(tier("German at B1 level."), "B");
  assert.equal(tier("Du bringst Deutschkenntnisse mit."), "B");
});

test("optional German does not lower the tier", () => {
  assert.equal(tier("Fluent English required. German is a plus."), "A");
  assert.equal(tier("Sehr gute Deutschkenntnisse sind von Vorteil."), "A");
});

test("an experience floor of two years or more is a knockout", () => {
  assert.equal(tier("You have 3+ years of professional experience in Python."), "C");
  assert.equal(tier("Mindestens 2 Jahre Berufserfahrung im Bereich Data Science."), "C");
  assert.equal(tier("At least 1 year of experience with Python."), "A");
});

test("an English posting without knockouts is tier A and gives no reasons", () => {
  const r = postingTier({ title: "AI Engineering Intern", description: "Python, LangGraph, RAG. Enrolled student." });
  assert.deepEqual(r, { tier: "A", reasons: [] });
});

test("reasons quote the sentence that fired", () => {
  const r = postingTier({ title: "x", description: "We offer a great team. Fließende Deutschkenntnisse erforderlich." });
  assert.equal(r.tier, "C");
  assert.match(r.reasons[0]!, /Fließende Deutschkenntnisse/);
});
