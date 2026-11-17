import { ExecutionIntent } from "../contract.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import { portStop } from "./execution-stop.ts";
import {
  type EvaluationPorts,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";
import { budgetEnd, budgetMapped, next, stopped } from "./step-support.ts";

export const inputsReadDependenciesExamine: FoundryStep<
  unknown,
  never,
  "dependencies",
  ExaminePorts
> = {
  foundry: true,
  id: "inputs.read(dependencies)",
  ports: ["dependencies.read"],
  deadline: DeadlineKind.Work,
  reads: [],
  writes: ["dependencies"],
  stops: [],
  note: "budget end after the read",
  run(_ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const read = await io.ports.dependencies.read(io.context);
      if (read.kind === PortResultKind.Failed)
        return stopped(scope, portStop(read));
      if (read.kind === PortResultKind.BudgetEnd || io.budget.exhausted())
        return budgetEnd(scope);
      return next(scope, { dependencies: read.value });
    });
  },
};

export const inputsReadDependenciesEvaluation: FoundryStep<
  unknown,
  "setup",
  "dependencies",
  EvaluationPorts
> = {
  foundry: true,
  id: "inputs.read(dependencies)",
  ports: ["dependencies.read"],
  deadline: DeadlineKind.Work,
  reads: ["setup"],
  writes: ["dependencies"],
  stops: [],
  note: "examine intent only",
  async run(ctx, scope, io) {
    if (ctx.setup.intent !== ExecutionIntent.Examine)
      return next(scope, { dependencies: null });
    const read = await io.ports.dependencies.read(io.context);
    if (read.kind === PortResultKind.Failed)
      return stopped(scope, portStop(read));
    if (read.kind === PortResultKind.BudgetEnd) return budgetEnd(scope);
    return next(scope, { dependencies: read.value });
  },
};
