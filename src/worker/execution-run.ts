import assert from "node:assert/strict";
import { ulid } from "ulid";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { CodedError } from "../kernel/errors.ts";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../kernel/operation.ts";
import type { MethodClients } from "./method-clients.ts";
import { ClaimState } from "../scheduler/contract.ts";

type EvidenceBody = Omit<
  Parameters<MethodClients["mission"]["evidence.submit"]>[0]["body"],
  "execution_id" | "attempt" | "node_revision"
>;
type AssessmentBody = Omit<
  Parameters<MethodClients["mission"]["assessment.submit"]>[0]["body"],
  "execution_id" | "attempt" | "node_revision"
>;

export const EndReason = {
  Revoked: "revoked",
  OperationFailed: "operation_failed",
  JudgementInvalid: "judgement_invalid",
  ReportAbsent: "report_absent",
  ActionUnsettled: "action_unsettled",
  AssessmentAbsent: "assessment_absent",
} as const;
export type EndReason = (typeof EndReason)[keyof typeof EndReason];
export const ExecutionEndKind = {
  Released: "released",
  Closed: "closed",
  Ended: "ended",
} as const;
export type ExecutionEnd =
  | { kind: typeof ExecutionEndKind.Released; furtherWork: boolean }
  | { kind: typeof ExecutionEndKind.Closed; outcomeId: string }
  | {
      kind: typeof ExecutionEndKind.Ended;
      reason: EndReason;
      code: string | null;
    };
export const EXECUTION_PROOF_FAILED =
  "gateway.invocation.execution_proof_failed";
export const EXECUTION_NOT_RUNNING = "scheduler.execution.not_running";
const FORBIDDEN = 403;
const CONFLICT = 409;

export interface MethodClaim {
  execution_id: string;
  node_id: string;
  attempt: number;
  pinned_revision: number;
  created_at: number;
  expired_at: number;
  trace_id: string;
}

export function isExecutionEnd(result: OperationResult<unknown>): boolean {
  return (
    result.type === OperationResultType.Failure &&
    ((result.status === FORBIDDEN &&
      result.error.error.code === EXECUTION_PROOF_FAILED) ||
      (result.status === CONFLICT &&
        result.error.error.code === EXECUTION_NOT_RUNNING))
  );
}

export class ExecutionStop extends Error {
  readonly reason: EndReason;
  readonly code: string | null;
  constructor(reason: EndReason, code: string | null) {
    super(`Execution stopped: ${reason}`);
    this.reason = reason;
    this.code = code;
  }
}

export class ExecutionRun {
  readonly claim: MethodClaim;
  readonly clients: MethodClients;
  readonly operationContext: CancellationContext;
  private readonly credentials: { release(): Promise<void> };
  private stopped: ExecutionStop | null = null;
  private settlement: Promise<void> | null = null;

  constructor(input: {
    claim: MethodClaim;
    clients: MethodClients;
    credentials: { release(): Promise<void> };
    context: Context;
  }) {
    assert.ok(input.claim.execution_id);
    assert.ok(input.claim.node_id);
    this.claim = input.claim;
    this.clients = input.clients;
    this.credentials = input.credentials;
    this.operationContext = new CancellationContext(
      input.context,
      input.claim.expired_at,
    );
  }

  context() {
    return {
      execution_id: this.claim.execution_id,
      attempt: this.claim.attempt,
      node_revision: this.claim.pinned_revision,
    };
  }

  onStop(listener: () => void): () => void {
    return this.operationContext.onCancel(listener);
  }

  stop(reason: EndReason, code: string | null = null): never {
    this.stopped ??= new ExecutionStop(reason, code);
    this.operationContext.cancel(this.stopped);
    throw this.stopped;
  }

  private requireActive(): void {
    if (this.stopped) throw this.stopped;
    if (this.operationContext.err()) this.stop(EndReason.OperationFailed);
  }

  async call<T>(
    invoke: (options: ClientOptions) => Promise<OperationResult<T>>,
  ): Promise<T> {
    this.requireActive();
    let result: OperationResult<T>;
    try {
      result = await invoke({
        context: this.operationContext,
        idempotencyKey: ulid(),
      });
    } catch (error) {
      return this.stop(
        EndReason.OperationFailed,
        error instanceof CodedError ? error.code : null,
      );
    }
    this.requireActive();
    if (result.type === OperationResultType.Completed) return result.data;
    return this.stop(
      isExecutionEnd(result) ? EndReason.Revoked : EndReason.OperationFailed,
      result.type === OperationResultType.Failure
        ? result.error.error.code
        : null,
    );
  }

  async settleCredentials(): Promise<void> {
    this.requireActive();
    this.settlement ??= this.credentials.release();
    try {
      await this.settlement;
    } catch (error) {
      this.stop(
        EndReason.OperationFailed,
        error instanceof CodedError ? error.code : null,
      );
    }
  }

  dispose(): void {
    this.operationContext.cancel();
  }

  async submitEvidence(nodeId: string, body: EvidenceBody) {
    const answer = await this.call((options) =>
      this.clients.mission["evidence.submit"](
        {
          params: { node_id: nodeId },
          query: {},
          body: { ...body, ...this.context() },
        },
        options,
      ),
    );
    return answer.evidence;
  }

  async submitAssessment(nodeId: string, body: AssessmentBody) {
    await this.settleCredentials();
    return this.call((options) =>
      this.clients.mission["assessment.submit"](
        {
          params: { node_id: nodeId },
          query: {},
          body: { ...body, ...this.context() },
        },
        options,
      ),
    );
  }

  async requestActions() {
    const answer = await this.call((options) =>
      this.clients.worker["action.request"](
        {
          params: { execution_id: this.claim.execution_id },
          query: {},
          body: null,
        },
        options,
      ),
    );
    return answer.items;
  }

  async release(furtherWork: boolean): Promise<ExecutionEnd> {
    await this.settleCredentials();
    await this.call(async (options) => {
      const result = await this.clients.scheduler.executionRelease(
        {
          params: { execution_id: this.claim.execution_id },
          query: {},
          body: { further_work: furtherWork },
        },
        options,
      );
      if (result.type !== OperationResultType.Indeterminate) return result;
      const claim = await this.call((readOptions) =>
        this.clients.scheduler.claimGet(
          {
            params: { execution_id: this.claim.execution_id },
            query: {},
            body: null,
          },
          readOptions,
        ),
      );
      if (claim.claim_state !== ClaimState.Finished)
        return this.stop(EndReason.OperationFailed);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: {
          execution_id: this.claim.execution_id,
          ended_at: claim.ended_at!,
        },
      };
    });
    return { kind: ExecutionEndKind.Released, furtherWork };
  }
}
