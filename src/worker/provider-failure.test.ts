import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderFailure } from "../scheduler/contract.ts";
import { providerFailureOf } from "./provider-failure.ts";

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
