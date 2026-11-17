import { DeadlineKind, type Step } from "./chain.ts";
import { budgetEnd, budgetMapped, next } from "./step-support.ts";

export const agentOpenImplement: Step<unknown, "workspace", "agent"> = {
  id: "agent.open",
  deadline: DeadlineKind.Work,
  reads: ["workspace"],
  writes: ["agent"],
  stops: ["operation_failed"],
  async run(ctx, scope, io) {
    return next(scope, {
      agent: await io.host.openAgent(ctx.workspace.root),
    });
  },
};

export const agentOpenExamine: Step<unknown, "reviewWorkspace", "agent"> = {
  id: "agent.open",
  deadline: DeadlineKind.Work,
  reads: ["reviewWorkspace"],
  writes: ["agent"],
  stops: ["operation_failed"],
  note: "budget end after the open",
  run(ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const agent = await io.host.openAgent(ctx.reviewWorkspace.directory);
      if (agent.budget.exhausted()) return budgetEnd(scope);
      return next(scope, { agent });
    });
  },
};
