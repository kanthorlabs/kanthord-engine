import assert from "node:assert/strict";
import { setupScriptsOf } from "../../kernel/devcontainer.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import {
  runSetup,
  SetupEnd,
  type SetupEntry,
  setUpHeads,
  setupStop,
} from "./environment-setup.ts";
import { taskRevisionInstruction } from "./judgement.ts";
import { budgetEnd, budgetMapped, next } from "./step-support.ts";
import { setupInputOf } from "./step-setup-entries.ts";
import type { TestedInput } from "./verification.ts";

const SETUP_STOP = "environment_failed/setup_failed";

export function setupCommandsOf(entries: readonly SetupEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.environment === null ? [] : setupScriptsOf(entry.environment),
  );
}

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
  note: "port: releaseTrees.takeBase; node failure -> setup instruction of the first unit; budget end",
  async run(ctx, scope, io) {
    assert.ok(ctx.baseHead);
    const result = await setUpHeads(
      setupInputOf(ctx, io),
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
      setupInputOf(ctx, io),
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

export const envSetupExamine: Step<
  unknown,
  "claim" | "setup" | "setupEntries" | "reviewWorkspace",
  never
> = {
  id: "env.setup(examine)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "setupEntries", "reviewWorkspace"],
  writes: [],
  stops: [SETUP_STOP],
  note: "budget end",
  run(ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      if (!ctx.reviewWorkspace.checkouts.length) return next(scope);
      const result = await runSetup(setupInputOf(ctx, io), ctx.setupEntries);
      if (result.end === SetupEnd.Failed) throw setupStop(result);
      return result.end === SetupEnd.BudgetEnd ? budgetEnd(scope) : next(scope);
    });
  },
};
