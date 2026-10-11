import assert from "node:assert/strict";
import { test } from "node:test";
import { background, DeadlineExceeded } from "../kernel/context.ts";
import { BudgetLimit } from "../scheduler/contract.ts";
import { ExecutionBudget } from "./budget.ts";

test("budget bounds wall time, counts turns and keeps cleanup until execution expiry", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
  const input = {
    created_at: Date.now(),
    expired_at: 20000,
    resource_budget: { turns: 2, wall_time_ms: 5000 },
  };
  const budget = new ExecutionBudget(input);
  const wallDeadline = 15000;
  assert.equal(budget.wallDeadline(), wallDeadline);
  const agent = budget.agentContext(background);
  const cleanup = budget.cleanupContext(background);
  assert.equal(budget.exhaustedAfterTurn(), false);
  budget.turnEnded();
  assert.equal(budget.exhausted(), false);
  assert.equal(budget.exhaustedAfterTurn(), true);
  budget.turnEnded();
  assert.equal(budget.exhausted(), true);
  assert.ok(agent.err());
  const uncapped = new ExecutionBudget({
    ...input,
    resource_budget: { wall_time_ms: 5000 },
  });
  uncapped.turnEnded();
  assert.equal(uncapped.exhausted(), false);
  assert.equal(uncapped.exhaustedAfterTurn(), false);
  const wallAgent = uncapped.agentContext(background);
  t.mock.timers.tick(5000);
  assert.ok(wallAgent.err());
  assert.equal(cleanup.err(), null);
  t.mock.timers.tick(5000);
  assert.ok(cleanup.err());
  assert.equal(
    new ExecutionBudget({
      ...input,
      resource_budget: { wall_time_ms: 50000 },
    }).wallDeadline(),
    input.expired_at,
  );
});

test("remaining wall time measures monotonic elapsed time", (t) => {
  const exhausted = 0;
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const createdAt = Date.now();
  const budget = new ExecutionBudget({
    created_at: createdAt,
    expired_at: createdAt + 10000,
    resource_budget: { wall_time_ms: 5000 },
  });
  const before = budget.remainingMs();
  now += 1000;
  assert.equal(budget.remainingMs(), before - 1000);
  now += 10000;
  assert.equal(budget.remainingMs(), exhausted);
});

test("an agent context that reaches its deadline ends the budget", (t) => {
  const exhausted = 0;
  let monotonic = 0;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const input = {
    created_at: 0,
    expired_at: 10000,
    resource_budget: { wall_time_ms: 5000 },
  };
  const budget = new ExecutionBudget(input);
  monotonic = 1000;
  t.mock.timers.setTime(1500);
  const agent = budget.agentContext(background);
  monotonic = 4500;
  t.mock.timers.tick(3500);
  assert.ok(agent.err() instanceof DeadlineExceeded);
  assert.equal(budget.exhausted(), true);
  assert.equal(budget.remainingMs(), exhausted);
  assert.equal(budget.limit(), BudgetLimit.WallTime);
  const open = new ExecutionBudget({ ...input, created_at: Date.now() });
  open.agentContext(background).cancel();
  assert.equal(open.exhausted(), false);
});
