import { ExecutionIntent } from "../contract.ts";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import {
  readAttemptEvidence,
  readDependencies,
  readPinnedRevision,
  readPrior,
  readReviewRound,
} from "./node-reads.ts";
import { budgetEnd, budgetMapped, next } from "./step-support.ts";

export const inputsReadRevisionPrior: Step<
  unknown,
  "claim" | "setup",
  "revision" | "prior"
> = {
  id: "inputs.read(revision, prior)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup"],
  writes: ["revision", "prior"],
  stops: [],
  note: "reads revision and prior in parallel",
  async run(ctx, scope, io) {
    const [revision, prior] = await Promise.all([
      readPinnedRevision(io.run),
      readPrior(io.run, ctx.setup.repositories),
    ]);
    return next(scope, { revision, prior });
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

export const inputsReadEvaluation: Step<
  unknown,
  "claim" | "setup",
  "revision" | "attemptEvidence" | "reviewRound" | "dependencies"
> = {
  id: "inputs.read(revision, attemptEvidence, reviewRound, dependencies)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup"],
  writes: ["revision", "attemptEvidence", "reviewRound", "dependencies"],
  stops: [],
  note: "reads in parallel; dependencies in the examine intent only",
  async run(ctx, scope, io) {
    const [revision, attemptEvidence, reviewRound, dependencies] =
      await Promise.all([
        readPinnedRevision(io.run),
        readAttemptEvidence(io.run),
        readReviewRound(io.run),
        ctx.setup.intent === ExecutionIntent.Examine
          ? readDependencies(io.run)
          : null,
      ]);
    return next(scope, {
      revision,
      attemptEvidence,
      reviewRound,
      dependencies,
    });
  },
};

export const inputsReadExamine: Step<
  unknown,
  "claim",
  "revision" | "dependencies"
> = {
  id: "inputs.read(revision, dependencies)",
  deadline: DeadlineKind.Work,
  reads: ["claim"],
  writes: ["revision", "dependencies"],
  stops: [],
  note: "reads in parallel; budget end after the reads",
  run(_ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const [revision, dependencies] = await Promise.all([
        readPinnedRevision(io.run),
        readDependencies(io.run),
      ]);
      if (io.budget.exhausted()) return budgetEnd(scope);
      return next(scope, { revision, dependencies });
    });
  },
};
