import type { AffectedTest } from "../../agent/prompt-composer.ts";
import { readDeclaration } from "./affected.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import { next, stepsInputOf, wallDeadlineOf } from "./step-support.ts";
import { repositoryOf } from "./setup-repository.ts";

export const affectedDeclaration: Step<
  unknown,
  "claim" | "setup" | "sshAccess" | "workspace",
  "affectedTests"
> = {
  id: "affected.declaration",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "sshAccess", "workspace"],
  writes: ["affectedTests"],
  stops: [],
  note: "an absent or invalid declaration gives no entry",
  async run(ctx, scope, io) {
    const input = stepsInputOf(ctx, io);
    const deadline = wallDeadlineOf(ctx);
    const affectedTests: AffectedTest[] = [];
    for (const checkout of ctx.workspace.checkouts) {
      const declaration = await readDeclaration(
        input.env,
        checkout.directory,
        repositoryOf({ input }, checkout).strategy.base_branch,
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
