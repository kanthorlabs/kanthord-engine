import assert from "node:assert/strict";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { budgetEnd, next, stopsReturned } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import { taskWork } from "./steps-implement.ts";

export const unitTurn: FoundryStep<UnitScope, "state", never, ImplementPorts> =
  {
    foundry: true,
    id: "unit.turn",
    ports: ["secrets.redact"],
    deadline: DeadlineKind.Work,
    reads: ["state"],
    writes: [],
    stops: [
      "provider_failed",
      "operation_failed/worker.turn.*",
      "operation_failed/worker.git.commit_failed",
    ],
    llm: true,
    note: "Work | TaskRevision | CriterionRevision; gate G in write mode; budget end",
    run({ state }, scope) {
      return stopsReturned(scope, async () => {
        const budget = state.agent.budget;
        const agent = scope.gated;
        assert.ok(agent);
        if (budget.exhausted()) return budgetEnd(scope);
        scope.unchangedBefore = state.unchangedTurns;
        const work = taskWork(state, scope.unit);
        if (scope.instruction === null) await agent.prompt(work);
        else await agent.instruct(work, scope.instruction, scope.template);
        return budget.exhausted() ? budgetEnd(scope) : next(scope);
      });
    },
  };
