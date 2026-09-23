import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { Idempotency } from "./idempotency.ts";
import { HttpStatus } from "../kernel/http.ts";

const TTL_SECONDS = 1;
const TTL_MS = 1000;
const SWEEP_MS = 60000;

test("memory replay isolates answers, callers, routes and fingerprints and expires on access", (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const component = new Idempotency(TTL_SECONDS);
  t.after(() => component.stop());
  const key = ulid();
  const held = component.reserve(key, "first", "write", "digest");
  assert.throws(
    () => component.reserve(key, "first", "write", "digest"),
    /cannot be replayed/,
  );
  const response = { status: HttpStatus.OK, body: { value: "original" } };
  component.complete(held.reservation, response);
  response.body.value = "changed";
  assert.deepEqual(
    component.reserve(key, "first", "write", "digest").replay?.body,
    { value: "original" },
  );
  assert.throws(
    () => component.reserve(key, "first", "other", "digest"),
    /cannot be replayed/,
  );
  assert.throws(
    () => component.reserve(key, "first", "write", "other"),
    /cannot be replayed/,
  );
  assert.equal(
    component.reserve(key, "second", "write", "digest").replay,
    undefined,
  );
  now += TTL_MS;
  const replacement = component.reserve(key, "first", "write", "digest");
  assert.equal(replacement.replay, undefined);
  component.complete(held.reservation, response);
  assert.throws(
    () => component.reserve(key, "first", "write", "digest"),
    /cannot be replayed/,
  );
  component.complete(replacement.reservation, response, true);
  assert.throws(
    () => component.reserve(key, "first", "write", "digest"),
    /cannot be replayed/,
  );
  assert.equal(component.healthcheck(), true);
  component.stop();
  assert.equal(component.healthcheck(), false);
});

test("timer sweeps expired records and stop clears its timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const component = new Idempotency(TTL_SECONDS);
  const key = ulid();
  const first = component.reserve(key, "caller", "write", "digest");
  t.mock.timers.tick(SWEEP_MS);
  t.mock.timers.setTime(0);
  const next = component.reserve(key, "caller", "write", "digest");
  assert.notEqual(next.reservation, first.reservation);
  assert.equal(next.replay, undefined);
  component.stop();
  t.mock.timers.tick(SWEEP_MS);
  assert.equal(component.healthcheck(), false);
});
