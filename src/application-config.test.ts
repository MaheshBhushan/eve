import { test } from "node:test";
import assert from "node:assert/strict";
import { loadApplicationConfig, requireApplicationExecution } from "./application-config.ts";

test("application configuration is disabled and independent of Discord", () => {
  const config = loadApplicationConfig({ RADAR_DB_PATH: "/tmp/applications.db" });
  assert.equal(config.enabled, false);
  assert.equal(config.dbPath, "/tmp/applications.db");
  assert.throws(() => requireApplicationExecution(config), /disabled/);
});

test("application execution requires explicit destination authorization", () => {
  const env = { EVE_APPLICATION_ENABLED: "true", EVE_APPLICATION_DESTINATION: "https://test.example/apply" };
  assert.throws(() => loadApplicationConfig(env), /AUTHORIZED_TEST_SYSTEM/);
  const config = loadApplicationConfig({ ...env, EVE_APPLICATION_AUTHORIZED_TEST_SYSTEM: "true" });
  assert.doesNotThrow(() => requireApplicationExecution(config));
  for (const destination of ["http://employer.example/apply", "https://user:password@test.example", "file:///tmp/form", "https://test.example/#fragment", "https:example.com"]) {
    assert.throws(() => loadApplicationConfig({ EVE_APPLICATION_DESTINATION: destination }));
  }
  assert.equal(loadApplicationConfig({ EVE_APPLICATION_DESTINATION: "http://127.0.0.1:8989/apply" }).destination, "http://127.0.0.1:8989/apply");
});

test("application limits, model and effort reject unsafe overrides", () => {
  for (const env of [
    { EVE_APPLICATION_MODEL: "another-model" }, { EVE_APPLICATION_EFFORT: "high" },
    { EVE_APPLICATION_ENABLED: "yes" }, { EVE_APPLICATION_MAX_ATTEMPTS: "0" },
    { EVE_APPLICATION_MAX_REPAIRS: "999" }, { EVE_APPLICATION_TIMEOUT_SECONDS: "Infinity" },
    { EVE_APPLICATION_WRITABLE_DIRS: '["/"]' }, { EVE_APPLICATION_TELEGRAM_TOKEN: "local-placeholder" },
  ]) assert.throws(() => loadApplicationConfig(env));
});
