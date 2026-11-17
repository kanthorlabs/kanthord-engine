import { join } from "node:path";
import {
  DeadlineKind,
  type FoundryStep,
  type Step,
  type StepIo,
} from "./chain.ts";
import {
  BaseHead,
  namedCheckouts,
  setupEntries,
  type SetupInput,
} from "./environment-setup.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { repositoryOf } from "./setup-repository.ts";
import {
  budgetMapped,
  next,
  stepsInputOf,
  stopsReturned,
  wallDeadlineOf,
} from "./step-support.ts";
import type { ExecutionCtx } from "./chain.ts";
import { BASE_DIRECTORY } from "./workspace.ts";

const SETUP_STOP = "environment_failed/setup_failed";

export function setupInputOf(
  ctx: Pick<ExecutionCtx, "claim" | "setup" | "env">,
  io: Pick<StepIo, "context" | "ports">,
): SetupInput {
  return {
    env: ctx.env,
    context: io.context,
    deadline: wallDeadlineOf(ctx),
    spans: io.ports.telemetry,
  };
}

export const setupEntriesLive: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "env" | "workspace",
  "setupEntries" | "baseHead",
  ImplementPorts
> = {
  id: "setup.entries(live)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "env", "workspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  async run(ctx, scope, io) {
    const input = stepsInputOf(ctx, io);
    const setupInput = setupInputOf(ctx, io);
    const entries = await setupEntries(
      setupInput,
      ctx.workspace.checkouts.map((checkout) => ({
        repository: repositoryOf({ input }, checkout),
        directory: checkout.directory,
      })),
    );
    const baseHead = new BaseHead(
      setupInput,
      { trees: { port: io.ports.releaseTrees, log: io.ports.log } },
      entries,
    );
    io.resources.defer(() => baseHead.giveBack());
    return next(scope, { setupEntries: entries, baseHead });
  },
};

export const setupEntriesReview: Step<
  unknown,
  "claim" | "setup" | "env" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  id: "setup.entries(review)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "env", "reviewWorkspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  async run(ctx, scope, io) {
    const workspace = ctx.reviewWorkspace;
    if (!workspace.checkouts.length)
      return next(scope, { setupEntries: [], baseHead: null });
    const setupInput = setupInputOf(ctx, io);
    const entries = await setupEntries(
      setupInput,
      namedCheckouts(ctx.setup.repositories, workspace.checkouts),
    );
    const baseHead = new BaseHead(
      setupInput,
      { directory: join(workspace.key, BASE_DIRECTORY) },
      entries,
    );
    return next(scope, { setupEntries: entries, baseHead });
  },
};

export const setupEntriesExamine: FoundryStep<
  unknown,
  "claim" | "setup" | "env" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  foundry: true,
  id: "setup.entries(examine)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "env", "reviewWorkspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  run(ctx, scope, io) {
    return stopsReturned(scope, () =>
      budgetMapped(io, scope, async () => {
        const { checkouts } = ctx.reviewWorkspace;
        if (!checkouts.length)
          return next(scope, { setupEntries: [], baseHead: null });
        const entries = await setupEntries(
          setupInputOf(ctx, io),
          namedCheckouts(ctx.setup.repositories, checkouts),
        );
        return next(scope, { setupEntries: entries, baseHead: null });
      }),
    );
  },
};
