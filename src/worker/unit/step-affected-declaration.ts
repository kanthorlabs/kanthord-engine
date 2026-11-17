import type { AffectedTest } from "../../agent/prompt-composer.ts";
import { readDeclaration } from "./affected.ts";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { next, wallDeadlineOf } from "./step-support.ts";
import { repositoryOf } from "./setup-repository.ts";

export const affectedDeclaration: Step<
  unknown,
  "claim" | "setup" | "workspace",
  "affectedTests"
> = {
  id: "affected.declaration",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "workspace"],
  writes: ["affectedTests"],
  stops: [],
  note: "an absent or invalid declaration gives no entry",
  async run(ctx, scope, io) {
    const deadline = wallDeadlineOf(ctx);
    const affectedTests: AffectedTest[] = [];
    for (const checkout of ctx.workspace.checkouts) {
      const declaration = await readDeclaration(
        io.host.env,
        checkout.directory,
        repositoryOf({ input: ctx }, checkout).strategy.base_branch,
        io.run.operationContext,
        deadline - Date.now(),
      );
      if (declaration === null || "error" in declaration) continue;
      affectedTests.push({
        name: checkout.name,
        command: declaration.command,
        gate_files: declaration.gate_files,
      });
    }
    return next(scope, { affectedTests });
  },
};
