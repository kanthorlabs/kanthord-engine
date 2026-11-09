import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseStopSchema } from "./contract.ts";

test("a release stop code fits its reason", () => {
  const fits = (reason: string, code: string | null) =>
    releaseStopSchema.safeParse({ reason, code }).success;
  assert.equal(fits("provider_failed", "quota_exhausted"), true);
  assert.equal(fits("provider_failed", null), false);
  assert.equal(fits("provider_failed", "turns"), false);
  assert.equal(fits("no_progress", null), true);
  assert.equal(fits("no_progress", "rate_limited"), false);
  assert.equal(fits("operation_failed", "rate_limited"), false);
  assert.equal(fits("operation_failed", "gateway.request.invalid"), true);
  assert.equal(fits("budget_end", "turns"), true);
  assert.equal(fits("budget_end", null), false);
  assert.equal(fits("environment_failed", "setup_failed"), true);
  assert.equal(fits("environment_failed", "command_absent"), true);
  assert.equal(fits("environment_failed", "affected_invalid"), true);
  assert.equal(fits("environment_failed", "affected_timeout"), true);
  assert.equal(fits("environment_failed", null), false);
  assert.equal(fits("environment_failed", "turns"), false);
  assert.equal(fits("operation_failed", "setup_failed"), false);
  assert.equal(fits("operation_failed", "affected_invalid"), false);
  assert.equal(fits("operation_failed", "affected_timeout"), false);
});
