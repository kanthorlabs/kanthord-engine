import assert from "node:assert/strict";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  type CallerContext,
  type OperationRegistry,
} from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store } from "../kernel/store.ts";
import {
  admitRecords,
  admitServerSpan,
  type Admission,
  type SpanContribution,
} from "./admission.ts";
import {
  ROOT_SPAN_OPERATION,
  SCHEDULER_PRODUCER,
  ExecutionEnd,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
  trackingOperations,
  type Acknowledgement,
  type Attributes,
  type ExecutionTelemetry,
  type ExecutionTrace,
  type ExecutionTraces,
  type RootSpanEnd,
  type TelemetryRecord,
} from "./contract.ts";
import { insertTrace, listSpans, readText, readTrace } from "./trace-store.ts";

const ROOT_START_RECORD = "start";
const ROOT_END_RECORD = "end";
const TRACKING_STOPPED_CODE = "system.tracking.stopped";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const CURSOR_START = 0;

export interface Dependencies {
  store: Store;
  executions: ExecutionTraces;
  health?: HealthRegistry;
}

function traceNotFound(): never {
  throw new OperationError(
    HttpStatus.NotFound,
    "tracking.trace.not_found",
    "The trace is unknown or expired.",
  );
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return CURSOR_START;
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  const position = Number(decoded);
  if (
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor ||
    !Number.isSafeInteger(position) ||
    position <= CURSOR_START ||
    String(position) !== decoded
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      CURSOR_INVALID_CODE,
      "Cursor is invalid.",
    );
  return position;
}

function encodeCursor(position: number | null): string | null {
  if (position === null) return null;
  assert.ok(Number.isSafeInteger(position));
  return Buffer.from(String(position), TEXT_ENCODING).toString(CURSOR_ENCODING);
}

function identityAttributes(trace: ExecutionTrace) {
  assert.ok(trace.execution_id);
  assert.ok(trace.node_id);
  return {
    "kanthord.execution.id": trace.execution_id,
    "kanthord.node.id": trace.node_id,
    "kanthord.project.id": trace.project_id,
    "kanthord.attempt": trace.attempt,
  };
}

export class TrackingService implements Service, ExecutionTelemetry {
  private readonly dependencies: Dependencies;
  private readonly shutdown = new CancellationContext();
  private started = false;
  private dropped = 0;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    dependencies.health?.register(TRACKING_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  droppedRecords(): number {
    return this.dropped;
  }

  executionOpened(trace: ExecutionTrace, createdAt: number): void {
    assert.ok(trace.trace_id);
    assert.ok(Number.isSafeInteger(createdAt));
    this.serverSpan(trace, SCHEDULER_PRODUCER, {
      record_id: `${trace.root_span_id}:${ROOT_START_RECORD}`,
      span_id: trace.root_span_id,
      parent_span_id: null,
      operation: ROOT_SPAN_OPERATION,
      start_time: createdAt,
    });
  }

  executionEnded(end: RootSpanEnd): void {
    assert.ok(end.trace.trace_id);
    assert.ok(Number.isSafeInteger(end.ended_at));
    this.serverSpan(end.trace, SCHEDULER_PRODUCER, {
      record_id: `${end.trace.root_span_id}:${ROOT_END_RECORD}`,
      span_id: end.trace.root_span_id,
      parent_span_id: null,
      operation: ROOT_SPAN_OPERATION,
      end_time: end.ended_at,
      status:
        end.stop === null && end.end === ExecutionEnd.Finished
          ? SpanStatus.Ok
          : SpanStatus.Error,
      attributes: {
        "kanthord.execution.end": end.end,
        ...stopAttributes(end.stop),
      },
    });
  }

  serverSpan(
    trace: ExecutionTrace,
    producer: string,
    contribution: SpanContribution,
  ): void {
    assert.ok(contribution.record_id);
    assert.ok(producer);
    assert.ok(
      contribution.span_id === trace.root_span_id ||
        contribution.parent_span_id === trace.root_span_id,
    );
    try {
      this.dependencies.store.transaction((tx) => {
        const now = Date.now();
        insertTrace(tx, trace, now);
        const reason = admitServerSpan(
          tx,
          { trace, producer, origin: SpanOrigin.Observed, now },
          {
            ...contribution,
            attributes: {
              ...identityAttributes(trace),
              ...contribution.attributes,
            },
          },
        );
        if (reason !== null)
          throw new Diagnostic(
            "system.tracking.record_refused",
            `tracking: the span record ${contribution.record_id} was refused: ${reason}.`,
          );
      });
    } catch {
      this.dropped += 1;
    }
  }

  telemetryWrite(
    executionId: string,
    records: readonly TelemetryRecord[],
    caller: CallerContext,
  ): Acknowledgement {
    const proof = caller.execution;
    assert.ok(proof, "a telemetry write requires an execution proof");
    assert.equal(proof.executionId, executionId);
    const trace = this.dependencies.executions.traceOf(executionId);
    assert.ok(trace, "a proven execution has a trace");
    return caller.commit((tx) => {
      const now = Date.now();
      insertTrace(tx, trace, now);
      const admission: Admission = {
        trace,
        producer: proof.runtimeIdentity,
        origin: SpanOrigin.Observed,
        now,
      };
      return admitRecords(tx, admission, records);
    });
  }

  traceGet(traceId: string, caller: CallerContext) {
    assert.ok(traceId);
    assert.ok(caller.identity);
    return caller.commit((tx) => readTrace(tx, traceId) ?? traceNotFound());
  }

  spanList(
    traceId: string,
    query: { limit: number; cursor?: string },
    caller: CallerContext,
  ) {
    assert.ok(traceId);
    assert.ok(caller.identity);
    const after = decodeCursor(query.cursor);
    return caller.commit((tx) => {
      if (!readTrace(tx, traceId)) traceNotFound();
      const page = listSpans(tx, traceId, after, query.limit);
      return { items: page.items, next_cursor: encodeCursor(page.last) };
    });
  }

  textGet(traceId: string, textId: string, caller: CallerContext) {
    assert.ok(textId);
    assert.ok(caller.identity);
    return caller.commit((tx) => {
      if (!readTrace(tx, traceId)) traceNotFound();
      const row = readText(tx, traceId, textId);
      if (!row)
        throw new OperationError(
          HttpStatus.NotFound,
          "tracking.text.not_found",
          "The telemetry text is unknown.",
        );
      return row;
    });
  }

  declare(registry: OperationRegistry): void {
    const operations = Object.values(trackingOperations);
    if (
      operations.some(
        (operation) => operation.service !== TRACKING_SERVICE_NAME,
      ) ||
      trackingOperations.telemetryWrite.access !== AccessPolicy.Client ||
      trackingOperations.traceGet.access !== AccessPolicy.Human ||
      trackingOperations.spanList.access !== AccessPolicy.Human ||
      trackingOperations.textGet.access !== AccessPolicy.Human
    )
      throw new Error(
        "Tracking operations require tracking ownership and their declared access.",
      );
    registry.register(trackingOperations.telemetryWrite, (input, caller) =>
      this.telemetryWrite(
        input.params.execution_id,
        input.body.records,
        caller,
      ),
    );
    registry.register(trackingOperations.traceGet, (input, caller) =>
      this.traceGet(input.params.trace_id, caller),
    );
    registry.register(trackingOperations.spanList, (input, caller) =>
      this.spanList(input.params.trace_id, input.query, caller),
    );
    registry.register(trackingOperations.textGet, (input, caller) =>
      this.textGet(input.params.trace_id, input.params.text_id, caller),
    );
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
      return Promise.resolve(
        new Diagnostic(
          TRACKING_STOPPED_CODE,
          "tracking: a stopped service cannot start again.",
        ),
      );
    this.started = true;
    return Promise.resolve(null);
  }
  quiesce(): Promise<Error | null> {
    return Promise.resolve(null);
  }
  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    return Promise.resolve(null);
  }
  async run(context: Context = background): Promise<Error | null> {
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      store:
        this.started && this.dependencies.store.healthcheck()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}

function stopAttributes(stop: RootSpanEnd["stop"]): Attributes {
  if (stop === null) return {};
  assert.ok(stop.reason);
  return stop.code === null
    ? { "kanthord.stop.reason": stop.reason }
    : { "kanthord.stop.reason": stop.reason, "kanthord.stop.code": stop.code };
}
