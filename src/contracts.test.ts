import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACTS, checkPayload, enforceContract } from "./contracts.ts";

const gh = { id: 1, title: "Dev", absolute_url: "https://x/1", location: { name: "Berlin" } };

test("contracts: valid payload passes with no violations", () => {
  const r = checkPayload(CONTRACTS.greenhouse!, [gh]);
  assert.equal(r.version, 1);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.unmapped, {});
});

test("contracts: missing required field and wrong type are reported", () => {
  const r = checkPayload(CONTRACTS.greenhouse!, [{ id: "1", absolute_url: "u" }]);
  assert.deepEqual(r.violations[0]!.problems, ["id expected number, got string", "missing required title"]);
});

test("contracts: unmapped attributes are counted, not dropped", () => {
  const warnings: string[] = [];
  const r = enforceContract("greenhouse", "acme", [{ ...gh, salary: 1 }, { ...gh, salary: 2 }], (m) => warnings.push(m));
  assert.deepEqual(r!.unmapped, { salary: 2 });
  assert.match(warnings[0]!, /unmapped attributes: salary \(2\)/);
});

test("contracts: enforceContract throws before a snapshot is built", () => {
  assert.throws(() => enforceContract("lever", "acme", [{ id: "a", text: "Dev" }], () => {}), /missing required hostedUrl/);
});

test("contracts: kinds without a contract are skipped", () => {
  assert.equal(enforceContract("remotive", "x", [{}]), null);
});
