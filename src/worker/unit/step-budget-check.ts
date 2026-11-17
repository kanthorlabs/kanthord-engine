import { DeadlineKind, type Step } from "./chain.ts";
import { budgetEnd, next } from "./step-support.ts";

export const budgetCheck: Step<unknown, "state", never> = {
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
