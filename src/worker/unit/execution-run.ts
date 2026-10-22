import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import { CodedError } from "../../kernel/errors.ts";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../../kernel/operation.ts";
import type { MethodClients } from "./method-clients.ts";
import { noTelemetry, SpanRecorder, type TelemetrySink } from "./telemetry.ts";
import {
  ClaimState,
  ExecutionStopReason,
  type BudgetLimit,
  type ReleaseStop,
} from "../../scheduler/contract.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { SpanStatus } from "../../tracking/contract.ts";

type EvidenceBody = Omit<
  Parameters<MethodClients["mission"]["evidence.submit"]>[0]["body"],
  "execution_id" | "attempt" | "node_revision"
>;
type AssessmentBody = Omit<
  Parameters<MethodClients["mission"]["assessment.submit"]>[0]["body"],
  "execution_id" | "attempt" | "node_revision"
>;

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
export const EXECUTION_PROOF_FAILED =
  "gateway.invocation.execution_proof_failed";
export const EXECUTION_NOT_RUNNING = "scheduler.execution.not_running";
const NO_TELEMETRY_FAULTS = 0;
const TELEMETRY_FLUSH_MS = 5000;
const UNNAMED_WORKER = "unnamed";
const FORBIDDEN = 403;
const CONFLICT = 409;

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
  readonly detail: string | null;
  constructor(
    reason: EndReason,
    code: string | null,
    detail: string | null = null,
  ) {
    super(`Execution stopped: ${reason}`);
    this.reason = reason;
    this.code = code;
    this.detail = detail;
  }
}

export class ExecutionRun {
  readonly claim: MethodClaim;
  readonly clients: MethodClients;
  readonly operationContext: CancellationContext;
  readonly spans: SpanRecorder;
  private readonly credentials: { release(): Promise<void> };
  private readonly parent: Context;
  private readonly logSink: (record: Record<string, unknown>) => void;
  private stopped: ExecutionStop | null = null;
  private settlement: Promise<void> | null = null;
  private readonly traceClosers = new Set<(status: SpanStatus) => void>();

  constructor(input: {
    claim: MethodClaim;
    clients: MethodClients;
    credentials: { release(): Promise<void> };
    context: Context;
    log?: (record: Record<string, unknown>) => void;
    telemetry?: TelemetrySink;
    workerName?: string;
  }) {
    assert.ok(input.claim.execution_id);
    assert.ok(input.claim.node_id);
    this.claim = input.claim;
    this.spans = new SpanRecorder(
      input.claim,
      input.workerName ?? UNNAMED_WORKER,
      input.telemetry ?? noTelemetry,
    );
    this.clients = input.clients;
    this.credentials = input.credentials;
    this.parent = input.context;
    this.logSink = input.log ?? (() => {});
    this.operationContext = new CancellationContext(
      input.context,
      input.claim.expired_at,
    );
  }

  log(msg: string, fields: Record<string, unknown>): void {
    this.logSink({
      msg,
      execution_id: this.claim.execution_id,
      node_id: this.claim.node_id,
      attempt: this.claim.attempt,
      ...fields,
    });
  }

  context() {
    return {
      execution_id: this.claim.execution_id,
      attempt: this.claim.attempt,
      node_revision: this.claim.pinned_revision,
    };
  }

  onStop(listener: () => void): Disposable {
    return addAbortListener(this.operationContext.signal, listener);
  }

  onTraceClose(close: (status: SpanStatus) => void): Disposable {
    this.traceClosers.add(close);
    return { [Symbol.dispose]: () => void this.traceClosers.delete(close) };
  }

  private closeTraces(status: SpanStatus): void {
    for (const close of [...this.traceClosers]) {
      this.traceClosers.delete(close);
      try {
        close(status);
      } catch {
        this.spans.fault();
      }
    }
  }

  stop(reason: EndReason, code: string | null = null): never {
    throw this.halt(reason, code);
  }

  stopOf(error: unknown): ExecutionStop {
    if (error instanceof ExecutionStop)
      return this.halt(error.reason, error.code, error.detail);
    return this.halt(
      EndReason.OperationFailed,
      error instanceof CodedError ? error.code : null,
    );
  }

  cleanupContext(): CancellationContext {
    return new CancellationContext(this.parent, this.claim.expired_at);
  }

  private halt(
    reason: EndReason,
    code: string | null,
    detail: string | null = null,
  ): ExecutionStop {
    this.stopped ??= new ExecutionStop(reason, code, detail);
    this.operationContext.cancel(this.stopped);
    return this.stopped;
  }

  private requireActive(): void {
    if (this.stopped) throw this.stopped;
    if (this.operationContext.signal.aborted)
      this.stop(EndReason.OperationFailed);
  }

  async call<T>(
    invoke: (options: ClientOptions) => Promise<OperationResult<T>>,
  ): Promise<T> {
    this.requireActive();
    let result: OperationResult<T>;
    try {
      result = await invoke({
        context: this.operationContext,
        idempotencyKey: createIdempotencyKey(),
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

  async checkClaim(): Promise<void> {
    this.requireActive();
    let result: OperationResult<{ claim_state: ClaimState }>;
    try {
      result = await this.clients.scheduler.claimGet(
        {
          params: { execution_id: this.claim.execution_id },
          query: {},
          body: null,
        },
        {
          context: this.operationContext,
          idempotencyKey: createIdempotencyKey(),
        },
      );
    } catch {
      this.requireActive();
      return;
    }
    this.requireActive();
    if (
      (result.type === OperationResultType.Completed &&
        result.data.claim_state !== ClaimState.Running) ||
      isExecutionEnd(result)
    )
      this.stop(EndReason.Revoked);
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
    if (this.spans.faultCount() > NO_TELEMETRY_FAULTS)
      this.log("telemetry faults", { faults: this.spans.faultCount() });
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
    this.closeTraces(SpanStatus.Ok);
    await this.spans.flush(TELEMETRY_FLUSH_MS);
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

  async release(
    furtherWork: boolean,
    budgetEnd: BudgetLimit | null = null,
  ): Promise<ExecutionEnd> {
    assert.ok(budgetEnd === null || furtherWork);
    const stop: ReleaseStop | null =
      budgetEnd === null
        ? null
        : { reason: ExecutionStopReason.BudgetEnd, code: budgetEnd };
    await this.settleCredentials();
    this.closeTraces(SpanStatus.Ok);
    await this.spans.flush(TELEMETRY_FLUSH_MS);
    await this.call(async (options) => {
      const result = await this.clients.scheduler.executionRelease(
        {
          params: { execution_id: this.claim.execution_id },
          query: {},
          body: { further_work: furtherWork, stop },
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
    return stop === null
      ? { kind: ExecutionEndKind.Released, furtherWork }
      : { kind: ExecutionEndKind.Released, furtherWork, stop };
  }

  async releaseStop(stopped: ExecutionStop): Promise<ExecutionEnd> {
    const reason = stopped.reason;
    assert.ok(reason !== EndReason.Revoked);
    const stop: ReleaseStop = {
      reason,
      code: stopped.code,
      ...(stopped.detail === null ? {} : { detail: stopped.detail }),
    };
    const context = this.cleanupContext();
    try {
      this.settlement ??= this.credentials.release();
      await this.settlement;
      this.closeTraces(SpanStatus.Error);
      await this.spans.flush(TELEMETRY_FLUSH_MS);
      const params = { execution_id: this.claim.execution_id };
      const result = await this.clients.scheduler.executionRelease(
        { params, query: {}, body: { further_work: true, stop } },
        { context, idempotencyKey: createIdempotencyKey() },
      );
      if (result.type === OperationResultType.Indeterminate) {
        const claim = await this.clients.scheduler.claimGet(
          { params, query: {}, body: null },
          { context, idempotencyKey: createIdempotencyKey() },
        );
        if (
          claim.type === OperationResultType.Completed &&
          claim.data.claim_state === ClaimState.Finished &&
          claim.data.stop !== null
        )
          return { kind: ExecutionEndKind.Released, furtherWork: true, stop };
      }
      if (result.type === OperationResultType.Completed)
        return { kind: ExecutionEndKind.Released, furtherWork: true, stop };
      if (isExecutionEnd(result))
        return {
          kind: ExecutionEndKind.Ended,
          reason: EndReason.Revoked,
          code:
            result.type === OperationResultType.Failure
              ? result.error.error.code
              : null,
        };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    } finally {
      context.cancel();
    }
    return {
      kind: ExecutionEndKind.Ended,
      reason: stopped.reason,
      code: stopped.code,
      ...(stopped.detail === null ? {} : { detail: stopped.detail }),
    };
  }
}
