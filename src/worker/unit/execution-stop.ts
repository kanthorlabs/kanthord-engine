import type { FailureCause } from "../../kernel/cause.ts";
import {
  ExecutionStopReason,
  type ReleaseStop,
} from "../../scheduler/contract.ts";
import type { PortFailure } from "./foundry-ports.ts";

export const EndReason = {
  ...ExecutionStopReason,
  Revoked: "revoked",
} as const;
export type EndReason = (typeof EndReason)[keyof typeof EndReason];
export const ExecutionEndKind = {
  Released: "released",
  Closed: "closed",
  Ended: "ended",
} as const;
export type ExecutionEnd =
  | {
      kind: typeof ExecutionEndKind.Released;
      furtherWork: boolean;
      stop?: ReleaseStop;
    }
  | { kind: typeof ExecutionEndKind.Closed; outcomeId: string }
  | {
      kind: typeof ExecutionEndKind.Ended;
      reason: EndReason;
      code: string | null;
      detail?: string;
    };
export interface MethodClaim {
  execution_id: string;
  node_id: string;
  attempt: number;
  pinned_revision: number;
  node_branch: string;
  created_at: number;
  expired_at: number;
  trace_id: string;
  root_span_id: string;
}

export interface StopFacts {
  detail?: string | null;
  cause?: FailureCause | null;
}

export class ExecutionStop extends Error {
  readonly reason: EndReason;
  readonly code: string | null;
  readonly detail: string | null;
  readonly cause: FailureCause | null;
  constructor(reason: EndReason, code: string | null, facts: StopFacts = {}) {
    super(`Execution stopped: ${reason}`);
    this.reason = reason;
    this.code = code;
    this.detail = facts.detail ?? null;
    this.cause = facts.cause ?? null;
  }
}

export function portStop(failed: PortFailure): ExecutionStop {
  return new ExecutionStop(EndReason.OperationFailed, failed.code, {
    detail: failed.detail,
    cause: failed.cause,
  });
}
