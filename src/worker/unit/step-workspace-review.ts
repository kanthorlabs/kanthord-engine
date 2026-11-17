import { EndReason } from "./execution-stop.ts";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { placedOf, reviewWorkspaceOf } from "./evaluation-input.ts";
import { next, wallDeadlineOf } from "./step-support.ts";
import { hostInputOf } from "./chain-host.ts";

export const workspaceReviewBase: Step<
  unknown,
  "claim" | "setup" | "sshAccess",
  "reviewWorkspace"
> = {
  id: "workspace.review(base)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess"],
  writes: ["reviewWorkspace"],
  stops: ["operation_failed/repository.connector.git_failed"],
  note: "one tree per binding at its base head",
  async run(ctx, scope, io) {
    const input = hostInputOf(ctx, io);
    const reviewWorkspace = await input.workspaces.prepareExamine({
      env: input.env,
      executionId: input.claim.execution_id,
      nodeId: input.claim.node_id,
      log: (msg, fields) => io.run.log(msg, fields),
      transport: input.transport,
      sshAccess: input.sshAccess,
      context: io.run.operationContext,
      deadlineMs: wallDeadlineOf(ctx) - Date.now(),
      repositories: input.setup.repositories,
    });
    io.resources.defer(() =>
      input.workspaces.release(reviewWorkspace.key, reviewWorkspace.kind),
    );
    return next(scope, { reviewWorkspace });
  },
};

export const workspaceReviewSnapshot: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "attemptEvidence" | "reviewRound",
  "reviewWorkspace" | "reviewScope" | "testedInput"
> = {
  id: "workspace.review(snapshot)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "attemptEvidence", "reviewRound"],
  writes: ["reviewWorkspace", "reviewScope", "testedInput"],
  stops: [
    "operation_failed",
    "operation_failed/repository.connector.git_failed",
  ],
  note: "review trees and the round scope; stop when a snapshot or the tested input is absent",
  async run(ctx, scope, io) {
    const input = hostInputOf(ctx, io);
    const {
      evidenceIds,
      scope: files,
      ...reviewWorkspace
    } = await reviewWorkspaceOf(input, io.run, {
      evidence: ctx.attemptEvidence,
      round: ctx.reviewRound,
    });
    io.resources.defer(() =>
      input.workspaces.release(reviewWorkspace.key, reviewWorkspace.kind),
    );
    const testedInput =
      reviewWorkspace.tested_input ??
      placedOf(ctx.attemptEvidence)?.asset.address;
    if (!testedInput) return io.run.stop(EndReason.OperationFailed);
    return next(scope, {
      reviewWorkspace,
      reviewScope: { evidenceIds, scope: files },
      testedInput,
    });
  },
};
