import assert from "node:assert/strict";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { CancellationContext } from "../../kernel/context.ts";
import type { ExecutionBudget } from "./budget.ts";
import {
  type ChainNode,
  type ChainStep,
  type ChainStepResult,
  DeadlineKind,
  type ExecutionCtx,
  type FoundryEnd,
  FoundryEndKind,
  StepKind,
} from "./chain.ts";
import {
  CANCELLED,
  type ScopeHolder,
  sliceOf,
  type Walked,
  type Walker,
  walkNodes,
} from "./chain-walk.ts";
import { ExecutionStop } from "./execution-stop.ts";
import type { CommonPorts } from "./foundry-ports.ts";

export interface FoundryHost<P extends CommonPorts> {
  capabilities: readonly InlineExtension[];
  ports: P;
}

export interface FoundryControl {
  cancel: CancellationContext;
  budget: ExecutionBudget;
  until: string | null;
  env: Readonly<Record<string, string>>;
}

export interface TasksWalk<R> {
  nodes: readonly ChainNode[];
  seed: Partial<ExecutionCtx>;
  resultOf(ctx: ExecutionCtx): R;
}

interface TasksRun {
  control: FoundryControl;
  ports: CommonPorts;
  ctx: ExecutionCtx;
}

function contextOf(run: TasksRun, step: ChainStep): CancellationContext {
  const { cancel, budget } = run.control;
  return step.deadline === DeadlineKind.Work
    ? cancel
    : budget.cleanupContext(cancel);
}

function walkedOf(run: TasksRun, result: ChainStepResult): Walked {
  if (result.stop !== undefined) return result.stop;
  const { reason } = run.control.cancel.signal;
  if (reason instanceof ExecutionStop) return CANCELLED;
  return result.kind;
}

async function walkStep(
  run: TasksRun,
  step: ChainStep,
  holder: ScopeHolder,
): Promise<Walked> {
  assert.ok(step.foundry, "A tasks phase holds no host step.");
  const { budget, env } = run.control;
  const context = contextOf(run, step);
  try {
    const result = await step.run(
      sliceOf(run.ctx, step.reads) as never,
      holder.scope as never,
      {
        budget,
        context,
        get deadline() {
          return budget.wallDeadline();
        },
        env,
        ports: run.ports,
      },
    );
    Object.assign(run.ctx, result.patch);
    holder.scope = result.scope;
    return walkedOf(run, result);
  } finally {
    if (step.deadline === DeadlineKind.Cleanup) context.cancel();
  }
}

function walkerOf(run: TasksRun): Walker {
  return {
    ctx: run.ctx,
    spans: run.ports.telemetry,
    cancel: run.control.cancel,
    step: (step, holder) => walkStep(run, step, holder),
  };
}

export function pickKeys<K extends keyof ExecutionCtx>(
  ctx: Partial<ExecutionCtx>,
  keys: readonly K[],
): Partial<Pick<ExecutionCtx, K>> {
  const picked: Partial<Pick<ExecutionCtx, K>> = {};
  for (const key of keys) if (key in ctx) picked[key] = ctx[key];
  return picked;
}

export async function runTasks<R>(
  walk: TasksWalk<R>,
  control: FoundryControl,
  host: FoundryHost<CommonPorts>,
): Promise<FoundryEnd<R>> {
  const ctx = { verificationTimedOut: false, ...walk.seed } as ExecutionCtx;
  const reached = () => ({
    result: walk.resultOf(ctx),
    verificationTimedOut: ctx.verificationTimedOut,
  });
  let walked: Walked;
  try {
    walked = await walkNodes(
      walkerOf({ control, ports: host.ports, ctx }),
      walk.nodes,
      { scope: null },
    );
  } catch (error) {
    return { kind: FoundryEndKind.Failed, error, ...reached() };
  }
  if (walked instanceof ExecutionStop)
    return { kind: FoundryEndKind.Stop, stop: walked, ...reached() };
  if (walked === CANCELLED)
    return { kind: FoundryEndKind.Cancelled, ...reached() };
  if (walked === StepKind.BudgetEnd)
    return { kind: FoundryEndKind.BudgetEnd, ...reached() };
  assert.equal(walked, StepKind.Next, "A tasks phase holds no final step.");
  return { kind: FoundryEndKind.Completed, ...reached() };
}
