import assert from "node:assert/strict";
import { test } from "node:test";
import { HeartbeatClock } from "./heartbeat.ts";

const START = 100;
const WINDOW = 1;
const WINDOW_MS = 1000;
const BEYOND = 1;
const REGISTRATION = "worker-registration";
test("heartbeats renew only existing readings and expire strictly beyond the window", () => {
  let now = START;
  const clock = new HeartbeatClock(() => now);
  clock.renew(REGISTRATION);
  assert.equal(clock.ageMs(REGISTRATION), null);
  clock.set(REGISTRATION);
  now += WINDOW_MS;
  assert.deepEqual(clock.expired(WINDOW), []);
  assert.equal(clock.ageMs(REGISTRATION), WINDOW_MS);
  now += BEYOND;
  assert.deepEqual(clock.expired(WINDOW), [REGISTRATION]);
  clock.renew(REGISTRATION);
  assert.deepEqual(clock.expired(WINDOW), []);
  clock.drop(REGISTRATION);
  assert.equal(clock.ageMs(REGISTRATION), null);
});
