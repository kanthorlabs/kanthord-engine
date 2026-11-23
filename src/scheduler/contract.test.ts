import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderFailure,
  providerFailureOf,
  releaseStopSchema,
} from "./contract.ts";

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

test("a provider error text maps to its failure code", () => {
  const cases: [string, ProviderFailure][] = [
    [
      'server_error: Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the "use free tier only" mode.',
      ProviderFailure.QuotaExhausted,
    ],
    [
      "You've hit your usage limit. Try again later.",
      ProviderFailure.QuotaExhausted,
    ],
    [
      "429 Rate limit exceeded: free-models-per-day",
      ProviderFailure.RateLimited,
    ],
    ["403 Forbidden: only agentic harnesses", ProviderFailure.Unauthorized],
    ["401 Unauthorized", ProviderFailure.Unauthorized],
    [
      "InvalidParameter: <400> InternalError.Algo.InvalidParameter: role tool must be one of user,assistant,system,function",
      ProviderFailure.BadRequest,
    ],
    ["503 Service Unavailable", ProviderFailure.Unavailable],
    ["fetch failed", ProviderFailure.Unavailable],
  ];
  for (const [message, failure] of cases)
    assert.equal(providerFailureOf(message), failure, message);
});
