import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
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
  budget.turnEnded();
  assert.equal(budget.exhausted(), false);
  budget.turnEnded();
  assert.equal(budget.exhausted(), true);
  assert.ok(agent.err());
  const uncapped = new ExecutionBudget({
    ...input,
    resource_budget: { wall_time_ms: 5000 },
  });
  uncapped.turnEnded();
  assert.equal(uncapped.exhausted(), false);
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
