import type { CancellationContext } from "../../kernel/context.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  type ChainFrame,
  type ChainNode,
  type ChainStep,
  type ExecutionCtx,
  FrameOutcome,
  type Key,
  NodeKind,
  StepKind,
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

export async function walkNodes(
  walker: Walker,
  nodes: readonly ChainNode[],
  holder: ScopeHolder,
): Promise<Walked> {
  for (const node of nodes) {
    if (node.kind === NodeKind.Loop && node.id === walker.until) return UNTIL;
    const walked =
      node.kind === NodeKind.Step
        ? await walker.step(node.step, holder)
        : await walkLoop(walker, node.frame, holder);
    if (walked !== StepKind.Next) return walked;
  }
  return StepKind.Next;
}
