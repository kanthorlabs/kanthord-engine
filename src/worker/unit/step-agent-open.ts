import {
  DeadlineKind,
  type ExecutionCtx,
  type Step,
  type StepIo,
} from "./chain.ts";
import { namedCheckouts } from "./environment-setup.ts";
import { EndReason } from "./execution-run.ts";
import {
  type AgentOpenRequest,
  type AgentSession,
  type EvaluationPorts,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";
import { budgetEnd, budgetMapped, next } from "./step-support.ts";

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
  io: StepIo<EvaluationPorts | ExaminePorts>,
): Promise<AgentSession | null> {
  const opened = await io.ports.agent.open(
    agentOpenRequestOf(ctx),
    io.run.operationContext,
  );
  if (opened.kind === PortResultKind.Ok) return opened.value;
  if (io.budget.exhausted() && !io.run.operationContext.signal.aborted)
    return null;
  return io.run.stop(EndReason.OperationFailed, opened.code);
}

export const agentOpenExamine: Step<unknown, OpenKeys, "agent", ExaminePorts> =
  {
    id: "agent.open",
    deadline: DeadlineKind.Work,
    reads: ["claim", "setup", "reviewWorkspace"],
    writes: ["agent"],
    stops: ["operation_failed"],
    note: "port: agent.open; budget end after the open",
    run(ctx, scope, io) {
      return budgetMapped(io, scope, async () => {
        const agent = await openedAgent(ctx, io);
        if (agent === null || agent.budget.exhausted()) return budgetEnd(scope);
        return next(scope, { agent });
      });
    },
  };
