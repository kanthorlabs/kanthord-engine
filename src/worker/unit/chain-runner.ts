import assert from "node:assert/strict";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { CancellationContext } from "../../kernel/context.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import {
  BudgetEndKind,
  type Chain,
  type ChainNode,
  type ChainSeed,
  type ChainStep,
  type ChainStepResult,
  DeadlineKind,
  type ExecutionCtx,
  type FoundryEnd,
  FoundryEndKind,
  type Key,
  phaseReads,
  StepKind,
} from "./chain.ts";
import type { StepHost } from "./chain-host.ts";
import {
  CANCELLED,
  type ScopeHolder,
  sliceOf,
  UNTIL,
  type Walked,
  walkNodes,
} from "./chain-walk.ts";
import type { ExecutionRun } from "./execution-run.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import { Phase } from "./telemetry.ts";

const CHECKPOINT_FAILED = "checkpoint failed";
const FIRST_PHASE = 0;
const UNKNOWN_PHASE = -1;

export interface ChainIo<P extends CommonPorts = CommonPorts> {
  run: ExecutionRun;
  budget: ExecutionBudget;
  capabilities: readonly InlineExtension[];
  resources: AsyncDisposableStack;
  host: StepHost;
  ports: P;
}

interface Walk<P extends CommonPorts = CommonPorts> {
  ctx: ExecutionCtx;
  io: ChainIo<P>;
  stopping: boolean;
  step?: string;
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
      env: host.env,
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
  } as never);
}

interface StepCall {
  context: CancellationContext;
  holder: ScopeHolder;
}

async function walkStep(
  walk: Walk,
  step: ChainStep,
  holder: ScopeHolder,
): Promise<Walked> {
  const { run } = walk.io;
  const context = stepContext(walk, step);
  walk.step = step.id;
  try {
    const result = await stepResult(walk, step, { context, holder });
    Object.assign(walk.ctx, result.patch);
    holder.scope = result.scope;
    if ("verificationTimedOut" in result.patch)
      run.noteVerification(walk.ctx.verificationTimedOut);
    if (result.stop !== undefined) throw run.halt(result.stop);
    return result.kind;
  } finally {
    if (step.deadline === DeadlineKind.Cleanup) context.cancel();
  }
}

async function hostNodes(
  walk: Walk,
  nodes: readonly ChainNode[],
  holder: ScopeHolder,
): Promise<StepKind> {
  const walked = await walkNodes(
    {
      ctx: walk.ctx,
      spans: walk.io.run.spans,
      cancel: walk.io.run.operationContext,
      step: (step, stepHolder) => walkStep(walk, step, stepHolder),
    },
    nodes,
    holder,
  );
  assert.ok(
    !(walked instanceof ExecutionStop) &&
      walked !== CANCELLED &&
      walked !== UNTIL,
  );
  return walked;
}

function childEnvironmentOf(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function tasksEnd<P extends CommonPorts>(
  built: Chain<P>,
  walk: Walk<P>,
): Promise<FoundryEnd<unknown>> {
  const { run, budget, host, ports, capabilities } = walk.io;
  assert.ok(built.tasks, "A tasks phase holds a tasks call.");
  return built.tasks.run(
    walk.ctx,
    {
      cancel: run.operationContext,
      budget,
      until: null,
      env: childEnvironmentOf(host.env),
    },
    { capabilities, ports },
  );
}

async function tasksKind(
  walk: Walk,
  end: FoundryEnd<unknown>,
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
  const ctx = seededContext(input.seed);
  const holder: ScopeHolder = { scope: input.scope ?? null };
  const kind = await hostNodes(
    { ctx, io, stopping: false },
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

async function walkPhases<P extends CommonPorts>(
  built: Chain<P>,
  walk: Walk<P>,
  progress: Progress,
): Promise<ExecutionEnd> {
  for (const { phase, nodes } of built.phases.slice(progress.from)) {
    const kind =
      phase === Phase.Tasks
        ? await tasksKind(walk, await tasksEnd(built, walk))
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

export async function runChain<P extends CommonPorts>(
  built: Chain<P>,
  input: WalkInput,
  io: ChainIo<NoInfer<P>>,
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
  const walk: Walk<P> = {
    ctx: seededContext(input.seed),
    io,
    stopping: false,
  };
  try {
    return await walkPhases(built, walk, progress);
  } catch (error) {
    throw await stopOf(built, walk, { error, prepared: progress.prepared });
  } finally {
    await disposeResources(io.resources);
  }
}

export const PhaseEndKind = {
  Completed: "completed",
  BudgetEnd: "budget_end",
  Stop: "stop",
} as const;

export type PhaseEnd =
  | { kind: typeof PhaseEndKind.Completed; ctx: ExecutionCtx }
  | { kind: typeof PhaseEndKind.BudgetEnd; ctx: ExecutionCtx }
  | {
      kind: typeof PhaseEndKind.Stop;
      stop: ExecutionStop;
      step: string | null;
      ctx: ExecutionCtx;
    };

export interface PhaseSeed {
  keys: Partial<ExecutionCtx>;
}

interface PhaseInput {
  phase: Phase;
  seed: PhaseSeed;
}

export class PhaseSeedMissing extends Error {
  readonly keys: readonly Key[];
  constructor(keys: readonly Key[]) {
    super(`The phase seed lacks the keys ${keys.join(", ")}.`);
    this.keys = keys;
  }
}

function phaseNodes(built: Chain, phase: Phase): readonly ChainNode[] {
  const found = built.phases.find((entry) => entry.phase === phase);
  assert.ok(found, "A phase run names a phase of the chain.");
  return found.nodes;
}

export async function runPhase<P extends CommonPorts>(
  built: Chain<P>,
  input: PhaseInput,
  io: ChainIo<NoInfer<P>>,
): Promise<PhaseEnd> {
  const nodes = phaseNodes(built, input.phase);
  const missing = phaseReads(nodes).filter((key) => !(key in input.seed.keys));
  if (missing.length > NO_NODES) throw new PhaseSeedMissing(missing);
  const walk: Walk<P> = {
    ctx: seededContext(input.seed.keys),
    io,
    stopping: false,
  };
  try {
    const kind = await hostNodes(walk, nodes, { scope: null });
    return kind === StepKind.BudgetEnd
      ? { kind: PhaseEndKind.BudgetEnd, ctx: walk.ctx }
      : { kind: PhaseEndKind.Completed, ctx: walk.ctx };
  } catch (error) {
    const stop = await io.run.stopOf(error);
    if ("agent" in walk.ctx) await walk.ctx.agent.abort();
    return {
      kind: PhaseEndKind.Stop,
      stop,
      step: walk.step ?? null,
      ctx: walk.ctx,
    };
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
