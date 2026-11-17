import { ContextCancelled, DeadlineExceeded } from "../../kernel/context.ts";
import {
  type ExecutionCtx,
  type FoundryIo,
  type Key,
  type StepHost,
  type StepIo,
  StepKind,
} from "./chain.ts";
import { ExecutionStop, portStop } from "./execution-run.ts";
import {
  type EvaluationPorts,
  type EvidenceDraft,
  type EvidenceId,
  type ExaminePorts,
  PortResultKind,
} from "./foundry-ports.ts";
import type { StepsInput } from "./steps-implement.ts";

type InputKeys = "claim" | "setup" | "sshAccess";

export function stepsInputOf(
  ctx: Pick<ExecutionCtx, InputKeys>,
  io: StepIo,
): StepsInput {
  return {
    claim: ctx.claim,
    setup: ctx.setup,
    sshAccess: ctx.sshAccess,
    workspaces: io.host.workspaces,
    transport: io.host.transport,
    env: io.host.env,
  };
}

export function seedOf(input: StepsInput): Pick<ExecutionCtx, InputKeys> {
  return {
    claim: input.claim,
    setup: input.setup,
    sshAccess: input.sshAccess,
  };
}

export function hostOf(
  input: StepsInput,
  openAgent: StepHost["openAgent"],
): StepHost {
  return {
    workspaces: input.workspaces,
    transport: input.transport,
    env: input.env,
    openAgent,
  };
}

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

type BudgetIo = Pick<StepIo, "budget" | "context">;

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
