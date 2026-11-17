import { DeadlineKind, type Step } from "./chain.ts";
import { budgetEnd, next } from "./step-support.ts";
import { runnerOf, type UnitScope } from "./step-unit-enter.ts";
import { TaskResultKind } from "./steps-implement.ts";

export const unitRunner: Step<UnitScope, "state", never> = {
  id: "unit.runner",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: [],
  note: "the given task runner in place of the revisions of a task unit",
  async run({ state }, scope) {
    const runner = runnerOf(scope);
    if (runner === null) return next(scope);
    scope.result = await runner(state, scope.unit, scope.instruction);
    return scope.result.kind === TaskResultKind.BudgetEnd
      ? budgetEnd(scope)
      : next(scope);
  },
};
