import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetLimit } from "./run-outcome.ts";
import { UsdTracker, WallTimer } from "./run-budget.ts";

const CLOCK_START = 1_000_000;
const WALL_MS = 1000;
const TIMER_LIMIT_MS = 2_147_483_647;
const EXPIRED_MS = 0;
const ONCE = 1;

test("WallTimer fires at the deadline and sets budgetReached to wall", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK_START });
  const timer = new WallTimer(CLOCK_START + WALL_MS);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  t.mock.timers.tick(WALL_MS - 1);
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
  t.mock.timers.tick(1);
  timer.dispose();
  assert.equal(fired, true);
  assert.equal(timer.budgetReached(), BudgetLimit.Wall);
});

test("WallTimer dispose prevents the callback from firing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK_START });
  const timer = new WallTimer(CLOCK_START + WALL_MS);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  timer.dispose();
  t.mock.timers.tick(WALL_MS);
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
});

test("WallTimer with null deadline never fires", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK_START });
  const timer = new WallTimer(null);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  t.mock.timers.tick(TIMER_LIMIT_MS);
  timer.dispose();
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
});

test("remainingMs gives the time to the deadline, zero after it, and no limit with a null deadline", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: CLOCK_START });
  const timer = new WallTimer(CLOCK_START + WALL_MS);
  assert.equal(timer.remainingMs(), WALL_MS);
  t.mock.timers.tick(WALL_MS * 2);
  assert.equal(timer.remainingMs(), EXPIRED_MS);
  assert.equal(new WallTimer(null).remainingMs(), Number.POSITIVE_INFINITY);
});

test("regression: WallTimer with a deadline past the setTimeout limit does not fire at once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: CLOCK_START });
  const deadline = CLOCK_START + TIMER_LIMIT_MS + WALL_MS;
  const timer = new WallTimer(deadline);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  t.mock.timers.tick(TIMER_LIMIT_MS);
  assert.equal(fired, false);
  t.mock.timers.tick(WALL_MS);
  timer.dispose();
  assert.equal(fired, true);
  assert.equal(timer.budgetReached(), BudgetLimit.Wall);
});

test("UsdTracker fires the callback when list price equals the limit and sets budgetReached to usd", () => {
  const tracker = new UsdTracker(1.0);
  let fired = false;
  tracker.check(1.0, () => {
    fired = true;
  });
  assert.equal(fired, true);
  assert.equal(tracker.budgetReached(), BudgetLimit.Usd);
});

test("UsdTracker fires the callback when list price exceeds the limit", () => {
  const tracker = new UsdTracker(0.5);
  let fired = false;
  tracker.check(0.75, () => {
    fired = true;
  });
  assert.equal(fired, true);
  assert.equal(tracker.budgetReached(), BudgetLimit.Usd);
});

test("UsdTracker does not fire when list price is below the limit", () => {
  const tracker = new UsdTracker(1.0);
  let fired = false;
  tracker.check(0.5, () => {
    fired = true;
  });
  assert.equal(fired, false);
  assert.equal(tracker.budgetReached(), null);
});

test("UsdTracker with null limit never fires", () => {
  const tracker = new UsdTracker(null);
  let fired = false;
  tracker.check(1000000, () => {
    fired = true;
  });
  assert.equal(fired, false);
  assert.equal(tracker.budgetReached(), null);
});

test("L3-U6 first limit: UsdTracker fires the callback only once when check is called multiple times with price at or above the limit", () => {
  const tracker = new UsdTracker(1.0);
  let count = 0;
  tracker.check(1.0, () => {
    count += 1;
  });
  tracker.check(2.0, () => {
    count += 1;
  });
  assert.equal(count, ONCE);
  assert.equal(tracker.budgetReached(), BudgetLimit.Usd);
});

test("UsdTracker fires when float sum 0.70 + 0.10 reaches a limit of 0.80", () => {
  const tracker = new UsdTracker(0.8);
  let fired = false;
  tracker.check(0.7 + 0.1, () => {
    fired = true;
  });
  assert.equal(fired, true);
  assert.equal(tracker.budgetReached(), BudgetLimit.Usd);
});
