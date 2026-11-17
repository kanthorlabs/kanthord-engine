import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { budgetEnd, next, stopsReturned } from "./step-support.ts";
import { runnerOf, type UnitScope } from "./step-unit-enter.ts";
import { TaskResultKind } from "./steps-implement.ts";

export const unitRunner: FoundryStep<UnitScope, "state", never> = {
  foundry: true,
  id: "unit.runner",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: [],
  note: "the given task runner in place of the revisions of a task unit",
  run({ state }, scope) {
    return stopsReturned(scope, async () => {
      const runner = runnerOf(scope);
      if (runner === null) return next(scope);
      scope.result = await runner(state, scope.unit, scope.instruction);
      return scope.result.kind === TaskResultKind.BudgetEnd
        ? budgetEnd(scope)
        : next(scope);
    });
  },
};
