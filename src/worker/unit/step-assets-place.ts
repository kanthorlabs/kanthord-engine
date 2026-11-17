import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { placeReviewAssets } from "./evaluation-input.ts";
import { next, wallDeadlineOf } from "./step-support.ts";

export const assetsPlace: Step<
  unknown,
  | "claim"
  | "setup"
  | "attemptEvidence"
  | "reviewRound"
  | "reviewWorkspace"
  | "reviewScope",
  "placed"
> = {
  id: "assets.place",
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "attemptEvidence",
    "reviewRound",
    "reviewWorkspace",
    "reviewScope",
  ],
  writes: ["placed"],
  stops: ["operation_failed"],
  note: "support assets and round patches for the reviewer",
  async run(ctx, scope, io) {
    return next(scope, {
      placed: await placeReviewAssets(io.run, {
        workspace: ctx.reviewWorkspace,
        evidence: ctx.attemptEvidence,
        round: ctx.reviewRound,
        evidenceIds: ctx.reviewScope.evidenceIds,
        scope: ctx.reviewScope.scope,
        deadline: wallDeadlineOf(ctx),
      }),
    });
  },
};
