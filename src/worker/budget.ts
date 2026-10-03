import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../kernel/context.ts";

const ZERO = 0;
export class ExecutionBudget {
  private readonly deadline: number;
  private readonly expiredAt: number;
  private readonly started = performance.now();
  private readonly remaining: number;
  private readonly turns?: number;
  private endedTurns = ZERO;
  private readonly agents = new Set<CancellationContext>();

  constructor(input: {
    createdAt: number;
    expiredAt: number;
    resourceBudget: { turns?: number; wallTimeMs: number };
  }) {
    assert.ok(
      Number.isSafeInteger(input.createdAt) &&
        Number.isSafeInteger(input.expiredAt),
    );
    assert.ok(
      Number.isSafeInteger(input.resourceBudget.wallTimeMs) &&
        input.resourceBudget.wallTimeMs > ZERO,
    );
    assert.ok(
      input.resourceBudget.turns === undefined ||
        (Number.isSafeInteger(input.resourceBudget.turns) &&
          input.resourceBudget.turns > ZERO),
    );
    this.deadline = Math.min(
      input.createdAt + input.resourceBudget.wallTimeMs,
      input.expiredAt,
    );
    this.expiredAt = input.expiredAt;
    this.remaining = Math.max(ZERO, this.deadline - Date.now());
    this.turns = input.resourceBudget.turns;
  }
  wallDeadline(): number {
    return this.deadline;
  }
  remainingMs(): number {
    return Math.max(ZERO, this.remaining - (performance.now() - this.started));
  }
  turnEnded(): void {
    assert.ok(Number.isSafeInteger(this.endedTurns));
    assert.ok(this.endedTurns >= ZERO);
    this.endedTurns++;
    if (this.exhausted()) for (const context of this.agents) context.cancel();
  }
  exhausted(): boolean {
    return (
      (this.turns !== undefined && this.endedTurns >= this.turns) ||
      this.remainingMs() <= ZERO
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
