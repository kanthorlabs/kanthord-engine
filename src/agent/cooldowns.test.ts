import assert from "node:assert/strict";
import { test } from "node:test";
import { COOLDOWN_DEFAULTS } from "./config.ts";
import { AdvancingFailure } from "./contract.ts";
import { cooldownDuration } from "./cooldowns.ts";

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;

test("a cooldown doubles its code base for each strike up to the maximum", () => {
  const { RateLimited, Unavailable, QuotaExhausted } = AdvancingFailure;
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 1), MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 3), 4 * MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, Unavailable, 2), 2 * MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, QuotaExhausted, 1), HOUR);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, QuotaExhausted, 6), DAY);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 5000), DAY);
});
