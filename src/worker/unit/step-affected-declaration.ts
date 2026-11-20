import type { AffectedTest } from "../../agent/prompt-composer.ts";
import { declarationStop, readDeclaration } from "./affected.ts";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { commitOf } from "./local-git.ts";
import { perCheckout } from "./per-checkout.ts";
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
  stops: ["environment_failed/affected_invalid"],
  note: "per checkout at origin/<base>; an absent declaration gives no entry",
  async run(ctx, scope, io) {
    const deadline = wallDeadlineOf(ctx);
    const declared = await perCheckout(
      ctx.workspace.checkouts,
      async (checkout): Promise<AffectedTest | null> => {
        const base = repositoryOf({ input: ctx }, checkout).strategy
          .base_branch;
        const declaration = await readDeclaration(
          io.host.env,
          checkout.directory,
          base,
          io.context,
          deadline - Date.now(),
        );
        if (declaration === null) return null;
        if ("error" in declaration)
          throw declarationStop({
            binding_id: checkout.binding_id,
            commit: await commitOf(
              io.host.env,
              checkout.directory,
              `origin/${base}`,
              io.context,
              deadline - Date.now(),
            ),
            error: declaration.error,
          });
        return {
          name: checkout.name,
          command: declaration.command,
          gate_files: declaration.gate_files,
        };
      },
    );
    return next(scope, {
      affectedTests: declared.filter((entry) => entry !== null),
    });
  },
};
