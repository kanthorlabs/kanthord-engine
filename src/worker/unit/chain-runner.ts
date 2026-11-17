import assert from "node:assert/strict";
import type { CancellationContext } from "../../kernel/context.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import {
  BudgetEndKind,
  type Chain,
  type ChainFrame,
  type ChainNode,
  type ChainSeed,
  type ChainStep,
  type ChainStepResult,
  DeadlineKind,
  type ExecutionCtx,
  type FoundryEnd,
  FoundryEndKind,
  FrameOutcome,
  type Key,
  NodeKind,
  type StepHost,
  StepKind,
} from "./chain.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  type ExecutionRun,
  ExecutionStop,
} from "./execution-run.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import { Phase, type SpanEnd } from "./telemetry.ts";

const CHECKPOINT_FAILED = "checkpoint failed";
const FIRST_PHASE = 0;
const UNKNOWN_PHASE = -1;

export interface ChainIo {
  run: ExecutionRun;
  budget: ExecutionBudget;
  resources: AsyncDisposableStack;
  host: StepHost;
  ports: CommonPorts;
}

interface Walk {
  ctx: ExecutionCtx;
  io: ChainIo;
  stopping: boolean;
  foundry: boolean;
}

const CANCELLED = "cancelled";
type Walked = StepKind | typeof CANCELLED | ExecutionStop;

interface ScopeHolder {
  scope: unknown;
}

export function seededContext(seed: Partial<ExecutionCtx>): ExecutionCtx {
  const runner: Pick<
    ExecutionCtx,
    "completedUnits" | "reports" | "verificationTimedOut"
  > = {
    completedUnits: new Set(),
    reports: new Map(),
    verificationTimedOut: false,
  };
  return { ...runner, ...seed } as ExecutionCtx;
}

function sliceOf(ctx: ExecutionCtx, reads: readonly Key[]): object {
  const slice: Partial<Record<Key, unknown>> = {};
  for (const key of reads) slice[key] = ctx[key];
  return Object.freeze(slice);
}

function stepContext(walk: Walk, step: ChainStep): CancellationContext {
  const { run, budget } = walk.io;
  if (step.deadline === DeadlineKind.Work) return run.operationContext;
  return walk.stopping
    ? run.cleanupContext()
    : budget.cleanupContext(run.operationContext);
}

function stepResult(
  walk: Walk,
  step: ChainStep,
  call: StepCall,
): Promise<ChainStepResult> {
  const { run, budget, resources, host, ports } = walk.io;
  const { context } = call;
  const slice = sliceOf(walk.ctx, step.reads) as never;
  const scope = call.holder.scope as never;
  if (step.foundry)
    return step.run(slice, scope, {
      budget,
      context,
      get deadline() {
        return budget.wallDeadline();
      },
      ports,
    });
  return step.run(slice, scope, {
    run,
    budget,
    context,
    get deadline() {
      return budget.wallDeadline();
    },
    resources,
    spans: run.spans,
    host,
    ports,
  });
}

interface StepCall {
  context: CancellationContext;
  holder: ScopeHolder;
}

function hostWalked(walk: Walk, result: ChainStepResult): Walked {
  const { run } = walk.io;
  if ("verificationTimedOut" in result.patch)
    run.noteVerification(walk.ctx.verificationTimedOut);
  if (result.stop !== undefined) throw run.halt(result.stop);
  return result.kind;
}

function foundryWalked(
  walk: Walk,
  step: ChainStep,
  result: ChainStepResult,
): Walked {
  if (result.stop !== undefined) return result.stop;
  const { reason } = walk.io.run.operationContext.signal;
  if (step.foundry && reason instanceof ExecutionStop) return CANCELLED;
  return result.kind;
}

async function walkStep(
  walk: Walk,
  step: ChainStep,
  holder: ScopeHolder,
): Promise<Walked> {
  const context = stepContext(walk, step);
  try {
    const result = await stepResult(walk, step, { context, holder });
    Object.assign(walk.ctx, result.patch);
    holder.scope = result.scope;
    return walk.foundry
      ? foundryWalked(walk, step, result)
      : hostWalked(walk, result);
  } finally {
    if (step.deadline === DeadlineKind.Cleanup) context.cancel();
  }
}

function frameFailureOf(
  walk: Walk,
  frame: ChainFrame,
  holder: ScopeHolder,
): (error: unknown) => SpanEnd {
  return (error) =>
    frame.end
      ? frame.end(walk.ctx, holder.scope as never, {
          outcome: FrameOutcome.Stop,
          error,
        })
      : { status: SpanStatus.Error };
}

function frameEndOf(
  walk: Walk,
  frame: ChainFrame,
  holder: ScopeHolder,
): (walked: Walked) => SpanEnd {
  return (walked) => {
    if (walked instanceof ExecutionStop)
      return frameFailureOf(walk, frame, holder)(walked);
    if (walked === CANCELLED)
      return frameFailureOf(
        walk,
        frame,
        holder,
      )(walk.io.run.operationContext.signal.reason);
    const outcome =
      walked === StepKind.BudgetEnd
        ? FrameOutcome.BudgetEnd
        : FrameOutcome.Next;
    return frame.end
      ? frame.end(walk.ctx, holder.scope as never, { outcome })
      : { status: SpanStatus.Ok };
  };
}

function walkFrame(
  walk: Walk,
  frame: ChainFrame,
  holder: ScopeHolder,
): Promise<Walked> {
  if (!frame.span) return walkNodes(walk, frame.body, holder);
  return walk.io.run.spans.within(
    frame.span(walk.ctx, holder.scope as never, walk.io.run.spans),
    () => walkNodes(walk, frame.body, holder),
    frameEndOf(walk, frame, holder),
    frameFailureOf(walk, frame, holder),
  );
}

async function walkLoop(
  walk: Walk,
  frame: ChainFrame,
  outer: ScopeHolder,
): Promise<Walked> {
  let scope = frame.init(walk.ctx, outer.scope);
  while (scope !== null) {
    const holder: ScopeHolder = { scope };
    const walked = await walkFrame(walk, frame, holder);
    if (walked !== StepKind.Next) return walked;
    scope = frame.next(walk.ctx, holder.scope as never);
  }
  return StepKind.Next;
}

async function walkNodes(
  walk: Walk,
  nodes: readonly ChainNode[],
  holder: ScopeHolder,
): Promise<Walked> {
  for (const node of nodes) {
    const walked =
      node.kind === NodeKind.Step
        ? await walkStep(walk, node.step, holder)
        : await walkLoop(walk, node.frame, holder);
    if (walked !== StepKind.Next) return walked;
  }
  return StepKind.Next;
}

async function hostNodes(
  walk: Walk,
  nodes: readonly ChainNode[],
  holder: ScopeHolder,
): Promise<StepKind> {
  const walked = await walkNodes({ ...walk, foundry: false }, nodes, holder);
  assert.ok(!(walked instanceof ExecutionStop) && walked !== CANCELLED);
  return walked;
}

async function walkTasks(
  walk: Walk,
  nodes: readonly ChainNode[],
): Promise<FoundryEnd<ExecutionCtx>> {
  const reached = () => ({
    result: walk.ctx,
    verificationTimedOut: walk.ctx.verificationTimedOut,
  });
  let walked: Walked;
  try {
    walked = await walkNodes({ ...walk, foundry: true }, nodes, {
      scope: null,
    });
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

async function tasksKind(
  walk: Walk,
  end: FoundryEnd<ExecutionCtx>,
): Promise<StepKind> {
  const { run } = walk.io;
  run.noteVerification(end.verificationTimedOut);
  if (end.kind === FoundryEndKind.Stop) throw run.halt(end.stop);
  if (end.kind === FoundryEndKind.Cancelled)
    throw await run.stopOf(run.operationContext.signal.reason);
  if (end.kind === FoundryEndKind.Failed) throw end.error;
  return end.kind === FoundryEndKind.BudgetEnd
    ? StepKind.BudgetEnd
    : StepKind.Next;
}

export interface NodesEnd {
  kind: StepKind;
  ctx: ExecutionCtx;
  scope: unknown;
}

export interface NodesInput {
  nodes: readonly ChainNode[];
  seed: Partial<ExecutionCtx>;
  scope?: unknown;
}

export async function runNodes(
  input: NodesInput,
  io: ChainIo,
): Promise<NodesEnd> {
  const ctx = seededContext({ env: io.host.env, ...input.seed });
  const holder: ScopeHolder = { scope: input.scope ?? null };
  const kind = await hostNodes(
    { ctx, io, stopping: false, foundry: false },
    input.nodes,
    holder,
  );
  return { kind, ctx, scope: holder.scope };
}

function closedEnd(ctx: ExecutionCtx, kind: StepKind): ExecutionEnd {
  assert.equal(kind, StepKind.Closed, "A chain ends with a final step.");
  assert.ok(ctx.end);
  return ctx.end;
}

async function budgetEnd(
  built: Chain,
  walk: Walk,
  prepared: boolean,
): Promise<ExecutionEnd> {
  const rule = built.budgetEnd;
  if (rule.kind === BudgetEndKind.Stop) return walk.io.run.stop(rule.reason);
  if (!prepared)
    throw new ExecutionStop(EndReason.BudgetEnd, BudgetLimit.WallTime);
  return closedEnd(
    walk.ctx,
    await hostNodes(walk, rule.nodes, { scope: null }),
  );
}

async function walkPhases(
  built: Chain,
  walk: Walk,
  progress: Progress,
): Promise<ExecutionEnd> {
  for (const { phase, nodes } of built.phases.slice(progress.from)) {
    const kind =
      phase === Phase.Tasks
        ? await tasksKind(walk, await walkTasks(walk, nodes))
        : await hostNodes(walk, nodes, { scope: null });
    if (kind === StepKind.BudgetEnd)
      return budgetEnd(built, walk, progress.prepared);
    if (kind === StepKind.Closed) return closedEnd(walk.ctx, kind);
    if (phase === Phase.Prepare) progress.prepared = true;
  }
  return assert.fail("A chain ends with a final step.");
}

async function stopNodes(
  built: Chain,
  walk: Walk,
  stop: ExecutionStop,
): Promise<void> {
  const { run } = walk.io;
  walk.ctx.stop = stop;
  try {
    await hostNodes({ ...walk, stopping: true }, built.onStop, {
      scope: null,
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reason = await run.reasonOf(error);
    run.log(CHECKPOINT_FAILED, reason === null ? {} : { reason });
  }
}

const NO_NODES = 0;

async function stopOf(
  built: Chain,
  walk: Walk,
  thrown: Thrown,
): Promise<unknown> {
  if (!thrown.prepared || built.onStop.length === NO_NODES) return thrown.error;
  const stop = await walk.io.run.stopOf(thrown.error);
  if (stop.reason !== EndReason.Revoked) await stopNodes(built, walk, stop);
  return stop;
}

interface Progress {
  from: number;
  prepared: boolean;
}

interface Thrown {
  error: unknown;
  prepared: boolean;
}

export interface WalkInput {
  seed: ChainSeed;
  from?: Phase;
}

export async function runChain(
  built: Chain,
  input: WalkInput,
  io: ChainIo,
): Promise<ExecutionEnd> {
  const from =
    input.from === undefined
      ? FIRST_PHASE
      : built.phases.findIndex(({ phase }) => phase === input.from);
  assert.notEqual(from, UNKNOWN_PHASE);
  const progress: Progress = {
    from,
    prepared: built.phases
      .slice(FIRST_PHASE, from)
      .some(({ phase }) => phase === Phase.Prepare),
  };
  const walk: Walk = {
    ctx: seededContext({ env: io.host.env, ...input.seed }),
    io,
    stopping: false,
    foundry: false,
  };
  try {
    return await walkPhases(built, walk, progress);
  } catch (error) {
    throw await stopOf(built, walk, { error, prepared: progress.prepared });
  } finally {
    await disposeResources(io.resources);
  }
}

async function disposeResources(
  resources: AsyncDisposableStack,
): Promise<void> {
  try {
    await resources.disposeAsync();
  } catch (error) {
    let first = error;
    while (first instanceof SuppressedError) first = first.suppressed;
    throw first;
  }
}

export async function executionBoundary(
  run: ExecutionRun,
  invoke: () => Promise<ExecutionEnd>,
): Promise<ExecutionEnd> {
  let stopped: ExecutionStop;
  try {
    return await invoke();
  } catch (error) {
    stopped = await run.stopOf(error);
  }
  if (stopped.reason !== EndReason.Revoked) return run.releaseStop(stopped);
  return {
    kind: ExecutionEndKind.Ended,
    reason: stopped.reason,
    code: stopped.code,
  };
}
