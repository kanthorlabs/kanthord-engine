import assert from "node:assert/strict";
import { test } from "node:test";
import { HeartbeatClock } from "./heartbeat.ts";

const START = 100;
const WINDOW = 1;
const WINDOW_MS = 1000;
const BEYOND = 1;
const INSTANCE = "worker-instance";
test("heartbeats renew only existing readings and expire strictly beyond the window", () => {
  let now = START;
  const clock = new HeartbeatClock(() => now);
  clock.renew(INSTANCE);
  assert.equal(clock.ageMs(INSTANCE), null);
  clock.set(INSTANCE);
  now += WINDOW_MS;
  assert.deepEqual(clock.expired(WINDOW), []);
  assert.equal(clock.ageMs(INSTANCE), WINDOW_MS);
  now += BEYOND;
  assert.deepEqual(clock.expired(WINDOW), [INSTANCE]);
  clock.renew(INSTANCE);
  assert.deepEqual(clock.expired(WINDOW), []);
  clock.drop(INSTANCE);
  assert.equal(clock.ageMs(INSTANCE), null);
});
