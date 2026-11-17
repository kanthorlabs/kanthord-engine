import type { CancellationContext, Context } from "../../kernel/context.ts";
import type {
  Evidence,
  EvidenceSubmit,
  ExecutionContext,
} from "../../mission/contract.ts";
import type { SpanRecorder } from "./telemetry.ts";
import type { TreeSource } from "./tree-pool.ts";

export const PortResultKind = { Ok: "ok", Failed: "failed" } as const;

export type PortResult<T> =
  | { kind: typeof PortResultKind.Ok; value: T }
  | {
      kind: typeof PortResultKind.Failed;
      code: string | null;
      message: string;
    };

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
}
