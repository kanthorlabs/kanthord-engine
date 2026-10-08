import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../kernel/context.ts";

const BUDGET_FLOOR = 0;
export class ExecutionBudget {
  private readonly deadline: number;
  private readonly expiredAt: number;
  private readonly started = performance.now();
  private readonly remaining: number;
  private readonly turns?: number;
  private endedTurns = BUDGET_FLOOR;
  private readonly agents = new Set<CancellationContext>();

  constructor(input: {
    created_at: number;
    expired_at: number;
    resource_budget: { turns?: number; wall_time_ms: number };
  }) {
    assert.ok(
      Number.isSafeInteger(input.created_at) &&
        Number.isSafeInteger(input.expired_at),
    );
    assert.ok(
      Number.isSafeInteger(input.resource_budget.wall_time_ms) &&
        input.resource_budget.wall_time_ms > BUDGET_FLOOR,
    );
    assert.ok(
      input.resource_budget.turns === undefined ||
        (Number.isSafeInteger(input.resource_budget.turns) &&
          input.resource_budget.turns > BUDGET_FLOOR),
    );
    this.deadline = Math.min(
      input.created_at + input.resource_budget.wall_time_ms,
      input.expired_at,
    );
    this.expiredAt = input.expired_at;
    this.remaining = Math.max(BUDGET_FLOOR, this.deadline - Date.now());
    this.turns = input.resource_budget.turns;
  }
  wallDeadline(): number {
    return this.deadline;
  }
  remainingMs(): number {
    return Math.max(
      BUDGET_FLOOR,
      this.remaining - (performance.now() - this.started),
    );
  }
  turnEnded(): void {
    assert.ok(Number.isSafeInteger(this.endedTurns));
    assert.ok(this.endedTurns >= BUDGET_FLOOR);
    this.endedTurns++;
    if (this.exhausted()) for (const context of this.agents) context.cancel();
  }
  exhausted(): boolean {
    return this.exhaustedAt(this.endedTurns);
  }
  exhaustedAfterTurn(): boolean {
    return this.exhaustedAt(this.endedTurns + 1);
  }
  private exhaustedAt(endedTurns: number): boolean {
    return (
      (this.turns !== undefined && endedTurns >= this.turns) ||
      this.remainingMs() <= BUDGET_FLOOR
    );
  }
  agentContext(parent: Context): CancellationContext {
    assert.ok(parent);
    assert.ok(Number.isSafeInteger(this.deadline));
    const context = new CancellationContext(parent, this.deadline);
    this.agents.add(context);
    context.onCancel(() => this.agents.delete(context));
    if (this.exhausted()) context.cancel();
    return context;
  }
  cleanupContext(parent: Context): CancellationContext {
    assert.ok(parent);
    assert.ok(Number.isSafeInteger(this.expiredAt));
    return new CancellationContext(parent, this.expiredAt);
  }
}
