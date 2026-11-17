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
  note: "port: releaseTrees.take, releaseTrees.takeBase, releaseTrees.give; release trees, setup, every command, affected tests; gives the trees back; budget end",
  async run({ state }, scope, io) {
    const releaseCheck = await verifyRelease(state, io.ports);
    return releaseCheck === null
      ? budgetEnd(scope)
      : next(scope, { releaseCheck });
  },
};
