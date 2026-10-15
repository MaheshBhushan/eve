import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateApplicationResult } from "./application-runner.ts";
import { loadApplicationConfig } from "./application-config.ts";
import { deliverApplicationNotification } from "./applications.ts";

test("submission success and technical retry require confined evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "eve-result-"));
  try {
    const evidence = join(dir, "confirmation.txt");
    writeFileSync(evidence, "Observed confirmation from the local fixture");
    const result = { status: "test_submitted", summary: "Confirmed", destination: "https://test.example/apply", evidence: [evidence], retryable: false };
    assert.equal(validateApplicationResult(result, result.destination, dir).status, "test_submitted");
    assert.throws(() => validateApplicationResult({ ...result, evidence: [] }, result.destination, dir));
    assert.throws(() => validateApplicationResult({ ...result, destination: "https://employer.example/" }, result.destination, dir));
    assert.throws(() => validateApplicationResult({ ...result, evidence: [import.meta.filename] }, result.destination, dir));
    const failed = { ...result, status: "failed", retryable: true };
    assert.throws(() => validateApplicationResult(failed, result.destination, dir));
    assert.equal(validateApplicationResult({ ...failed, submissionPhase: "pre-submit" }, result.destination, dir).retryable, true);
    assert.throws(() => validateApplicationResult({ ...failed, submissionPhase: "submit-started" }, result.destination, dir));
    assert.throws(() => validateApplicationResult({ ...result, status: "handoff", submissionPhase: "submit-started" }, result.destination, dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("Telegram requires HTTP and JSON acknowledgement and redacts transport failures", async () => {
  const config = loadApplicationConfig({ EVE_APPLICATION_TELEGRAM_TOKEN: "123:fixture-token", EVE_APPLICATION_TELEGRAM_CHAT_ID: "123" });
  const notification = { id: 1, job_id: 1, payload_json: '{"state":"handoff"}' };
  const transport = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  await deliverApplicationNotification(config, notification, transport(200, { ok: true }));
  await assert.rejects(deliverApplicationNotification(config, notification, transport(200, { ok: false })), /remains pending/);
  await assert.rejects(deliverApplicationNotification(config, notification, transport(503, { ok: true })), /remains pending/);
  await assert.rejects(deliverApplicationNotification(config, notification, (async () => {
    throw new Error(`transport URL contains ${config.telegramToken}`);
  }) as typeof fetch), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(config.telegramToken!));
    return true;
  });
});
