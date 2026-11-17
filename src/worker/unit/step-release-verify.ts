import { DeadlineKind, type Step } from "./chain.ts";
import { verifyRelease } from "./release-gate.ts";
import { budgetEnd, next } from "./step-support.ts";

export const releaseVerify: Step<unknown, "state", "releaseCheck"> = {
  id: "release.verify",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: ["releaseCheck"],
  stops: [
    "operation_failed/worker.verification.infrastructure_failed",
    "environment_failed/verification_timeout",
    "environment_failed/command_absent",
    "environment_failed/setup_failed",
    "environment_failed/affected_invalid",
    "environment_failed/affected_timeout",
  ],
  note: "release trees, setup, every command, affected tests; gives the trees back; budget end",
  async run({ state }, scope) {
    const releaseCheck = await verifyRelease(state);
    return releaseCheck === null
      ? budgetEnd(scope)
      : next(scope, { releaseCheck });
  },
};
