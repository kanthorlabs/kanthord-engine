import assert from "node:assert/strict";
import { DeadlineKind, type Step } from "./chain.ts";
import { verificationCommands } from "./evaluation-input.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import { commandOwners } from "./release-gate.ts";
import { next, stepsInputOf } from "./step-support.ts";
import {
  runVerificationsWithOutput,
  VERIFICATION_RERUNS,
} from "./verification.ts";

export const verifyAllEvaluation: Step<
  unknown,
  | "claim"
  | "setup"
  | "sshAccess"
  | "revision"
  | "reviewWorkspace"
  | "testedInput"
  | "baseHead",
  "verification"
> = {
  id: "verify.all(evaluation)",
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "sshAccess",
    "revision",
    "reviewWorkspace",
    "testedInput",
    "baseHead",
  ],
  writes: ["verification"],
  stops: [],
  note: "every node and task command; the stop class goes to judgement",
  async run(ctx, scope, io) {
    const { revision, baseHead: base } = ctx;
    const input = stepsInputOf(ctx, io);
    assert.ok(ctx.reviewWorkspace.directory);
    assert.equal(input.claim.execution_id, input.setup.execution_id);
    const owners = commandOwners({ input, revision });
    const verification = await runVerificationsWithOutput({
      observe: verificationObserver(
        io.run.spans,
        testedCommitOf(ctx.testedInput),
        environmentDigestsOf(input.setup.repositories),
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
      context: io.run.operationContext,
      env: input.env,
      reruns: VERIFICATION_RERUNS,
      exhausted: () => io.budget.exhausted(),
      ...(base === null
        ? {}
        : { baseline: (command: string) => base.exitOf(command) }),
    });
    io.run.noteVerification(
      verification.verification.results.at(-1)?.timed_out ?? false,
    );
    return next(scope, { verification });
  },
};
