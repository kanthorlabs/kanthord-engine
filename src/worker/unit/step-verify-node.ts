import { DeadlineKind, type FoundryStep } from "./chain.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
} from "./method-telemetry.ts";
import { budgetMapped, next } from "./step-support.ts";
import { runVerifications } from "./verification.ts";

export const verifyNode: FoundryStep<
  unknown,
  "claim" | "setup" | "revision" | "reviewWorkspace",
  "nodeVerification" | "verificationTimedOut"
> = {
  foundry: true,
  id: "verify.node",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "revision", "reviewWorkspace"],
  writes: ["nodeVerification", "verificationTimedOut"],
  stops: [],
  note: "node commands at the base heads; skipped with no checkout",
  run(ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const workspace = ctx.reviewWorkspace;
      const nodeVerification =
        workspace.tested_input === null
          ? null
          : await runVerifications({
              observe: verificationObserver(
                io.ports.telemetry,
                testedCommitOf(workspace.tested_input),
                environmentDigestsOf(ctx.setup.repositories),
                {
                  context: VerificationContext.Node,
                  ownerOf: () => ctx.claim.node_id,
                },
              ),
              directory: workspace.directory,
              commands: ctx.revision.content.verifications,
              tested_input: workspace.tested_input,
              deadline: io.budget.wallDeadline(),
              context: io.context,
              env: io.env,
            });
      return next(scope, {
        nodeVerification,
        verificationTimedOut:
          nodeVerification?.results.at(-1)?.timed_out ?? false,
      });
    });
  },
};
