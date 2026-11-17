import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { type AffectedNote, releaseOutcome } from "./release-gate.ts";
import { next } from "./step-support.ts";

export const releaseRoute: FoundryStep<
  AffectedNote,
  "state" | "releaseCheck",
  "route"
> = {
  foundry: true,
  id: "release.route",
  deadline: DeadlineKind.Work,
  reads: ["state", "releaseCheck"],
  writes: ["route"],
  stops: [],
  note: "passed -> leave release_rounds; routed -> owner unit, next round",
  async run(ctx, scope) {
    return next(scope, {
      route: releaseOutcome(ctx.state, ctx.releaseCheck, scope),
    });
  },
};
