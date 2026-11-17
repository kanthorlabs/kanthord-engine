import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { budgetEnd, next } from "./step-support.ts";

export const budgetCheck: FoundryStep<unknown, "state", never> = {
  foundry: true,
  id: "budget.check",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: [],
  note: "budget end at the start of a round",
  async run({ state }, scope) {
    return state.agent.budget.exhausted() ? budgetEnd(scope) : next(scope);
  },
};
