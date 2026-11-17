import { ExecutionIntent } from "../contract.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import {
  readAttemptEvidence,
  readDependencies,
  readPinnedRevision,
  readPrior,
  readReviewRound,
} from "./node-reads.ts";
import { budgetEnd, budgetMapped, next } from "./step-support.ts";

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

export const inputsReadDependenciesExamine: Step<
  unknown,
  "claim",
  "dependencies"
> = {
  id: "inputs.read(dependencies)",
  deadline: DeadlineKind.Work,
  reads: ["claim"],
  writes: ["dependencies"],
  stops: [],
  note: "budget end after the read",
  run(_ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const dependencies = await readDependencies(io.run);
      if (io.budget.exhausted()) return budgetEnd(scope);
      return next(scope, { dependencies });
    });
  },
};

export const inputsReadDependenciesEvaluation: Step<
  unknown,
  "claim" | "setup",
  "dependencies"
> = {
  id: "inputs.read(dependencies)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup"],
  writes: ["dependencies"],
  stops: [],
  note: "examine intent only",
  async run(ctx, scope, io) {
    return next(scope, {
      dependencies:
        ctx.setup.intent === ExecutionIntent.Examine
          ? await readDependencies(io.run)
          : null,
    });
  },
};
