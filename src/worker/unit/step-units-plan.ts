import { DeadlineKind, type Step } from "./chain.ts";
import { next } from "./step-support.ts";
import { startCheck } from "./steps-implement.ts";

export const unitsPlan: Step<unknown, "state", "plan"> = {
  id: "units.plan",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: ["plan"],
  stops: [],
  note: "verdict rule, done records, pending units",
  async run({ state }, scope) {
    return next(scope, { plan: await startCheck(state) });
  },
};
