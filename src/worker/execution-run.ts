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
  "executionId" | "attempt" | "nodeRevision"
>;
type AssessmentBody = Omit<
  Parameters<MethodClients["mission"]["assessment.submit"]>[0]["body"],
  "executionId" | "attempt" | "nodeRevision"
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
  executionId: string;
  nodeId: string;
  attempt: number;
  pinnedRevision: number;
  createdAt: number;
  expiredAt: number;
  traceId: string;
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
    assert.ok(input.claim.executionId);
    assert.ok(input.claim.nodeId);
    this.claim = input.claim;
    this.clients = input.clients;
    this.credentials = input.credentials;
    this.operationContext = new CancellationContext(
      input.context,
      input.claim.expiredAt,
    );
  }

  context() {
    return {
      executionId: this.claim.executionId,
      attempt: this.claim.attempt,
      nodeRevision: this.claim.pinnedRevision,
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
        { params: { nodeId }, query: {}, body: { ...body, ...this.context() } },
        options,
      ),
    );
    return answer.evidence;
  }

  async submitAssessment(nodeId: string, body: AssessmentBody) {
    await this.settleCredentials();
    return this.call((options) =>
      this.clients.mission["assessment.submit"](
        { params: { nodeId }, query: {}, body: { ...body, ...this.context() } },
        options,
      ),
    );
  }

  async requestActions() {
    const answer = await this.call((options) =>
      this.clients.worker["action.request"](
        {
          params: { execution_id: this.claim.executionId },
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
          params: { executionId: this.claim.executionId },
          query: {},
          body: { furtherWork },
        },
        options,
      );
      if (result.type !== OperationResultType.Indeterminate) return result;
      const claim = await this.call((readOptions) =>
        this.clients.scheduler.claimGet(
          {
            params: { executionId: this.claim.executionId },
            query: {},
            body: null,
          },
          readOptions,
        ),
      );
      if (claim.claimState !== ClaimState.Finished)
        return this.stop(EndReason.OperationFailed);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: {
          executionId: this.claim.executionId,
          endedAt: claim.endedAt!,
        },
      };
    });
    return { kind: ExecutionEndKind.Released, furtherWork };
  }
}
