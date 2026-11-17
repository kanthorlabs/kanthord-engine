import { join } from "node:path";
import { DeadlineKind, type Step, type StepIo } from "./chain.ts";
import {
  BaseHead,
  namedCheckouts,
  setupEntries,
  type SetupInput,
} from "./environment-setup.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { repositoryOf } from "./steps-implement.ts";
import {
  budgetMapped,
  next,
  stepsInputOf,
  wallDeadlineOf,
} from "./step-support.ts";
import type { ExecutionCtx } from "./chain.ts";
import { BASE_DIRECTORY } from "./workspace.ts";

const SETUP_STOP = "environment_failed/setup_failed";

export function setupInputOf(
  ctx: Pick<ExecutionCtx, "claim" | "setup">,
  io: StepIo,
): SetupInput {
  return {
    env: io.host.env,
    context: io.run.operationContext,
    deadline: wallDeadlineOf(ctx),
    spans: io.run.spans,
  };
}

export const setupEntriesLive: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "workspace",
  "setupEntries" | "baseHead",
  ImplementPorts
> = {
  id: "setup.entries(live)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "workspace"],
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
      {
        directory: join(
          input.workspaces.nodeKey(input.claim.node_id),
          BASE_DIRECTORY,
        ),
        trees: {
          workspaces: input.workspaces,
          nodeId: input.claim.node_id,
          addresses: new Map(
            input.setup.repositories.map(({ name, address }) => [
              name,
              address,
            ]),
          ),
          log: (msg, fields) => io.run.log(msg, fields),
          takeBase: io.ports.releaseTrees.takeBase,
        },
      },
      entries,
    );
    io.resources.defer(() => baseHead.giveBack());
    return next(scope, { setupEntries: entries, baseHead });
  },
};

export const setupEntriesReview: Step<
  unknown,
  "claim" | "setup" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  id: "setup.entries(review)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "reviewWorkspace"],
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

export const setupEntriesExamine: Step<
  unknown,
  "claim" | "setup" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  id: "setup.entries(examine)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "reviewWorkspace"],
  writes: ["setupEntries", "baseHead"],
  stops: [SETUP_STOP],
  run(ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const { checkouts } = ctx.reviewWorkspace;
      if (!checkouts.length)
        return next(scope, { setupEntries: [], baseHead: null });
      const entries = await setupEntries(
        setupInputOf(ctx, io),
        namedCheckouts(ctx.setup.repositories, checkouts),
      );
      return next(scope, { setupEntries: entries, baseHead: null });
    });
  },
};
