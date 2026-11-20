import { DeadlineKind, type FoundryStep } from "./chain.ts";
import {
  conflictOwnerFailed,
  type ReleaseNote,
  releaseOutcome,
} from "./release-gate.ts";
import { next } from "./step-support.ts";

export const releaseRoute: FoundryStep<
  ReleaseNote,
  "state" | "releaseCheck",
  "route"
> = {
  foundry: true,
  id: "release.route",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["state", "releaseCheck"],
  writes: ["route"],
  stops: [],
  note: "passed -> leave release_rounds; routed -> owner unit, next round",
  async run(ctx, scope) {
    const route = releaseOutcome(ctx.state, ctx.releaseCheck, scope);
    scope.conflictOwnerFailed = conflictOwnerFailed(
      ctx.state,
      ctx.releaseCheck,
    );
    return next(scope, { route });
  },
};
