import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
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
