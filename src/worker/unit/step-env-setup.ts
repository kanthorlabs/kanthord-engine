import { setupScriptsOf } from "../../kernel/devcontainer.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import {
  runSetup,
  SetupEnd,
  type SetupEntry,
  setupStop,
} from "./environment-setup.ts";
import {
  budgetEnd,
  budgetMapped,
  next,
  stopped,
  stopsReturned,
} from "./step-support.ts";
import { SETUP_STOP, setupInputOf } from "./step-setup-entries.ts";

export function setupCommandsOf(entries: readonly SetupEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.environment === null ? [] : setupScriptsOf(entry.environment),
  );
}

export const envSetupExamine: FoundryStep<
  unknown,
  "claim" | "setup" | "setupEntries" | "reviewWorkspace",
  never
> = {
  foundry: true,
  id: "env.setup(examine)",
  ports: [],
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "setupEntries", "reviewWorkspace"],
  writes: [],
  stops: [SETUP_STOP],
  note: "budget end",
  run(ctx, scope, io) {
    return stopsReturned(scope, () =>
      budgetMapped(io, scope, async () => {
        if (!ctx.reviewWorkspace.checkouts.length) return next(scope);
        const result = await runSetup(setupInputOf(ctx, io), ctx.setupEntries);
        if (result.end === SetupEnd.Failed)
          return stopped(scope, setupStop(result));
        return result.end === SetupEnd.BudgetEnd
          ? budgetEnd(scope)
          : next(scope);
      }),
    );
  },
};
