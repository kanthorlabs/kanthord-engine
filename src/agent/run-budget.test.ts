import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetLimit } from "./run-outcome.ts";
import { WallTimer } from "./run-budget.ts";

test("WallTimer fires at the deadline and sets budgetReached to wall", async () => {
  const deadline = Date.now() + 20;
  const timer = new WallTimer(deadline);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  timer.dispose();
  assert.equal(fired, true);
  assert.equal(timer.budgetReached(), BudgetLimit.Wall);
});

test("WallTimer does not fire before the deadline", async () => {
  const deadline = Date.now() + 200;
  const timer = new WallTimer(deadline);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  timer.dispose();
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
});

test("WallTimer dispose prevents the callback from firing", async () => {
  const deadline = Date.now() + 30;
  const timer = new WallTimer(deadline);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  timer.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
});

test("WallTimer with null deadline never fires", async () => {
  const timer = new WallTimer(null);
  let fired = false;
  timer.start(() => {
    fired = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  timer.dispose();
  assert.equal(fired, false);
  assert.equal(timer.budgetReached(), null);
});
