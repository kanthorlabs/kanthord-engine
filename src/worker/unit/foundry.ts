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
  UNTIL,
  type Walked,
  type Walker,
  walkNodes,
  withinStep,
} from "./chain-walk.ts";
import { ExecutionStop } from "./execution-stop.ts";
import type { CommonPorts } from "./foundry-ports.ts";

const UNKNOWN_STEP = "unknown";

export interface StepWatch {
  started(step: string): void;
  ended(step: string, scope: unknown): void;
}

export interface FoundryHost<P extends CommonPorts> {
  capabilities: readonly InlineExtension[];
  ports: P;
  steps?: StepWatch;
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

interface StopMark {
  step: string | null;
}

interface TasksRun {
  control: FoundryControl;
  ports: CommonPorts;
  steps: StepWatch | null;
  ctx: ExecutionCtx;
  stopped: StopMark;
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

function walkStep(
  run: TasksRun,
  step: ChainStep,
  holder: ScopeHolder,
): Promise<Walked> {
  return withinStep(run.ports.telemetry, step, () =>
    runStep(run, step, holder),
  );
}

async function runStep(
  run: TasksRun,
  step: ChainStep,
  holder: ScopeHolder,
): Promise<Walked> {
  assert.ok(step.foundry, "A tasks phase holds no host step.");
  const { budget, env } = run.control;
  const context = contextOf(run, step);
  run.steps?.started(step.id);
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
    if (result.stop !== undefined) run.stopped.step ??= step.id;
    return walkedOf(run, result);
  } finally {
    if (step.deadline === DeadlineKind.Cleanup) context.cancel();
    run.steps?.ended(step.id, holder.scope);
  }
}

function walkerOf(run: TasksRun): Walker {
  return {
    ctx: run.ctx,
    spans: run.ports.telemetry,
    cancel: run.control.cancel,
    until: run.control.until,
    step: (step, holder) => walkStep(run, step, holder),
    branch: (ctx, cancel) =>
      branchWalkerOf({ ...run, ctx, control: { ...run.control, cancel } }),
  };
}

function branchWalkerOf(run: TasksRun): Walker {
  return {
    ...walkerOf(run),
    step: (step, holder) =>
      run.control.cancel.signal.aborted
        ? Promise.resolve(CANCELLED)
        : walkStep(run, step, holder),
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
  const run: TasksRun = {
    control,
    ports: host.ports,
    steps: host.steps ?? null,
    ctx,
    stopped: { step: null },
  };
  let walked: Walked;
  try {
    walked = await walkNodes(walkerOf(run), walk.nodes, { scope: null });
  } catch (error) {
    return { kind: FoundryEndKind.Failed, error, ...reached() };
  }
  if (walked instanceof ExecutionStop)
    return {
      kind: FoundryEndKind.Stop,
      stop: walked,
      step: run.stopped.step ?? UNKNOWN_STEP,
      ...reached(),
    };
  if (walked === CANCELLED)
    return { kind: FoundryEndKind.Cancelled, ...reached() };
  if (walked === StepKind.BudgetEnd)
    return { kind: FoundryEndKind.BudgetEnd, ...reached() };
  if (walked === UNTIL) return { kind: FoundryEndKind.Completed, ...reached() };
  assert.equal(walked, StepKind.Next, "A tasks phase holds no final step.");
  return { kind: FoundryEndKind.Completed, ...reached() };
}
