import assert from "node:assert/strict";
import { DeadlineKind, type Step } from "./chain.ts";
import { budgetEnd, next } from "./step-support.ts";
import type { UnitScope } from "./step-unit-enter.ts";
import { taskWork } from "./steps-implement.ts";

export const unitTurn: Step<UnitScope, "state", never> = {
  id: "unit.turn",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: [
    "provider_failed",
    "revoked",
    "operation_failed/worker.turn.*",
    "operation_failed/worker.git.commit_failed",
  ],
  llm: true,
  note: "claim check; Work | TaskRevision | CriterionRevision; gate G in write mode; budget end",
  async run({ state }, scope) {
    const budget = state.agent.budget;
    const agent = scope.gated;
    assert.ok(agent);
    if (budget.exhausted()) return budgetEnd(scope);
    await state.run.checkClaim();
    scope.unchangedBefore = state.unchangedTurns;
    const work = taskWork(state, scope.unit);
    if (scope.instruction === null) await agent.prompt(work);
    else await agent.instruct(work, scope.instruction, scope.template);
    return budget.exhausted() ? budgetEnd(scope) : next(scope);
  },
};
