import assert from "node:assert/strict";
import { DeadlineKind } from "./chain.ts";
import type { Step } from "./chain-host.ts";
import { SetupEnd, setUpHeads } from "./environment-setup.ts";
import { taskRevisionInstruction } from "./judgement.ts";
import { setupCommandsOf } from "./step-env-setup.ts";
import { SETUP_STOP, setupInputOf } from "./step-setup-entries.ts";
import { budgetEnd, next } from "./step-support.ts";
import type { TestedInput } from "./verification.ts";

function testedCommits(testedInput: TestedInput): string[] {
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  return addresses.flatMap((address) =>
    "commit" in address ? [address.commit] : [],
  );
}

export const envSetupLive: Step<
  unknown,
  "claim" | "setup" | "workspace" | "setupEntries" | "baseHead",
  "setupPending" | "setupInstruction"
> = {
  id: "env.setup(live)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "workspace", "setupEntries", "baseHead"],
  writes: ["setupPending", "setupInstruction"],
  stops: [SETUP_STOP],
  note: "node failure -> setup instruction of the first unit; budget end",
  async run(ctx, scope, io) {
    assert.ok(ctx.baseHead);
    const result = await setUpHeads(
      setupInputOf(ctx, { ...io, env: io.host.env }),
      ctx.setupEntries,
      ctx.baseHead,
      ctx.workspace.checkouts.map((checkout) => checkout.head),
    );
    io.run.log("environment setup", {
      end: result.end,
      commands: setupCommandsOf(ctx.setupEntries).length,
    });
    if (result.end === SetupEnd.BudgetEnd) return budgetEnd(scope);
    if (result.end !== SetupEnd.Failed)
      return next(scope, { setupPending: false, setupInstruction: null });
    io.run.log("setup failed on the node head", {
      exit_codes: result.run.verification.results.map(
        (entry) => entry.exit_code,
      ),
    });
    return next(scope, {
      setupPending: true,
      setupInstruction: taskRevisionInstruction(
        ctx.setup.templates,
        result.run.verification,
        result.commands,
        result.run.outputs.at(-1) ?? "",
      ),
    });
  },
};

export const envSetupReview: Step<
  unknown,
  "claim" | "setup" | "setupEntries" | "baseHead" | "testedInput",
  "setupFailure"
> = {
  id: "env.setup(review)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "setupEntries", "baseHead", "testedInput"],
  writes: ["setupFailure"],
  stops: [SETUP_STOP],
  note: "node failure -> criterion-not-met; budget end",
  async run(ctx, scope, io) {
    if (ctx.baseHead === null) return next(scope, { setupFailure: null });
    const result = await setUpHeads(
      setupInputOf(ctx, { ...io, env: io.host.env }),
      ctx.setupEntries,
      ctx.baseHead,
      testedCommits(ctx.testedInput),
    );
    if (result.end === SetupEnd.BudgetEnd) return budgetEnd(scope);
    if (result.end !== SetupEnd.Failed)
      return next(scope, { setupFailure: null });
    io.run.log("setup failed on the node head", {
      exit_codes: result.run.verification.results.map(
        (entry) => entry.exit_code,
      ),
    });
    return next(scope, { setupFailure: result });
  },
};
