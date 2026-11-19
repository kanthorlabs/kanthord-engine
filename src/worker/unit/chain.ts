import assert from "node:assert/strict";
import type { CancellationContext } from "../../kernel/context.ts";
import type {
  Evidence,
  ReviewRound,
  Revision,
  Verification,
} from "../../mission/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import type { AffectedTest } from "../../agent/prompt-composer.ts";
import type { ExecutionSetup } from "../contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import type {
  BaseHead,
  SetupEntry,
  SetupFailure,
} from "./environment-setup.ts";
import type {
  EndReason,
  ExecutionEnd,
  ExecutionStop,
  MethodClaim,
} from "./execution-stop.ts";
import type {
  CommonPorts,
  DependencyRead,
  PortName,
  PortNameOf,
} from "./foundry-ports.ts";
import type { FoundryControl, FoundryHost } from "./foundry.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import type { Prior } from "./node-verdict.ts";
import { Phase, type SpanEnd, type SpanRecorder } from "./telemetry.ts";
import type { SpanStart } from "./telemetry.ts";
import type { TestedInput, VerificationRun } from "./verification.ts";
import type {
  ExamineCheckout,
  NodeCheckout,
  WorkspaceKind,
} from "./workspace-layout.ts";
import type { PlacedReview, ReviewScope } from "./review-scope.ts";
import type { ReleaseGate, VerifiedRelease } from "./release-gate.ts";
import type { AffectedStep } from "./step-affected-run.ts";
import type { EvaluationAssessment } from "./step-judgement.ts";
import type { StartCheck, StartState } from "./steps-implement.ts";

export const ChainId = {
  Implement: "implement",
  Examine: "examine",
  Evaluation: "evaluation",
  TasksPrepare: "tasks_prepare",
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
  checkouts: NodeCheckout[];
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
  state: StartState;
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

export interface FoundryIo<P extends CommonPorts = CommonPorts> {
  budget: ExecutionBudget;
  context: CancellationContext;
  deadline: number;
  env: NodeJS.ProcessEnv;
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
  ports: readonly PortNameOf<P>[];
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
      step: string;
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
  run(ctx: never, scope: never, io: never): Promise<ChainStepResult>;
}

export interface ChainFoundryStep extends ChainStepShape {
  foundry: true;
  ports: readonly PortName[];
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

export interface ChainTasks<P extends CommonPorts> {
  name: string;
  ports: readonly PortName[];
  nodes: readonly ChainNode[];
  run(
    ctx: ExecutionCtx,
    control: FoundryControl,
    host: FoundryHost<P>,
  ): Promise<FoundryEnd<unknown>>;
}

export interface Chain<P extends CommonPorts = CommonPorts> {
  id: ChainId;
  ports: readonly PortName[];
  phases: readonly ChainPhase[];
  tasks: ChainTasks<P> | null;
  onStop: readonly ChainNode[];
  budgetEnd: BudgetEndRule;
}

export interface ChainBuilder<P extends CommonPorts> {
  phase(phase: Phase): ChainBuilder<P>;
  tasks(tasks: ChainTasks<P>): ChainBuilder<P>;
  step(step: ChainStep): ChainBuilder<P>;
  loop<S>(id: string, frame: LoopFrame<S>): ChainBuilder<P>;
  nodes(nodes: readonly ChainNode[]): ChainBuilder<P>;
  onStop(nodes: readonly ChainNode[]): ChainBuilder<P>;
  budgetEnd(rule: BudgetEndRule): ChainBuilder<P>;
  build(): Chain<P>;
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

interface BuiltPhases<P extends CommonPorts> {
  phases: { phase: Phase; nodes: ChainNode[] }[];
  tasks: ChainTasks<P> | null;
}

function openPhase<P extends CommonPorts>(
  built: BuiltPhases<P>,
  phase: Phase,
): void {
  const order = PHASE_ORDER.indexOf(phase);
  assert.notEqual(order, UNKNOWN_PHASE);
  const last = built.phases.at(-1);
  assert.ok(
    last === undefined || PHASE_ORDER.indexOf(last.phase) < order,
    "The phases of a chain follow the phase order.",
  );
  built.phases.push({ phase, nodes: [] });
}

export function chain<P extends CommonPorts>(
  id: ChainId,
  ports: readonly PortNameOf<P>[],
): ChainBuilder<P> {
  const built: BuiltPhases<P> = { phases: [], tasks: null };
  let onStop: readonly ChainNode[] = [];
  let budgetEnd: BudgetEndRule | null = null;
  const current = (): ChainNode[] => {
    const last = built.phases.at(-1);
    assert.ok(last, "A node belongs to a phase.");
    return last.nodes;
  };
  const builder: ChainBuilder<P> = {
    phase(phase) {
      assert.notEqual(phase, Phase.Tasks, "A tasks phase holds a tasks call.");
      openPhase(built, phase);
      return builder;
    },
    tasks(tasks) {
      openPhase(built, Phase.Tasks);
      current().push(...tasks.nodes);
      built.tasks = tasks;
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
      const done: Chain<P> = {
        id,
        ports,
        phases: built.phases,
        tasks: built.tasks,
        onStop,
        budgetEnd,
      };
      checkChain(done);
      return done;
    },
  };
  return builder;
}

export const ChainRule = {
  ReadBeforeWrite: "read_before_write",
  PortOutsidePhase: "port_outside_phase",
  HostStepInTasks: "host_step_in_tasks",
  FoundryReadsSshAccess: "foundry_reads_ssh_access",
} as const;
export type ChainRule = (typeof ChainRule)[keyof typeof ChainRule];

export interface ChainRefusal {
  rule: ChainRule;
  key?: Key;
  port?: PortName;
}

export class ChainBuildError extends Error {
  readonly chain: ChainId;
  readonly node: string;
  readonly rule: ChainRule;
  readonly key: Key | null;
  readonly port: PortName | null;
  constructor(chainId: ChainId, node: string, refusal: ChainRefusal) {
    super(
      `Chain ${chainId}: ${node} breaks the rule ${refusal.rule} (${refusal.key ?? refusal.port ?? ""}).`,
    );
    this.chain = chainId;
    this.node = node;
    this.rule = refusal.rule;
    this.key = refusal.key ?? null;
    this.port = refusal.port ?? null;
  }
}

interface Written {
  chain: ChainId;
  keys: Set<Key>;
  ports: readonly PortName[];
  tasks: boolean;
}

function requireKeys(
  written: Written,
  node: string,
  reads: readonly Key[],
): void {
  for (const key of reads)
    if (!written.keys.has(key))
      throw new ChainBuildError(written.chain, node, {
        rule: ChainRule.ReadBeforeWrite,
        key,
      });
}

function checkStep(written: Written, step: ChainStep): void {
  const node = `step ${step.id}`;
  if (!step.foundry) {
    if (written.tasks)
      throw new ChainBuildError(written.chain, node, {
        rule: ChainRule.HostStepInTasks,
      });
    return;
  }
  if (step.reads.includes("sshAccess"))
    throw new ChainBuildError(written.chain, node, {
      rule: ChainRule.FoundryReadsSshAccess,
      key: "sshAccess",
    });
  const outside = step.ports.find((port) => !written.ports.includes(port));
  if (outside !== undefined)
    throw new ChainBuildError(written.chain, node, {
      rule: ChainRule.PortOutsidePhase,
      port: outside,
    });
}

function checkNodes(written: Written, nodes: readonly ChainNode[]): void {
  for (const node of nodes) {
    if (node.kind === NodeKind.Step) {
      checkStep(written, node.step);
      requireKeys(written, `step ${node.step.id}`, node.step.reads);
      for (const key of node.step.writes) written.keys.add(key);
      continue;
    }
    requireKeys(written, `loop ${node.id}`, node.frame.reads);
    checkNodes(written, node.frame.body);
    requireKeys(written, `loop ${node.id}`, node.frame.endReads ?? []);
  }
}

function collectReads(
  nodes: readonly ChainNode[],
  written: Set<Key>,
  read: Set<Key>,
): void {
  const note = (keys: readonly Key[]) => {
    for (const key of keys) if (!written.has(key)) read.add(key);
  };
  for (const node of nodes) {
    if (node.kind === NodeKind.Step) {
      note(node.step.reads);
      for (const key of node.step.writes) written.add(key);
      continue;
    }
    note(node.frame.reads);
    collectReads(node.frame.body, written, read);
    note(node.frame.endReads ?? []);
  }
}

export function phaseReads(nodes: readonly ChainNode[]): Key[] {
  const read = new Set<Key>();
  collectReads(nodes, new Set(RUNNER_KEYS), read);
  return [...read];
}

function phaseSeedKeys(built: Chain): Key[] {
  if (built.id !== ChainId.TasksPrepare) return [];
  return phaseReads(built.phases.flatMap(({ nodes }) => nodes));
}

function hostWritten(built: Chain, keys: Iterable<Key>): Written {
  return {
    chain: built.id,
    keys: new Set(keys),
    ports: built.ports,
    tasks: false,
  };
}

function checkChain(built: Chain): void {
  assert.equal(
    built.tasks !== null,
    built.phases.some(({ phase }) => phase === Phase.Tasks),
  );
  const written = hostWritten(built, [
    ...SEED_KEYS,
    ...RUNNER_KEYS,
    ...phaseSeedKeys(built),
  ]);
  let prepared: Set<Key> | null = null;
  for (const { phase, nodes } of built.phases) {
    const tasks = phase === Phase.Tasks;
    checkNodes(
      {
        ...written,
        ports: tasks ? (built.tasks?.ports ?? []) : built.ports,
        tasks,
      },
      nodes,
    );
    if (phase === Phase.Prepare) prepared = new Set(written.keys);
  }
  const atPrepareEnd = prepared ?? new Set(written.keys);
  if (built.budgetEnd.kind === BudgetEndKind.Exit)
    checkNodes(hostWritten(built, atPrepareEnd), built.budgetEnd.nodes);
  checkNodes(hostWritten(built, [...atPrepareEnd, ...STOP_KEYS]), built.onStop);
}
