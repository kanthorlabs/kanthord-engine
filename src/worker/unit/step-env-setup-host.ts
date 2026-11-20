import assert from "node:assert/strict";
import { DeadlineKind, type ExecutionCtx } from "./chain.ts";
import type { Step, StepIo } from "./chain-host.ts";
import { SetupEnd, setUpHeads, type SetupResult } from "./environment-setup.ts";
import { EndReason, ExecutionStop } from "./execution-stop.ts";
import { perCheckout } from "./per-checkout.ts";
import { restoreCheckout } from "./turn-gate.ts";
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

type LiveKeys = "claim" | "setup" | "workspace" | "setupEntries" | "baseHead";

async function restoreHeads(
  ctx: Readonly<Pick<ExecutionCtx, LiveKeys>>,
  io: StepIo,
): Promise<void> {
  const context = io.run.cleanupContext();
  try {
    await perCheckout(ctx.workspace.checkouts, (checkout) =>
      restoreCheckout(
        io.host.env,
        checkout,
        ctx.claim.node_branch,
        checkout.head,
        context,
        () => ctx.claim.expired_at - Date.now(),
      ),
    );
  } finally {
    context.cancel();
  }
}

function revoked(io: StepIo): boolean {
  const stored = io.run.operationContext.signal.reason;
  return stored instanceof ExecutionStop && stored.reason === EndReason.Revoked;
}

async function setUpLive(
  ctx: Readonly<Pick<ExecutionCtx, LiveKeys>>,
  io: StepIo,
): Promise<SetupResult> {
  assert.ok(ctx.baseHead);
  try {
    return await setUpHeads(
      setupInputOf(ctx, { ...io, env: io.host.env }),
      ctx.setupEntries,
      ctx.baseHead,
      ctx.workspace.checkouts.map((checkout) => checkout.head),
    );
  } catch (error) {
    if (!revoked(io)) await restoreHeads(ctx, io);
    throw error;
  }
}

export const envSetupLive: Step<
  unknown,
  LiveKeys,
  "setupPending" | "setupInstruction"
> = {
  id: "env.setup(live)",
  deadline: DeadlineKind.Work,
  reads: ["claim", "setup", "workspace", "setupEntries", "baseHead"],
  writes: ["setupPending", "setupInstruction"],
  stops: [SETUP_STOP],
  note: "on the merged heads; node failure -> setup instruction of the first unit; budget end; restore on a stop or a budget end",
  async run(ctx, scope, io) {
    const result = await setUpLive(ctx, io);
    io.run.log("environment setup", {
      end: result.end,
      commands: setupCommandsOf(ctx.setupEntries).length,
    });
    if (result.end === SetupEnd.BudgetEnd) {
      await restoreHeads(ctx, io);
      return budgetEnd(scope);
    }
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
