import type { Context } from "../../kernel/context.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import {
  namedCheckouts,
  setupEntries,
  type SetupInput,
} from "./environment-setup.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import {
  budgetMapped,
  next,
  stopsReturned,
  wallDeadlineOf,
} from "./step-support.ts";
import type { ExecutionCtx } from "./chain.ts";

export const SETUP_STOP = "environment_failed/setup_failed";

export interface SetupIo {
  context: Context;
  env: NodeJS.ProcessEnv;
  ports: Pick<CommonPorts, "telemetry">;
}

export function setupInputOf(
  ctx: Pick<ExecutionCtx, "claim" | "setup">,
  io: SetupIo,
): SetupInput {
  return {
    env: io.env,
    context: io.context,
    deadline: wallDeadlineOf(ctx),
    spans: io.ports.telemetry,
  };
}

export const setupEntriesExamine: FoundryStep<
  unknown,
  "claim" | "setup" | "reviewWorkspace",
  "setupEntries" | "baseHead"
> = {
  foundry: true,
  id: "setup.entries(examine)",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "reviewWorkspace"],
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
