import assert from "node:assert/strict";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { verificationCommands } from "./review-scope.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import { commandOwners } from "./release-gate.ts";
import { next } from "./step-support.ts";
import {
  runVerificationsWithOutput,
  VERIFICATION_RERUNS,
} from "./verification.ts";

export const verifyAllEvaluation: FoundryStep<
  unknown,
  | "claim"
  | "setup"
  | "env"
  | "revision"
  | "reviewWorkspace"
  | "testedInput"
  | "baseHead",
  "verification" | "verificationTimedOut"
> = {
  foundry: true,
  id: "verify.all(evaluation)",
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "env",
    "revision",
    "reviewWorkspace",
    "testedInput",
    "baseHead",
  ],
  writes: ["verification", "verificationTimedOut"],
  stops: [],
  note: "every node and task command; the stop class goes to judgement",
  async run(ctx, scope, io) {
    const { claim, setup, revision, baseHead: base } = ctx;
    assert.ok(ctx.reviewWorkspace.directory);
    assert.equal(claim.execution_id, setup.execution_id);
    const owners = commandOwners(claim.node_id, revision);
    const verification = await runVerificationsWithOutput({
      observe: verificationObserver(
        io.ports.telemetry,
        testedCommitOf(ctx.testedInput),
        environmentDigestsOf(setup.repositories),
        {
          context: VerificationContext.Evaluation,
          ownerOf: (index) => owners[index]!.id,
        },
      ),
      directory: ctx.reviewWorkspace.directory,
      commands: verificationCommands(revision),
      copyRepeated: true,
      tested_input: ctx.testedInput,
      deadline: io.budget.wallDeadline(),
      context: io.context,
      env: ctx.env,
      reruns: VERIFICATION_RERUNS,
      exhausted: () => io.budget.exhausted(),
      ...(base === null
        ? {}
        : { baseline: (command: string) => base.exitOf(command) }),
    });
    return next(scope, {
      verification,
      verificationTimedOut:
        verification.verification.results.at(-1)?.timed_out ?? false,
    });
  },
};
