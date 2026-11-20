import {
  type Context,
  ContextCancelled,
  DeadlineExceeded,
} from "../../kernel/context.ts";
import type { ExecutionBudget } from "./budget.ts";
import {
  type ExecutionCtx,
  type FoundryIo,
  type Key,
  StepKind,
} from "./chain.ts";
import { ExecutionStop, portStop } from "./execution-stop.ts";
import {
  type EvaluationPorts,
  type EvidenceDraft,
  type EvidenceId,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";

export function wallDeadlineOf(
  ctx: Pick<ExecutionCtx, "claim" | "setup">,
): number {
  return Math.min(
    ctx.claim.created_at + ctx.setup.resource_budget.wall_time_ms,
    ctx.claim.expired_at,
  );
}

export interface NextResult<S, W extends Key> {
  kind: typeof StepKind.Next;
  patch: Pick<ExecutionCtx, W>;
  scope: S;
}

export interface BudgetEndResult<S> {
  kind: typeof StepKind.BudgetEnd;
  patch: Partial<Pick<ExecutionCtx, never>>;
  scope: S;
}

export function next<S>(scope: S): NextResult<S, never>;
export function next<S, W extends Key>(
  scope: S,
  patch: Pick<ExecutionCtx, W>,
): NextResult<S, W>;
export function next<S>(scope: S, patch: object = {}): NextResult<S, never> {
  return { kind: StepKind.Next, patch, scope };
}

export function budgetEnd<S>(scope: S): BudgetEndResult<S> {
  return { kind: StepKind.BudgetEnd, patch: {}, scope };
}

export interface StopResult<S> {
  kind: typeof StepKind.Stop;
  stop: ExecutionStop;
  patch: Partial<Pick<ExecutionCtx, never>>;
  scope: S;
}

export function stopped<S>(scope: S, stop: ExecutionStop): StopResult<S> {
  return { kind: StepKind.Stop, stop, patch: {}, scope };
}

export async function stopsReturned<S, R>(
  scope: S,
  work: () => Promise<R>,
): Promise<R | StopResult<S>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ExecutionStop) return stopped(scope, error);
    throw error;
  }
}

interface BudgetIo {
  budget: ExecutionBudget;
  context: Context;
}

export function endedByBudget(io: BudgetIo, error: unknown): boolean {
  return (
    (error instanceof ContextCancelled || error instanceof DeadlineExceeded) &&
    io.budget.exhausted() &&
    !io.context.signal.aborted
  );
}

export async function budgetMapped<S, R>(
  io: BudgetIo,
  scope: S,
  work: () => Promise<R>,
): Promise<R | BudgetEndResult<S>> {
  try {
    return await work();
  } catch (error) {
    if (endedByBudget(io, error)) return budgetEnd(scope);
    throw error;
  }
}

export async function submittedEvidence(
  io: FoundryIo<EvaluationPorts | ExaminePorts>,
  draft: EvidenceDraft,
): Promise<EvidenceId> {
  const submitted = await io.ports.evidence.submit(draft, io.context, {
    halt: true,
  });
  if (submitted.kind === PortResultKind.Failed) throw portStop(submitted);
  return submitted.value;
}
