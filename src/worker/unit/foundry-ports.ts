import type { FailureCause } from "../../kernel/cause.ts";
import type { CancellationContext, Context } from "../../kernel/context.ts";
import type {
  Evidence,
  EvidenceSubmit,
  ExecutionContext,
  ExecutionDependency,
  Outcome,
} from "../../mission/contract.ts";
import type { ExecutionSetup, UnitRecord } from "../contract.ts";
import type { ReviewWorkspace } from "./chain.ts";
import type { MethodClaim } from "./execution-stop.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import type { SpanRecorder } from "./telemetry.ts";

export const PortResultKind = {
  Ok: "ok",
  Failed: "failed",
  BudgetEnd: "budget_end",
} as const;

export interface PortFailure {
  kind: typeof PortResultKind.Failed;
  code: string | null;
  message: string;
  detail?: string | null;
  cause?: FailureCause | null;
}

export interface PortBudgetEnd {
  kind: typeof PortResultKind.BudgetEnd;
}

export type PortResult<T> =
  { kind: typeof PortResultKind.Ok; value: T } | PortFailure;

export const TreeSource = {
  Pool: "pool",
  Clone: "clone",
  Node: "node",
} as const;
export type TreeSource = (typeof TreeSource)[keyof typeof TreeSource];

export type EvidenceDraft = Omit<EvidenceSubmit, keyof ExecutionContext>;
export type EvidenceId = Evidence["id"];
export type Commit = string;
export type LogFields = Record<string, unknown>;

export interface CheckoutRef {
  binding_id: string;
  name: string;
  directory: string;
}

export interface CommandTree {
  binding_id: string;
  directory: string;
  source: TreeSource;
}

export interface PortCall {
  context: Context;
  deadline: number;
}

export interface EvidenceOptions {
  halt: boolean;
}

export interface EvidencePort {
  submit(
    draft: EvidenceDraft,
    context: CancellationContext,
    options: EvidenceOptions,
  ): Promise<PortResult<EvidenceId>>;
}

export interface RepositoryPort {
  fetchBase(checkout: CheckoutRef, call: PortCall): Promise<PortResult<null>>;
}

export interface ReleaseTreePort {
  take(
    checkout: CheckoutRef,
    head: Commit,
    call: PortCall,
  ): Promise<PortResult<CommandTree>>;
  takeBase(
    checkout: CheckoutRef,
    commit: Commit,
    call: PortCall,
  ): Promise<PortResult<CommandTree>>;
  give(tree: CommandTree): Promise<void>;
  giveBase(tree: CommandTree): Promise<void>;
}

export interface UnitRecordPort {
  put(
    record: UnitRecord,
    context: CancellationContext,
  ): Promise<PortResult<null>>;
}

export type AgentSession = NativeAgent;

export interface AgentOpenRequest {
  claim: MethodClaim;
  setup: ExecutionSetup;
  checkouts: readonly CheckoutRef[];
  reviewWorkspace: ReviewWorkspace | null;
}

export interface AgentPort {
  open(
    request: AgentOpenRequest,
    context: CancellationContext,
  ): Promise<PortResult<AgentSession> | PortBudgetEnd>;
}

export interface DependencyRead {
  dependencies: ExecutionDependency[];
  outcomes: Outcome[];
  evidence: Evidence[];
}

export interface SecretPort {
  redact(text: string): Promise<string | null>;
}

export interface LogPort {
  log(message: string, fields: LogFields): void;
}

export interface CommonPorts {
  telemetry: SpanRecorder;
  secrets: SecretPort;
  log: LogPort;
}

export interface ImplementPorts extends CommonPorts {
  evidence: EvidencePort;
  repository: RepositoryPort;
  releaseTrees: ReleaseTreePort;
  unitRecords: UnitRecordPort;
}

export interface ImplementHostPorts extends ImplementPorts {
  agent: AgentPort;
}

export interface EvaluationPorts extends CommonPorts {
  evidence: EvidencePort;
  agent: AgentPort;
}

export interface ExaminePorts extends CommonPorts {
  evidence: EvidencePort;
  agent: AgentPort;
}

type CalledPorts<P> = Omit<P, "telemetry" | "log">;

export type PortNameOf<P> = {
  [K in keyof CalledPorts<P> & string]: `${K}.${keyof P[K] & string}`;
}[keyof CalledPorts<P> & string];

export type PortName = string;

export const IMPLEMENT_PORTS = [
  "secrets.redact",
  "evidence.submit",
  "repository.fetchBase",
  "releaseTrees.take",
  "releaseTrees.takeBase",
  "releaseTrees.give",
  "releaseTrees.giveBase",
  "unitRecords.put",
] as const satisfies readonly PortNameOf<ImplementPorts>[];

export const IMPLEMENT_HOST_PORTS = [
  ...IMPLEMENT_PORTS,
  "agent.open",
] as const satisfies readonly PortNameOf<ImplementHostPorts>[];

export const EVALUATION_PORTS = [
  "secrets.redact",
  "evidence.submit",
  "agent.open",
] as const satisfies readonly PortNameOf<EvaluationPorts>[];

export const EXAMINE_PORTS = [
  "secrets.redact",
  "evidence.submit",
  "agent.open",
] as const satisfies readonly PortNameOf<ExaminePorts>[];
