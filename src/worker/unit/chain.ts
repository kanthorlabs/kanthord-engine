import assert from "node:assert/strict";
import type { CancellationContext, Context } from "../../kernel/context.ts";
import type {
  Evidence,
  ReviewRound,
  Revision,
  Verification,
} from "../../mission/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import type { AffectedTest } from "../../agent/prompt-composer.ts";
import type { ExecutionSetup, RepositoryTransport } from "../contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import type {
  BaseHead,
  SetupEntry,
  SetupFailure,
} from "./environment-setup.ts";
import type { ExecutionRun } from "./execution-run.ts";
import type {
  EndReason,
  ExecutionEnd,
  ExecutionStop,
  MethodClaim,
} from "./execution-stop.ts";
import type { CommonPorts, DependencyRead } from "./foundry-ports.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import type { Prior } from "./node-verdict.ts";
import { Phase, type SpanEnd, type SpanRecorder } from "./telemetry.ts";
import type { SpanStart } from "./telemetry.ts";
import type { TestedInput, VerificationRun } from "./verification.ts";
import type { WorkspaceRoot } from "./workspace.ts";
import type {
  ExamineCheckout,
  WorkspaceCheckout,
  WorkspaceKind,
} from "./workspace-layout.ts";
import type { PlacedReview, ReviewScope } from "./review-scope.ts";
import type { ReleaseGate, VerifiedRelease } from "./release-gate.ts";
import type { AffectedStep } from "./step-affected-run.ts";
import type { EvaluationAssessment } from "./step-judgement.ts";
import type { StartCheck, StepsState } from "./steps-implement.ts";

export const ChainId = {
  Implement: "implement",
  Examine: "examine",
  Evaluation: "evaluation",
} as const;
export type ChainId = (typeof ChainId)[keyof typeof ChainId];

export const DeadlineKind = { Work: "work", Cleanup: "cleanup" } as const;
export type DeadlineKind = (typeof DeadlineKind)[keyof typeof DeadlineKind];

export const NodeKind = { Step: "step", Loop: "loop" } as const;
export const StepKind = {
  Next: "next",
  BudgetEnd: "budget_end",
  Closed: "closed",
  Stop: "stop",
} as const;
export type StepKind = (typeof StepKind)[keyof typeof StepKind];
export const FrameOutcome = {
  Next: "next",
  BudgetEnd: "budget_end",
  Stop: "stop",
} as const;
export const BudgetEndKind = { Exit: "exit", Stop: "stop" } as const;

export type StopCode = `${EndReason}` | `${EndReason}/${string}`;

export interface NodeWorkspace {
  root: string;
  checkouts: WorkspaceCheckout[];
}

export interface ReviewWorkspace {
  key: string;
  kind: WorkspaceKind;
  directory: string;
  checkouts: readonly ExamineCheckout[];
  tested_input: TestedInput | null;
}

export interface ExecutionCtx {
  claim: MethodClaim;
  setup: ExecutionSetup;
  sshAccess: ReadonlyMap<string, SshAccess>;
  env: NodeJS.ProcessEnv;
  revision: Revision;
  prior: Prior;
  attemptEvidence: readonly Evidence[];
  reviewRound: ReviewRound;
  dependencies: DependencyRead | null;
  workspace: NodeWorkspace;
  reviewWorkspace: ReviewWorkspace;
  reviewScope: { evidenceIds: string[]; scope: ReviewScope };
  testedInput: TestedInput;
  setupEntries: SetupEntry[];
  baseHead: BaseHead | null;
  affectedTests: AffectedTest[];
  setupPending: boolean;
  setupInstruction: string | null;
  setupFailure: SetupFailure | null;
  placed: PlacedReview;
  agent: NativeAgent;
  state: StepsState;
  plan: StartCheck;
  releaseCheck: VerifiedRelease;
  route: ReleaseGate;
  completedUnits: ReadonlySet<string>;
  reports: ReadonlyMap<string, string>;
  verification: VerificationRun;
  nodeVerification: Verification | null;
  affected: AffectedStep | null;
  verificationEvidence: string;
  affectedEvidence: string | null;
  patchEvidence: readonly string[];
  judgement: EvaluationAssessment;
  verificationTimedOut: boolean;
  stop: ExecutionStop;
  end: ExecutionEnd;
}
export type Key = keyof ExecutionCtx;

export const SEED_KEYS: readonly Key[] = [
  "claim",
  "setup",
  "sshAccess",
  "revision",
];
export type ChainSeed = Partial<ExecutionCtx> &
  Pick<ExecutionCtx, "claim" | "setup" | "sshAccess" | "revision">;
export const RUNNER_KEYS: readonly Key[] = [
  "env",
  "completedUnits",
  "reports",
  "verificationTimedOut",
];
const STOP_KEYS: readonly Key[] = ["stop"];

export type StepResult<S, W extends Key> =
  | { kind: typeof StepKind.Next; patch: Pick<ExecutionCtx, W>; scope: S }
  | {
      kind: typeof StepKind.BudgetEnd;
      patch: Partial<Pick<ExecutionCtx, W>>;
      scope: S;
    }
  | {
      kind: typeof StepKind.Closed;
      patch: Partial<Pick<ExecutionCtx, W>>;
      scope: S;
    };

export interface StepHost {
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  env: NodeJS.ProcessEnv;
}

export interface StepIo<P extends CommonPorts = CommonPorts> {
  run: ExecutionRun;
  budget: ExecutionBudget;
  context: Context;
  deadline: number;
  resources: AsyncDisposableStack;
  spans: SpanRecorder;
  host: StepHost;
  ports: P;
}

export interface Step<
  S,
  R extends Key,
  W extends Key,
  P extends CommonPorts = CommonPorts,
> {
  id: string;
  deadline: DeadlineKind;
  reads: readonly R[];
  writes: readonly W[];
  stops: readonly StopCode[];
  llm?: boolean;
  note?: string;
  run(
    ctx: Readonly<Pick<ExecutionCtx, R>>,
    scope: S,
    io: StepIo<P>,
  ): Promise<StepResult<S, W>>;
}

export interface FoundryIo<P extends CommonPorts = CommonPorts> {
  budget: ExecutionBudget;
  context: CancellationContext;
  deadline: number;
  ports: P;
}

export type FoundryStepResult<S, W extends Key> =
  | StepResult<S, W>
  | {
      kind: typeof StepKind.Stop;
      stop: ExecutionStop;
      patch: Partial<Pick<ExecutionCtx, W>>;
      scope: S;
    };

export interface FoundryStep<
  S,
  R extends Key,
  W extends Key,
  P extends CommonPorts = CommonPorts,
> {
  foundry: true;
  id: string;
  deadline: DeadlineKind;
  reads: readonly R[];
  writes: readonly W[];
  stops: readonly StopCode[];
  llm?: boolean;
  note?: string;
  run(
    ctx: Readonly<Pick<ExecutionCtx, R>>,
    scope: S,
    io: FoundryIo<P>,
  ): Promise<FoundryStepResult<S, W>>;
}

export const FoundryEndKind = {
  Completed: "completed",
  BudgetEnd: "budget_end",
  Stop: "stop",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;

export type FoundryEnd<R> =
  | {
      kind: typeof FoundryEndKind.Completed;
      result: R;
      verificationTimedOut: boolean;
    }
  | {
      kind: typeof FoundryEndKind.BudgetEnd;
      result: R;
      verificationTimedOut: boolean;
    }
  | {
      kind: typeof FoundryEndKind.Stop;
      stop: ExecutionStop;
      result: R;
      verificationTimedOut: boolean;
    }
  | {
      kind: typeof FoundryEndKind.Cancelled;
      result: R;
      verificationTimedOut: boolean;
    }
  | {
      kind: typeof FoundryEndKind.Failed;
      error: unknown;
      result: R;
      verificationTimedOut: boolean;
    };

interface ChainStepShape {
  id: string;
  deadline: DeadlineKind;
  reads: readonly Key[];
  writes: readonly Key[];
  stops: readonly StopCode[];
  llm?: boolean;
  note?: string;
}

export interface ChainHostStep extends ChainStepShape {
  foundry?: undefined;
  run(ctx: never, scope: never, io: StepIo): Promise<ChainStepResult>;
}

export interface ChainFoundryStep extends ChainStepShape {
  foundry: true;
  run(ctx: never, scope: never, io: FoundryIo): Promise<ChainStepResult>;
}

export type ChainStep = ChainHostStep | ChainFoundryStep;

export interface ChainStepResult {
  kind: StepKind;
  patch: Partial<ExecutionCtx>;
  scope: unknown;
  stop?: ExecutionStop;
}

export type FrameEnd =
  | { outcome: typeof FrameOutcome.Next }
  | { outcome: typeof FrameOutcome.BudgetEnd }
  | { outcome: typeof FrameOutcome.Stop; error: unknown };

export interface LoopFrame<S> {
  reads: readonly Key[];
  endReads?: readonly Key[];
  note?: string;
  init(ctx: ExecutionCtx, outer: unknown): S | null;
  body: readonly ChainNode[];
  next(ctx: ExecutionCtx, scope: S): S | null;
  span?(ctx: ExecutionCtx, scope: S, spans: SpanRecorder): SpanStart;
  end?(ctx: ExecutionCtx, scope: S, ended: FrameEnd): SpanEnd;
}

export interface ChainFrame {
  reads: readonly Key[];
  endReads?: readonly Key[];
  note?: string;
  init(ctx: ExecutionCtx, outer: unknown): unknown;
  body: readonly ChainNode[];
  next(ctx: ExecutionCtx, scope: never): unknown;
  span?(ctx: ExecutionCtx, scope: never, spans: SpanRecorder): SpanStart;
  end?(ctx: ExecutionCtx, scope: never, ended: FrameEnd): SpanEnd;
}

export type ChainNode =
  | { kind: typeof NodeKind.Step; step: ChainStep }
  | { kind: typeof NodeKind.Loop; id: string; frame: ChainFrame };

export type BudgetEndRule =
  | { kind: typeof BudgetEndKind.Exit; nodes: readonly ChainNode[] }
  | { kind: typeof BudgetEndKind.Stop; reason: EndReason };

export interface ChainPhase {
  phase: Phase;
  nodes: readonly ChainNode[];
}

export interface Chain {
  id: ChainId;
  phases: readonly ChainPhase[];
  onStop: readonly ChainNode[];
  budgetEnd: BudgetEndRule;
}

export interface ChainBuilder {
  phase(phase: Phase): ChainBuilder;
  step(step: ChainStep): ChainBuilder;
  loop<S>(id: string, frame: LoopFrame<S>): ChainBuilder;
  nodes(nodes: readonly ChainNode[]): ChainBuilder;
  onStop(nodes: readonly ChainNode[]): ChainBuilder;
  budgetEnd(rule: BudgetEndRule): ChainBuilder;
  build(): Chain;
}

export function stepNode(step: ChainStep): ChainNode {
  return { kind: NodeKind.Step, step };
}

export function loopNode<S>(id: string, frame: LoopFrame<S>): ChainNode {
  assert.ok(id);
  return { kind: NodeKind.Loop, id, frame };
}

const PHASE_ORDER: readonly Phase[] = [
  Phase.Prepare,
  Phase.Start,
  Phase.Tasks,
  Phase.Finish,
];
const UNKNOWN_PHASE = -1;

export function chain(id: ChainId): ChainBuilder {
  const phases: { phase: Phase; nodes: ChainNode[] }[] = [];
  let onStop: readonly ChainNode[] = [];
  let budgetEnd: BudgetEndRule | null = null;
  const current = (): ChainNode[] => {
    const last = phases.at(-1);
    assert.ok(last, "A node belongs to a phase.");
    return last.nodes;
  };
  const builder: ChainBuilder = {
    phase(phase) {
      const order = PHASE_ORDER.indexOf(phase);
      assert.notEqual(order, UNKNOWN_PHASE);
      const last = phases.at(-1);
      assert.ok(
        last === undefined || PHASE_ORDER.indexOf(last.phase) < order,
        "The phases of a chain follow the phase order.",
      );
      phases.push({ phase, nodes: [] });
      return builder;
    },
    step(step) {
      current().push(stepNode(step));
      return builder;
    },
    loop(loopId, frame) {
      current().push(loopNode(loopId, frame));
      return builder;
    },
    nodes(nodes) {
      current().push(...nodes);
      return builder;
    },
    onStop(nodes) {
      onStop = nodes;
      return builder;
    },
    budgetEnd(rule) {
      budgetEnd = rule;
      return builder;
    },
    build() {
      assert.ok(budgetEnd, "A chain declares its budget end rule.");
      const built: Chain = { id, phases, onStop, budgetEnd };
      checkChain(built);
      return built;
    },
  };
  return builder;
}

export class ChainBuildError extends Error {
  readonly chain: ChainId;
  readonly node: string;
  readonly key: Key;
  constructor(chainId: ChainId, node: string, key: Key) {
    super(
      `Chain ${chainId}: ${node} reads the key ${key} with no earlier writer.`,
    );
    this.chain = chainId;
    this.node = node;
    this.key = key;
  }
}

interface Written {
  chain: ChainId;
  keys: Set<Key>;
}

function requireKeys(
  written: Written,
  node: string,
  reads: readonly Key[],
): void {
  for (const key of reads)
    if (!written.keys.has(key))
      throw new ChainBuildError(written.chain, node, key);
}

function checkNodes(written: Written, nodes: readonly ChainNode[]): void {
  for (const node of nodes) {
    if (node.kind === NodeKind.Step) {
      requireKeys(written, `step ${node.step.id}`, node.step.reads);
      for (const key of node.step.writes) written.keys.add(key);
      continue;
    }
    requireKeys(written, `loop ${node.id}`, node.frame.reads);
    checkNodes(written, node.frame.body);
    requireKeys(written, `loop ${node.id}`, node.frame.endReads ?? []);
  }
}

function checkChain(built: Chain): void {
  const written: Written = {
    chain: built.id,
    keys: new Set([...SEED_KEYS, ...RUNNER_KEYS]),
  };
  let prepared: Set<Key> | null = null;
  for (const { phase, nodes } of built.phases) {
    checkNodes(written, nodes);
    if (phase === Phase.Prepare) prepared = new Set(written.keys);
  }
  const atPrepareEnd = prepared ?? new Set(written.keys);
  if (built.budgetEnd.kind === BudgetEndKind.Exit)
    checkNodes(
      { chain: built.id, keys: new Set(atPrepareEnd) },
      built.budgetEnd.nodes,
    );
  checkNodes(
    { chain: built.id, keys: new Set([...atPrepareEnd, ...STOP_KEYS]) },
    built.onStop,
  );
}
