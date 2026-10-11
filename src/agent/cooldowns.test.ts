import assert from "node:assert/strict";
import { test } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { COOLDOWN_DEFAULTS } from "./config.ts";
import { AGENT_COMPONENT_NAME, AdvancingFailure } from "./contract.ts";
import {
  cooldownDuration,
  cooldownOf,
  deleteCooldown,
  deleteCooldownOf,
  listCooldowns,
  startCooldown,
} from "./cooldowns.ts";
import { agentMigrations } from "./migrations.ts";

const NOW = 1_000_000;
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const FIRST_STRIKE = 1;
const SECOND_STRIKE = 2;
const key = { credential: "qwen", model_identifier: "qwen3.6-plus" };
const EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA";

test("a cooldown doubles its code base for each strike up to the maximum", () => {
  const { RateLimited, Unavailable, QuotaExhausted } = AdvancingFailure;
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 1), MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 3), 4 * MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, Unavailable, 2), 2 * MINUTE);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, QuotaExhausted, 1), HOUR);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, QuotaExhausted, 6), DAY);
  assert.equal(cooldownDuration(COOLDOWN_DEFAULTS, RateLimited, 5000), DAY);
});

test("a repeated advance on one key adds a strike to the same row and a delete removes it", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      { service: AGENT_COMPONENT_NAME, migrations: agentMigrations },
    ]);
    store.transaction((tx) => {
      const first = startCooldown(
        tx,
        COOLDOWN_DEFAULTS,
        key,
        AdvancingFailure.RateLimited,
        EXECUTION,
        NOW,
      );
      assert.equal(first.strikes, FIRST_STRIKE);
      assert.equal(first.until_at, NOW + MINUTE);
      const second = startCooldown(
        tx,
        COOLDOWN_DEFAULTS,
        key,
        AdvancingFailure.QuotaExhausted,
        EXECUTION,
        NOW,
      );
      assert.equal(second.cooldown_id, first.cooldown_id);
      assert.equal(second.strikes, SECOND_STRIKE);
      assert.equal(second.until_at, NOW + 2 * HOUR);
      assert.deepEqual(cooldownOf(tx, key), second);
      assert.deepEqual(listCooldowns(tx), [second]);
      assert.equal(deleteCooldownOf(tx, key), true);
      assert.equal(deleteCooldownOf(tx, key), false);
      const third = startCooldown(
        tx,
        COOLDOWN_DEFAULTS,
        key,
        AdvancingFailure.Unavailable,
        EXECUTION,
        NOW,
      );
      assert.equal(third.strikes, FIRST_STRIKE);
      assert.equal(deleteCooldown(tx, third.cooldown_id), true);
      assert.deepEqual(listCooldowns(tx), []);
    });
  } finally {
    store.close();
  }
});
