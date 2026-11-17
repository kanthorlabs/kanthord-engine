import {
  DeadlineKind,
  type ExecutionCtx,
  type FoundryIo,
  type FoundryStep,
  type Step,
} from "./chain.ts";
import { namedCheckouts } from "./environment-setup.ts";
import {
  type AgentOpenRequest,
  type AgentSession,
  type EvaluationPorts,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";
import { portStop } from "./execution-run.ts";
import {
  budgetEnd,
  budgetMapped,
  next,
  stopsReturned,
} from "./step-support.ts";

type OpenKeys = "claim" | "setup" | "reviewWorkspace";

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

function agentOpenRequestOf(
  ctx: Readonly<Pick<ExecutionCtx, OpenKeys>>,
): AgentOpenRequest {
  const { claim, setup, reviewWorkspace } = ctx;
  return {
    claim,
    setup,
    checkouts: namedCheckouts(
      setup.repositories,
      reviewWorkspace.checkouts,
    ).map(({ repository, directory }) => ({
      binding_id: repository.binding_id,
      name: repository.name,
      directory,
    })),
    reviewWorkspace,
  };
}

export async function openedAgent(
  ctx: Readonly<Pick<ExecutionCtx, OpenKeys>>,
  io: FoundryIo<EvaluationPorts | ExaminePorts>,
): Promise<AgentSession | null> {
  const opened = await io.ports.agent.open(agentOpenRequestOf(ctx), io.context);
  if (opened.kind === PortResultKind.Ok) return opened.value;
  if (opened.kind === PortResultKind.BudgetEnd) return null;
  throw portStop(opened);
}

export const agentOpenExamine: FoundryStep<
  unknown,
  OpenKeys,
  "agent",
  ExaminePorts
> = {
  foundry: true,
  id: "agent.open",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "reviewWorkspace"],
  writes: ["agent"],
  stops: ["operation_failed"],
  note: "port: agent.open; budget end after the open",
  run(ctx, scope, io) {
    return stopsReturned(scope, () =>
      budgetMapped(io, scope, async () => {
        const agent = await openedAgent(ctx, io);
        if (agent === null || agent.budget.exhausted()) return budgetEnd(scope);
        return next(scope, { agent });
      }),
    );
  },
};
