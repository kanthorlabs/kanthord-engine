import { BudgetLimit } from "./run-outcome.ts";

const TIMER_LIMIT_MS = 2_147_483_647;

export const COMMAND_LIMIT_MS = 600000;

export interface RunBudget {
  deadline: number | null;
  usd: number | null;
}

export class WallTimer {
  private readonly deadline: number | null;
  private reached: BudgetLimit | null = null;
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(deadline: number | null) {
    this.deadline = deadline;
  }

  start(onReached: () => void): void {
    if (this.deadline === null) return;
    const remaining = Math.max(0, this.deadline - Date.now());
    this.handle = setTimeout(
      () => {
        if (remaining > TIMER_LIMIT_MS) {
          this.start(onReached);
          return;
        }
        this.reached = BudgetLimit.Wall;
        onReached();
      },
      Math.min(remaining, TIMER_LIMIT_MS),
    );
    this.handle.unref();
  }

  dispose(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  budgetReached(): BudgetLimit | null {
    return this.reached;
  }

  remainingMs(): number {
    if (this.deadline === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.deadline - Date.now());
  }
}

export class UsdTracker {
  private readonly limit: number | null;
  private reached: BudgetLimit | null = null;

  constructor(limit: number | null) {
    this.limit = limit;
  }

  check(listPriceUsd: number, onReached: () => void): void {
    if (this.limit === null) return;
    if (this.reached !== null) return;
    if (listPriceUsd >= this.limit) {
      this.reached = BudgetLimit.Usd;
      onReached();
    }
  }

  budgetReached(): BudgetLimit | null {
    return this.reached;
  }
}
