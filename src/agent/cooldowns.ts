import assert from "node:assert/strict";
import type { AgentConfig } from "./config.ts";
import { AdvancingFailure } from "./contract.ts";

const FIRST_STRIKE = 1;
const DOUBLING_BASE = 2;
const MAX_DOUBLINGS = 52;

function baseDuration(
  config: AgentConfig["cooldown"],
  code: AdvancingFailure,
): number {
  if (code === AdvancingFailure.RateLimited) return config.rate_limited_ms;
  if (code === AdvancingFailure.QuotaExhausted)
    return config.quota_exhausted_ms;
  return config.unavailable_ms;
}

export function cooldownDuration(
  config: AgentConfig["cooldown"],
  code: AdvancingFailure,
  strikes: number,
): number {
  assert.ok(Number.isSafeInteger(strikes) && strikes >= FIRST_STRIKE);
  const doublings = Math.min(strikes - FIRST_STRIKE, MAX_DOUBLINGS);
  return Math.min(
    config.max_ms,
    baseDuration(config, code) * DOUBLING_BASE ** doublings,
  );
}
