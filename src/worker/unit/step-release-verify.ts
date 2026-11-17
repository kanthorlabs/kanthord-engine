import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { ExecutionStop } from "./execution-stop.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { verifyRelease } from "./release-gate.ts";
import { budgetEnd, next, stopped } from "./step-support.ts";

export const releaseVerify: FoundryStep<
  unknown,
  "state",
  "releaseCheck" | "verificationTimedOut",
  ImplementPorts
> = {
  foundry: true,
  id: "release.verify",
  ports: ["releaseTrees.take", "releaseTrees.takeBase", "releaseTrees.give"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: ["releaseCheck", "verificationTimedOut"],
  stops: [
    "operation_failed/worker.verification.infrastructure_failed",
    "environment_failed/verification_timeout",
    "environment_failed/command_absent",
    "environment_failed/setup_failed",
    "environment_failed/affected_invalid",
    "environment_failed/affected_timeout",
  ],
  note: "release trees, setup, every command, affected tests; gives the trees back; budget end",
  async run({ state }, scope, io) {
    const noted = () => ({ verificationTimedOut: state.verificationTimedOut });
    try {
      const releaseCheck = await verifyRelease(state, io.ports);
      return releaseCheck === null
        ? { ...budgetEnd(scope), patch: noted() }
        : next(scope, { releaseCheck, ...noted() });
    } catch (error) {
      if (!(error instanceof ExecutionStop)) throw error;
      return { ...stopped(scope, error), patch: noted() };
    }
  },
};
