import { ExecutionIntent } from "../contract.ts";
import { DeadlineKind, type FoundryStep, type Step } from "./chain.ts";
import { portStop } from "./execution-stop.ts";
import {
  type EvaluationPorts,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";
import {
  readAttemptEvidence,
  readPinnedRevision,
  readPrior,
  readReviewRound,
} from "./node-reads.ts";
import { budgetEnd, budgetMapped, next, stopped } from "./step-support.ts";

export const inputsReadRevision: Step<unknown, "claim", "revision"> = {
  id: "inputs.read(revision)",
  deadline: DeadlineKind.Work,
  reads: ["claim"],
  writes: ["revision"],
  stops: [],
  async run(_ctx, scope, io) {
    return next(scope, { revision: await readPinnedRevision(io.run) });
  },
};

export const inputsReadPrior: Step<unknown, "claim" | "setup", "prior"> = {
  id: "inputs.read(prior)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup"],
  writes: ["prior"],
  stops: [],
  async run(ctx, scope, io) {
    return next(scope, {
      prior: await readPrior(io.run, ctx.setup.repositories),
    });
  },
};

export const inputsReadAttemptEvidence: Step<
  unknown,
  "claim",
  "attemptEvidence"
> = {
  id: "inputs.read(attemptEvidence)",
  deadline: DeadlineKind.Work,
  reads: ["claim"],
  writes: ["attemptEvidence"],
  stops: [],
  async run(_ctx, scope, io) {
    return next(scope, { attemptEvidence: await readAttemptEvidence(io.run) });
  },
};

export const inputsReadReviewRound: Step<unknown, "claim", "reviewRound"> = {
  id: "inputs.read(reviewRound)",
  deadline: DeadlineKind.Work,
  reads: ["claim"],
  writes: ["reviewRound"],
  stops: [],
  async run(_ctx, scope, io) {
    return next(scope, { reviewRound: await readReviewRound(io.run) });
  },
};

export const inputsReadDependenciesExamine: FoundryStep<
  unknown,
  never,
  "dependencies",
  ExaminePorts
> = {
  foundry: true,
  id: "inputs.read(dependencies)",
  deadline: DeadlineKind.Work,
  reads: [],
  writes: ["dependencies"],
  stops: [],
  note: "port: dependencies.read; budget end after the read",
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
  deadline: DeadlineKind.Work,
  reads: ["setup"],
  writes: ["dependencies"],
  stops: [],
  note: "port: dependencies.read; examine intent only",
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
