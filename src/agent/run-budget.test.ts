import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetLimit } from "./run-outcome.ts";
import { COMMAND_LIMIT_MS, WallTimer } from "./run-budget.ts";

const CLOCK_START = 1_000_000;
const WALL_MS = 1000;
const TIMER_LIMIT_MS = 2_147_483_647;

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

test("command limit with a null deadline is COMMAND_LIMIT_MS", () => {
  const timer = new WallTimer(null);
  assert.equal(
    Math.min(timer.remainingMs(), COMMAND_LIMIT_MS),
    COMMAND_LIMIT_MS,
  );
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
