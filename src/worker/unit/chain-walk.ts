import { CancellationContext, ContextCancelled } from "../../kernel/context.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  type ChainFrame,
  type ChainNode,
  type ChainStep,
  type ExecutionCtx,
  FrameOutcome,
  type Key,
  NodeKind,
  type ParallelBranch,
  StepKind,
  writesOf,
} from "./chain.ts";
import { ExecutionStop } from "./execution-stop.ts";
import type { SpanEnd, SpanRecorder } from "./telemetry.ts";

export const CANCELLED = "cancelled";
export const UNTIL = "until";
export type Walked = StepKind | typeof CANCELLED | typeof UNTIL | ExecutionStop;

export interface ScopeHolder {
  scope: unknown;
}

export interface Walker {
  ctx: ExecutionCtx;
  spans: SpanRecorder;
  cancel: CancellationContext;
  until?: string | null;
  step(step: ChainStep, holder: ScopeHolder): Promise<Walked>;
  branch(ctx: ExecutionCtx, cancel: CancellationContext): Walker;
}

export function sliceOf(ctx: ExecutionCtx, reads: readonly Key[]): object {
  const slice: Partial<Record<Key, unknown>> = {};
  for (const key of reads) slice[key] = ctx[key];
  return Object.freeze(slice);
}

function frameFailureOf(
  walker: Walker,
  frame: ChainFrame,
  holder: ScopeHolder,
): (error: unknown) => SpanEnd {
  return (error) =>
    frame.end
      ? frame.end(walker.ctx, holder.scope as never, {
          outcome: FrameOutcome.Stop,
          error,
        })
      : { status: SpanStatus.Error };
}

function frameEndOf(
  walker: Walker,
  frame: ChainFrame,
  holder: ScopeHolder,
): (walked: Walked) => SpanEnd {
  return (walked) => {
    if (walked instanceof ExecutionStop)
      return frameFailureOf(walker, frame, holder)(walked);
    if (walked === CANCELLED)
      return frameFailureOf(walker, frame, holder)(walker.cancel.signal.reason);
    const outcome =
      walked === StepKind.BudgetEnd
        ? FrameOutcome.BudgetEnd
        : FrameOutcome.Next;
    return frame.end
      ? frame.end(walker.ctx, holder.scope as never, { outcome })
      : { status: SpanStatus.Ok };
  };
}

function walkFrame(
  walker: Walker,
  frame: ChainFrame,
  holder: ScopeHolder,
): Promise<Walked> {
  if (!frame.span) return walkNodes(walker, frame.body, holder);
  return walker.spans.within(
    frame.span(walker.ctx, holder.scope as never, walker.spans),
    () => walkNodes(walker, frame.body, holder),
    frameEndOf(walker, frame, holder),
    frameFailureOf(walker, frame, holder),
  );
}

async function walkLoop(
  walker: Walker,
  frame: ChainFrame,
  outer: ScopeHolder,
): Promise<Walked> {
  let scope = frame.init(walker.ctx, outer.scope);
  while (scope !== null) {
    const holder: ScopeHolder = { scope };
    const walked = await walkFrame(walker, frame, holder);
    if (walked !== StepKind.Next) return walked;
    scope = frame.next(walker.ctx, holder.scope as never);
  }
  return StepKind.Next;
}

type BranchEnd =
  { index: number; walked: Walked } | { index: number; error: unknown };

interface Branched {
  ctx: ExecutionCtx;
  end: BranchEnd;
}

function mergeBranch(
  walker: Walker,
  branch: ParallelBranch,
  branched: Branched,
): void {
  for (const key of writesOf(branch.nodes))
    if (key in branched.ctx)
      Object.assign(walker.ctx, { [key]: branched.ctx[key] });
}

function walkedOf(first: BranchEnd): Walked {
  if ("error" in first) throw first.error;
  return first.walked;
}

interface GroupEnd {
  first: BranchEnd | null;
  running: Set<number>;
}

function endedByBudget(end: BranchEnd | null): boolean {
  return end !== null && "walked" in end && end.walked === StepKind.BudgetEnd;
}

function endedNext(end: BranchEnd): boolean {
  return "walked" in end && end.walked === StepKind.Next;
}

async function walkParallel(
  walker: Walker,
  branches: readonly ParallelBranch[],
  holder: ScopeHolder,
): Promise<Walked> {
  const cancels = branches.map(() => new CancellationContext(walker.cancel));
  const group: GroupEnd = {
    first: null,
    running: new Set(branches.keys()),
  };
  const ended = (end: BranchEnd) => {
    group.running.delete(end.index);
    if (group.first !== null || endedNext(end)) return;
    group.first = end;
    for (const index of group.running)
      cancels[index]!.cancel(new ContextCancelled());
  };
  const branched = await Promise.all(
    branches.map(async (branch, index): Promise<Branched> => {
      const ctx = { ...walker.ctx };
      const child = walker.branch(ctx, cancels[index]!);
      let end: BranchEnd;
      try {
        end = {
          index,
          walked: await walkNodes(child, branch.nodes, { scope: holder.scope }),
        };
      } catch (error) {
        end = { index, error };
      }
      ended(end);
      return { ctx, end };
    }),
  );
  const { first } = group;
  if (first !== null && !endedByBudget(first)) return walkedOf(first);
  for (const [index, branch] of branches.entries())
    if (endedNext(branched[index]!.end))
      mergeBranch(walker, branch, branched[index]!);
  return first === null ? StepKind.Next : StepKind.BudgetEnd;
}

export async function walkNodes(
  walker: Walker,
  nodes: readonly ChainNode[],
  holder: ScopeHolder,
): Promise<Walked> {
  for (const node of nodes) {
    if (node.kind === NodeKind.Loop && node.id === walker.until) return UNTIL;
    const walked = await walkNode(walker, node, holder);
    if (walked !== StepKind.Next) return walked;
  }
  return StepKind.Next;
}

function walkNode(
  walker: Walker,
  node: ChainNode,
  holder: ScopeHolder,
): Promise<Walked> {
  if (node.kind === NodeKind.Step) return walker.step(node.step, holder);
  if (node.kind === NodeKind.Parallel)
    return walkParallel(walker, node.branches, holder);
  return walkLoop(walker, node.frame, holder);
}
