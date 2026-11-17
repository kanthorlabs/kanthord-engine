import { ContextCancelled, DeadlineExceeded } from "../../kernel/context.ts";
import {
  type ChainSeed,
  type ExecutionCtx,
  type Key,
  type StepHost,
  type StepIo,
  StepKind,
} from "./chain.ts";
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

export function seedOf(input: StepsInput): ChainSeed {
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

export function endedByBudget(io: StepIo, error: unknown): boolean {
  return (
    (error instanceof ContextCancelled || error instanceof DeadlineExceeded) &&
    io.budget.exhausted() &&
    !io.run.operationContext.signal.aborted
  );
}

export async function budgetMapped<S, R>(
  io: StepIo,
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
