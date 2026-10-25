import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
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
import { identityTime } from "../kernel/identity.ts";
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
  TRANSITION_SPAN_OPERATION,
  Disposition,
  ExecutionEnd,
  RefusalReason,
  RevokeCause,
  revokeCauseSchema,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
  TransitionRule,
  transitionRuleSchema,
  traceIdSchema,
  spanIdSchema,
  traceSortSchema,
  trackingOperations,
  type Acknowledgement,
  type Attributes,
  type ExecutionOpening,
  type ExecutionTelemetry,
  type ExecutionTrace,
  type ExecutionTraces,
  type ExecutionTransition,
  type RootSpanEnd,
  type ServerTrace,
  type TelemetryRecord,
  type TimelineListQuery,
  type TraceSort,
} from "./contract.ts";
import {
  TRACE_END_SPAN_ID,
  listTimeline,
  type TimelineCursor,
} from "./timeline.ts";
import {
  RETENTION_SWEEP_INTERVAL_MS,
  retentionCutoff,
  sweepExpiredTraces,
} from "./retention.ts";
import {
  listTraces,
  readFacets,
  type TraceCursor,
  type TraceListQuery,
} from "./trace-list.ts";
import {
  insertTrace,
  listSessionEntries,
  listSpans,
  readSessionEntry,
  readText,
  readTrace,
  traceRowOf,
  type TraceRow,
} from "./trace-store.ts";

const ROOT_START_RECORD = "start";
const ROOT_END_RECORD = "end";
const TRANSITION_RECORD = "transition";
const SPAN_ID_LENGTH = 16;
const TRACKING_STOPPED_CODE = "system.tracking.stopped";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const CURSOR_START = 0;
const TRACE_CURSOR_PARTS = 3;
const TIMELINE_CURSOR_PARTS = 4;

export interface Dependencies {
  store: Store;
  executions: ExecutionTraces;
  health?: HealthRegistry;
  retentionDays: number;
  now?: () => number;
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

function cursorInvalid(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    CURSOR_INVALID_CODE,
    "Cursor is invalid.",
  );
}

function parsedCursor(decoded: string): unknown {
  try {
    return JSON.parse(decoded);
  } catch {
    return cursorInvalid();
  }
}

function decodeTraceCursor(
  cursor: string | undefined,
  sort: TraceSort,
): TraceCursor | null {
  if (cursor === undefined) return null;
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  const parts = parsedCursor(decoded);
  if (
    !Array.isArray(parts) ||
    parts.length !== TRACE_CURSOR_PARTS ||
    !traceSortSchema.safeParse(parts[0]).success ||
    parts[0] !== sort
  )
    return cursorInvalid();
  const [, value, position] = parts;
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(position) ||
    position <= CURSOR_START
  )
    return cursorInvalid();
  const traceCursor = { sort, value, position };
  if (encodeTraceCursor(traceCursor) !== cursor) return cursorInvalid();
  return traceCursor;
}

function encodeTraceCursor(cursor: TraceCursor | null): string | null {
  if (cursor === null) return null;
  return Buffer.from(
    JSON.stringify([cursor.sort, cursor.value, cursor.position]),
    TEXT_ENCODING,
  ).toString(CURSOR_ENCODING);
}

function decodeTimelineCursor(
  cursor: string | undefined,
): TimelineCursor | null {
  if (cursor === undefined) return null;
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  const parts = parsedCursor(decoded);
  if (!Array.isArray(parts) || parts.length !== TIMELINE_CURSOR_PARTS)
    return cursorInvalid();
  const [traceTime, traceId, itemTime, spanId] = parts;
  if (
    !Number.isSafeInteger(traceTime) ||
    !traceIdSchema.safeParse(traceId).success ||
    !Number.isSafeInteger(itemTime) ||
    (spanId !== TRACE_END_SPAN_ID && !spanIdSchema.safeParse(spanId).success)
  )
    return cursorInvalid();
  const timelineCursor = {
    trace_time: traceTime,
    trace_id: traceId,
    item_time: itemTime,
    span_id: spanId,
  };
  if (encodeTimelineCursor(timelineCursor) !== cursor) return cursorInvalid();
  return timelineCursor;
}

function encodeTimelineCursor(cursor: TimelineCursor | null): string | null {
  if (cursor === null) return null;
  return Buffer.from(
    JSON.stringify([
      cursor.trace_time,
      cursor.trace_id,
      cursor.item_time,
      cursor.span_id,
    ]),
    TEXT_ENCODING,
  ).toString(CURSOR_ENCODING);
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
  private failedSweeps = 0;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
    dependencies.health?.register(TRACKING_SERVICE_NAME, () =>
      this.healthcheck(),
    );
  }

  droppedRecords(): number {
    return this.dropped;
  }

  sweepFailures(): number {
    return this.failedSweeps;
  }

  sweep(): number {
    try {
      return sweepExpiredTraces(this.dependencies.store, this.cutoff());
    } catch {
      this.failedSweeps += 1;
      return 0;
    }
  }

  private cutoff(): number {
    return retentionCutoff(this.now(), this.dependencies.retentionDays);
  }

  executionOpened(
    trace: ExecutionTrace,
    createdAt: number,
    opening: ExecutionOpening,
  ): void {
    assert.ok(trace.trace_id);
    assert.ok(Number.isSafeInteger(createdAt));
    assert.ok(opening.worker_name);
    assert.ok(Number.isSafeInteger(opening.queue_wait_ms));
    this.serverSpan(trace, SCHEDULER_PRODUCER, {
      record_id: `${trace.root_span_id}:${ROOT_START_RECORD}`,
      span_id: trace.root_span_id,
      parent_span_id: null,
      operation: ROOT_SPAN_OPERATION,
      start_time: createdAt,
      attributes: {
        "kanthord.execution.kind": opening.kind,
        "kanthord.worker.name": opening.worker_name,
        "kanthord.queue.wait_ms": opening.queue_wait_ms,
      },
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
      status: endsWell(end) ? SpanStatus.Ok : SpanStatus.Error,
      attributes: {
        "kanthord.execution.end": end.end,
        ...revokeAttributes(end),
        ...stopAttributes(end.stop),
      },
    });
  }

  executionTransition(
    trace: ExecutionTrace,
    transition: ExecutionTransition,
  ): void {
    assert.ok(trace.trace_id);
    assert.ok(Number.isSafeInteger(transition.transitioned_at));
    const recordId = `${trace.root_span_id}:${TRANSITION_RECORD}`;
    this.serverSpan(trace, SCHEDULER_PRODUCER, {
      record_id: recordId,
      span_id: createHash("sha256")
        .update(recordId)
        .digest("hex")
        .slice(0, SPAN_ID_LENGTH),
      parent_span_id: trace.root_span_id,
      operation: TRANSITION_SPAN_OPERATION,
      start_time: transition.transitioned_at,
      end_time: transition.transitioned_at,
      status: SpanStatus.Ok,
      attributes: transitionAttributes(transition),
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
    if (identityTime(trace.execution_id) < this.cutoff()) {
      this.dropped += 1;
      return;
    }
    this.admitServerSpan(traceRowOf(trace), null, producer, {
      ...contribution,
      attributes: {
        ...identityAttributes(trace),
        ...contribution.attributes,
      },
    });
  }

  serverTraceSpan(
    trace: ServerTrace,
    producer: string,
    contribution: SpanContribution,
  ): void {
    assert.ok(contribution.record_id);
    assert.ok(producer);
    assert.ok(
      contribution.span_id === trace.root_span_id ||
        contribution.parent_span_id === trace.root_span_id,
    );
    if (trace.created_at < this.cutoff()) {
      this.dropped += 1;
      return;
    }
    this.admitServerSpan(
      traceRowOf(trace),
      trace.created_at,
      producer,
      contribution,
    );
  }

  private admitServerSpan(
    row: TraceRow,
    createdAt: number | null,
    producer: string,
    contribution: SpanContribution,
  ): void {
    try {
      this.dependencies.store.transaction((tx) => {
        const now = this.now();
        insertTrace(tx, row, createdAt ?? now);
        const reason = admitServerSpan(
          tx,
          { trace: row, producer, origin: SpanOrigin.Observed, now },
          contribution,
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
    if (identityTime(executionId) < this.cutoff())
      return {
        dispositions: records.map((record) => ({
          record_id: record.record_id,
          disposition: Disposition.Refused,
          reason: RefusalReason.TraceExpired,
        })),
        submitted: records.length,
        stored: 0,
        refused: records.length,
      };
    const trace = this.dependencies.executions.traceOf(executionId);
    assert.ok(trace, "a proven execution has a trace");
    return caller.commit((tx) => {
      const now = this.now();
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

  traceList(query: TraceListQuery, caller: CallerContext) {
    assert.ok(caller.identity);
    const after = decodeTraceCursor(query.cursor, query.sort);
    return caller.commit((tx) => {
      const page = listTraces(tx, query, after);
      return { items: page.items, next_cursor: encodeTraceCursor(page.last) };
    });
  }

  timelineList(query: TimelineListQuery, caller: CallerContext) {
    assert.ok(caller.identity);
    const after = decodeTimelineCursor(query.cursor);
    return caller.commit((tx) => {
      const page = listTimeline(tx, query, after);
      return {
        items: page.items,
        next_cursor: encodeTimelineCursor(page.next_cursor),
      };
    });
  }

  facetGet(query: { project_id?: string }, caller: CallerContext) {
    assert.ok(caller.identity);
    return caller.commit((tx) => readFacets(tx, query.project_id));
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

  sessionEntryList(
    params: { trace_id: string; session_id: string },
    query: { limit: number; cursor?: string; tool_call_id?: string },
    caller: CallerContext,
  ) {
    assert.ok(params.session_id);
    assert.ok(caller.identity);
    const after = decodeCursor(query.cursor);
    return caller.commit((tx) => {
      if (!readTrace(tx, params.trace_id)) traceNotFound();
      const page = listSessionEntries(
        tx,
        params.trace_id,
        params.session_id,
        after,
        query.limit,
        query.tool_call_id,
      );
      return { items: page.items, next_cursor: encodeCursor(page.last) };
    });
  }

  sessionEntryGet(
    params: { trace_id: string; session_id: string; entry_id: string },
    caller: CallerContext,
  ) {
    assert.ok(params.entry_id);
    assert.ok(caller.identity);
    return caller.commit((tx) => {
      if (!readTrace(tx, params.trace_id)) traceNotFound();
      const entry = readSessionEntry(
        tx,
        params.trace_id,
        params.session_id,
        params.entry_id,
      );
      if (!entry)
        throw new OperationError(
          HttpStatus.NotFound,
          "tracking.entry.not_found",
          "The session entry is unknown.",
        );
      return entry;
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
      trackingOperations.traceList.access !== AccessPolicy.Human ||
      trackingOperations.facetGet.access !== AccessPolicy.Human ||
      trackingOperations.timelineList.access !== AccessPolicy.Human ||
      trackingOperations.spanList.access !== AccessPolicy.Human ||
      trackingOperations.textGet.access !== AccessPolicy.Human ||
      trackingOperations.sessionEntryList.access !== AccessPolicy.Human ||
      trackingOperations.sessionEntryGet.access !== AccessPolicy.Human
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
    registry.register(trackingOperations.traceList, (input, caller) =>
      this.traceList(input.query, caller),
    );
    registry.register(trackingOperations.facetGet, (input, caller) =>
      this.facetGet(input.query, caller),
    );
    registry.register(trackingOperations.timelineList, (input, caller) =>
      this.timelineList(input.query, caller),
    );
    registry.register(trackingOperations.spanList, (input, caller) =>
      this.spanList(input.params.trace_id, input.query, caller),
    );
    registry.register(trackingOperations.textGet, (input, caller) =>
      this.textGet(input.params.trace_id, input.params.text_id, caller),
    );
    registry.register(trackingOperations.sessionEntryList, (input, caller) =>
      this.sessionEntryList(input.params, input.query, caller),
    );
    registry.register(trackingOperations.sessionEntryGet, (input, caller) =>
      this.sessionEntryGet(input.params, caller),
    );
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Diagnostic(
          TRACKING_STOPPED_CODE,
          "tracking: a stopped service cannot start again.",
        ),
      );
    this.started = true;
    this.sweep();
    this.sweepTimer = setInterval(
      () => this.sweep(),
      RETENTION_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref();
    return Promise.resolve(null);
  }
  quiesce(): Promise<Error | null> {
    return Promise.resolve(null);
  }
  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    clearInterval(this.sweepTimer);
    this.started = false;
    return Promise.resolve(null);
  }
  async run(context: Context = background): Promise<Error | null> {
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await this.start();
    if (error) return error;
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
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

function endsWell(end: RootSpanEnd): boolean {
  if (end.end === ExecutionEnd.Revoked)
    return end.revoke_cause === RevokeCause.Assessment;
  return end.stop === null && end.end === ExecutionEnd.Finished;
}

function revokeAttributes(end: RootSpanEnd): Attributes {
  if (end.end !== ExecutionEnd.Revoked) return {};
  assert.ok(end.revoke_cause);
  return { "kanthord.revoke.cause": revokeCauseSchema.parse(end.revoke_cause) };
}

function transitionAttributes(transition: ExecutionTransition): Attributes {
  assert.ok(transition.from);
  assert.ok(transition.to);
  const limited = transition.rule !== TransitionRule.None;
  assert.equal(limited, transition.count !== null);
  assert.equal(limited, transition.limit !== null);
  return {
    "kanthord.node.state.from": transition.from,
    "kanthord.node.state.to": transition.to,
    "kanthord.transition.rule": transitionRuleSchema.parse(transition.rule),
    ...(transition.count === null || transition.limit === null
      ? {}
      : {
          "kanthord.transition.count": transition.count,
          "kanthord.transition.limit": transition.limit,
        }),
  };
}

function stopAttributes(stop: RootSpanEnd["stop"]): Attributes {
  if (stop === null) return {};
  assert.ok(stop.reason);
  return {
    "kanthord.stop.reason": stop.reason,
    ...(stop.code === null ? {} : { "kanthord.stop.code": stop.code }),
    ...(stop.detail === undefined
      ? {}
      : { "kanthord.stop.detail": stop.detail }),
  };
}
