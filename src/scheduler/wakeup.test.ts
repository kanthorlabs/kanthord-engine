import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { background, CancellationContext } from "../kernel/context.ts";
import { WaitingPulls } from "./wakeup.ts";

const WAIT_MS = 1000;
const NO_WAITERS = 0;
const TWO_WAITERS = 2;
const PROJECT = "project";
const FIRST = "first";
const SECOND = "second";

test("project wakeups coalesce and preserve waiter arrival order", async (t) => {
  const waiting = new WaitingPulls();
  t.after(() => waiting.wakeAll());
  const order: string[] = [];
  const first = waiting
    .park(PROJECT, FIRST, WAIT_MS, background)
    .then(() => order.push(FIRST));
  const second = waiting
    .park(PROJECT, SECOND, WAIT_MS, background)
    .then(() => order.push(SECOND));
  assert.equal(waiting.size(), TWO_WAITERS);
  assert.equal(waiting.pulling(FIRST), true);
  waiting.wake("another-project");
  await turn();
  assert.deepEqual(order, []);
  waiting.wake(PROJECT);
  waiting.wake(PROJECT);
  await Promise.all([first, second]);
  assert.deepEqual(order, [FIRST, SECOND]);
  assert.equal(waiting.size(), NO_WAITERS);
  assert.equal(waiting.pulling(FIRST), false);
  assert.deepEqual(waiting.projectIds(), []);
});

test("timer, cancellation and wakeAll release every waiter and owned timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const waiting = new WaitingPulls();
  const cancelled = new CancellationContext();
  const first = waiting.park(PROJECT, FIRST, WAIT_MS, background);
  const second = waiting.park(PROJECT, SECOND, WAIT_MS, cancelled);
  cancelled.cancel();
  await second;
  assert.equal(waiting.pulling(SECOND), false);
  t.mock.timers.tick(WAIT_MS);
  await first;
  assert.equal(waiting.size(), NO_WAITERS);
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const last = waiting.park(PROJECT, FIRST, WAIT_MS, background);
  waiting.wake(PROJECT);
  waiting.wakeAll();
  await last;
  const ONE_TIMER = 1;
  assert.equal(cleared.mock.callCount(), ONE_TIMER);
  assert.equal(waiting.size(), NO_WAITERS);
  await waiting.park(PROJECT, FIRST, WAIT_MS, cancelled);
  assert.equal(waiting.size(), NO_WAITERS);
});
