import { BudgetLimit } from "./run-outcome.ts";
import { COMMAND_LIMIT_MS } from "./tool-table.ts";

export { COMMAND_LIMIT_MS };

export interface RunBudget {
  deadline: number | null;
  usd: number | null;
}

export class WallTimer {
  private readonly deadline: number | null;
  private _budgetReached: BudgetLimit | null = null;
  private handle: ReturnType<typeof setTimeout> | null = null;

  constructor(deadline: number | null) {
    this.deadline = deadline;
  }

  start(onReached: () => void): void {
    if (this.deadline === null) return;
    const remaining = Math.max(0, this.deadline - Date.now());
    this.handle = setTimeout(() => {
      this._budgetReached = BudgetLimit.Wall;
      onReached();
    }, remaining);
  }

  dispose(): void {
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  budgetReached(): BudgetLimit | null {
    return this._budgetReached;
  }

  remainingMs(): number {
    if (this.deadline === null) return COMMAND_LIMIT_MS;
    return Math.min(Math.max(0, this.deadline - Date.now()), COMMAND_LIMIT_MS);
  }
}
