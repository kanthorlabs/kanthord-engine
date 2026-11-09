import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { IdentityKind } from "../kernel/caller.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  type CallerContext,
  OperationRegistry,
} from "../kernel/operation.ts";
import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
  unattributed,
} from "../kernel/cause.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  testHumanIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
import {
  AnalyticsBucket,
  AnalyticsMeasure,
  CostGroupBy,
  Disposition,
  ExecutionEnd,
  ExecutionKind,
  type ExecutionOpening,
  type ExecutionTrace,
  FlowExit,
  FlowGrain,
  FlowKind,
  FlowStage,
  MISSION_PRODUCER,
  PROJECT_PRODUCER,
  RecordKind,
  RefusalReason,
  RevokeCause,
  type RootSpanEnd,
  SCHEDULER_PRODUCER,
  type ServerTrace,
  SESSION_ENTRY_FULL_MAX_BYTES,
  SessionAbsentReason,
  type SessionEntryRecord,
  type SessionHosts,
  type SessionReadAnswer,
  SpanOrigin,
  SpanStatus,
  type TelemetryRecord,
  TimelineDepth,
  TraceSort,
  TraceState,
  TRACKING_SERVICE_NAME,
  trackingOperations,
  TransitionRule,
  UnreachableReason,
} from "./contract.ts";
import { type SessionRead, SessionReadOutcome } from "../worker/contract.ts";
import { FLOW_VECTOR_COLUMNS } from "./flow-model.ts";
import { CauseLabelCode, HUMAN_USERNAME_ATTRIBUTE } from "./cause-label.ts";
import { trackingMigrations } from "./migrations.ts";
import { TrackingService } from "./service.ts";
import { insertSessionEntry, insertSpan, insertTrace } from "./trace-store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const HUMAN_ACCOUNT = "account_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const TRACE: ExecutionTrace = {
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
};
const OPENING: ExecutionOpening = {
  kind: ExecutionKind.Steps,
  worker_name: "coder@1",
  queue_wait_ms: 250,
  worker_instance: null,
  placement: null,
  revision_turn: null,
  dependency_count: null,
  node_name: null,
};
const SPAN = "2".repeat(16);
const RUNTIME = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const CREATED = 1000;
const NOW = 1751566593132;
const WRITABLE_DAYS = 30;
const EXPIRED_AGE_DAYS = 31;
const DAY_MS = 86400000;
const NO_STORED = 0;
const CURRENT_FLOW_SUCCESS = 2;
const PREVIOUS_FLOW_SUCCESS = 4;
const ENDED = 5000;
const NO_DROP = 0;
const NO_ROWS = 0;
const ONE_ENTRY = 1;
const ONE_DROP = 1;
const ONE_FAILURE = 1;
const BACKFILL_WAIT_TURNS = 100;
const PAGE_OF_ONE = 1;
const STOP_DETAIL = "Cannot find module";
const SPAN_PAGE = 10;
const TRANSITION_SPAN = "scheduler.transition";
const RATE_LIMITED = "rate_limited";
const INPUT_TEXT = "npm test";
const TRACE_NOT_FOUND = "tracking.trace.not_found";
const TEXT_NOT_FOUND = "tracking.text.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const OTHER_EXECUTION = "execution_01JZ8R2B3C4D5E6F7G8H9J0K1N";
const OTHER_TRACE = "b".repeat(32);

const unusedSessionHosts: SessionHosts = {
  read: () => Promise.reject(new Error("Unexpected session read")),
};

function harness(
  t: TestContext,
  now: () => number = () => NOW,
  sessionHosts: SessionHosts = unusedSessionHosts,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const service = new TrackingService({
    store,
    writableDays: WRITABLE_DAYS,
    isHostedWorker: () => false,
    now,
    executions: {
      traceOf: (executionId) =>
        executionId === TRACE.execution_id ? TRACE : undefined,
    },
    sessionHosts,
  });
  return { store, service };
}

function caller(store: Store, execution = true): CallerContext {
  return {
    identity: {
      kind: IdentityKind.Human,
      accountId: HUMAN_ACCOUNT,
      name: "Ulrich",
      jti: "jti",
    },
    execution: execution
      ? {
          executionId: TRACE.execution_id,
          projectId: TRACE.project_id,
          nodeId: TRACE.node_id,
          nodeBranch: `kanthord/${TRACE.node_id}`,
          attempt: TRACE.attempt,
          pinnedRevision: 1,
          runtimeIdentity: RUNTIME,
          workerBindingId: "binding_01JZ8R2B3C4D5E6F7G8H9J0K1M",
        }
      : undefined,
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
}

test("a transition span is a child of the root span with the states, the rule and the time of the transition", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  const transition = {
    from: "Evaluating",
    to: "Blocked",
    rule: TransitionRule.ReworkLimit,
    count: 3,
    limit: 3,
    lead_time_ms: null,
    failure_count: null,
    available_at: null,
    transitioned_at: ENDED,
  };
  service.executionTransition(TRACE, transition);
  service.executionTransition(TRACE, transition);
  const items = service.spanList(
    TRACE.trace_id,
    { limit: SPAN_PAGE },
    caller(store),
  ).items;
  const spans = items.filter((span) => span.operation === TRANSITION_SPAN);
  assert.equal(spans.length, ONE_ENTRY);
  const span = spans[0]!;
  assert.equal(span.parent_span_id, TRACE.root_span_id);
  assert.equal(span.producer, SCHEDULER_PRODUCER);
  assert.equal(span.start_time, ENDED);
  assert.equal(span.end_time, ENDED);
  assert.equal(span.status, SpanStatus.Ok);
  assert.deepEqual(span.attributes, {
    "kanthord.execution.id": TRACE.execution_id,
    "kanthord.node.id": TRACE.node_id,
    "kanthord.project.id": TRACE.project_id,
    "kanthord.attempt": TRACE.attempt,
    "kanthord.node.state.from": "Evaluating",
    "kanthord.node.state.to": "Blocked",
    "kanthord.transition.rule": TransitionRule.ReworkLimit,
    "kanthord.transition.count": 3,
    "kanthord.transition.limit": 3,
  });
  assert.equal(
    store.database
      .prepare(
        "SELECT count(*) AS count FROM tracking_record WHERE record_id = ?",
      )
      .get(`${TRACE.root_span_id}:transition`)!.count,
    ONE_ENTRY,
  );
  assert.equal(service.droppedRecords(), NO_DROP);
});

test("a transition span refuses a count and a limit that do not match its rule", (t) => {
  const { service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  const transition = {
    from: "Evaluating",
    to: "Blocked",
    lead_time_ms: null,
    failure_count: null,
    available_at: null,
    transitioned_at: ENDED,
  };
  for (const mismatch of [
    { rule: TransitionRule.PlanDefect, count: 3, limit: 3 },
    { rule: TransitionRule.ReworkLimit, count: null, limit: null },
  ])
    assert.throws(
      () => service.executionTransition(TRACE, { ...transition, ...mismatch }),
      assert.AssertionError,
    );
});

for (const [cause, status, state] of [
  [RevokeCause.Human, SpanStatus.Error, TraceState.Error],
  [RevokeCause.Assessment, SpanStatus.Ok, TraceState.Ok],
] as const) {
  test(`a revocation by ${cause} stores the cause and ends the trace as ${state}`, (t) => {
    const { store, service } = harness(t);
    service.executionOpened(TRACE, CREATED, OPENING);
    service.executionEnded({
      trace: TRACE,
      ended_at: ENDED,
      end: ExecutionEnd.Revoked,
      revoke_cause: cause,
      stop: null,
      cause: null,
    });
    const root = service.spanList(
      TRACE.trace_id,
      { limit: PAGE_OF_ONE },
      caller(store),
    ).items[0];
    assert.equal(root?.end_time, ENDED);
    assert.equal(root?.status, status);
    assert.equal(
      root?.attributes["kanthord.execution.end"],
      ExecutionEnd.Revoked,
    );
    assert.equal(root?.attributes["kanthord.revoke.cause"], cause);
    assert.equal(service.traceGet(TRACE.trace_id, caller(store)).state, state);
  });
}

test("a revocation with an unknown cause is refused and writes no end", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.throws(() =>
    service.executionEnded({
      trace: TRACE,
      ended_at: ENDED,
      end: ExecutionEnd.Revoked,
      revoke_cause: "other" as RevokeCause,
      stop: null,
      cause: null,
    }),
  );
  const root = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  ).items[0];
  assert.equal(root?.end_time, null);
});

function rootOf(
  service: TrackingService,
  store: Store,
): Record<string, unknown> {
  return service.spanList(TRACE.trace_id, { limit: PAGE_OF_ONE }, caller(store))
    .items[0]!.attributes;
}

function endWith(service: TrackingService, cause: RootSpanEnd["cause"]): void {
  service.executionOpened(TRACE, CREATED, OPENING);
  service.executionEnded({
    trace: TRACE,
    ended_at: ENDED,
    end: ExecutionEnd.Finished,
    revoke_cause: null,
    stop: { reason: "provider_failed", code: RATE_LIMITED },
    cause,
  });
}

test("a root end with an attributed cause holds the category, the subcategory and the assigner and no suspects", (t) => {
  const { store, service } = harness(t);
  endWith(
    service,
    attributed(CauseCategory.LlmProvider, CauseSubcategory.RateLimited),
  );
  const attributes = rootOf(service, store);
  assert.equal(
    attributes["kanthord.cause.category"],
    CauseCategory.LlmProvider,
  );
  assert.equal(
    attributes["kanthord.cause.subcategory"],
    CauseSubcategory.RateLimited,
  );
  assert.equal(attributes["kanthord.cause.assigner"], CauseAssigner.Rule);
  assert.equal("kanthord.cause.suspects" in attributes, false);
});

test("a root end with an unattributed cause holds the suspects in order", (t) => {
  const { store, service } = harness(t);
  endWith(
    service,
    unattributed([CauseCategory.Model, CauseCategory.Environment]),
  );
  const attributes = rootOf(service, store);
  assert.equal(
    attributes["kanthord.cause.category"],
    CauseCategory.Unattributed,
  );
  assert.deepEqual(attributes["kanthord.cause.suspects"], [
    CauseCategory.Model,
    CauseCategory.Environment,
  ]);
  assert.equal("kanthord.cause.subcategory" in attributes, false);
});

test("the root span end carries the stop detail", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  service.executionEnded({
    trace: TRACE,
    ended_at: ENDED,
    end: ExecutionEnd.Finished,
    revoke_cause: null,
    stop: {
      reason: "provider_failed",
      code: "unavailable",
      detail: STOP_DETAIL,
    },
    cause: null,
  });
  const root = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  ).items[0];
  assert.equal(root?.attributes["kanthord.stop.detail"], STOP_DETAIL);
});

test("a repeated root open changes nothing", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  service.executionOpened(TRACE, ENDED, OPENING);
  const trace = service.traceGet(TRACE.trace_id, caller(store));
  assert.equal(trace.execution_id, TRACE.execution_id);
  const root = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  ).items[0];
  assert.equal(root?.start_time, CREATED);
  assert.equal(service.droppedRecords(), NO_DROP);
});

test("a failed root write is counted and never thrown", (t) => {
  const { store, service } = harness(t);
  store.close();
  assert.doesNotThrow(() => service.executionOpened(TRACE, CREATED, OPENING));
  assert.equal(service.droppedRecords(), ONE_DROP);
});

function kindOf(store: Store): unknown {
  return store.database
    .prepare("SELECT kind FROM tracking_trace WHERE trace_id = ?")
    .get(TRACE.trace_id)?.kind;
}

function toolStart(): TelemetryRecord {
  return {
    record_id: `${SPAN}:start`,
    trace_id: TRACE.trace_id,
    kind: RecordKind.Span,
    span_id: SPAN,
    operation: "agent.tool",
    parent_span_id: TRACE.root_span_id,
    start_time: CREATED,
  };
}

function toolEnd(): TelemetryRecord {
  return {
    record_id: `${SPAN}:end`,
    trace_id: TRACE.trace_id,
    kind: RecordKind.Span,
    span_id: SPAN,
    operation: "agent.tool",
    parent_span_id: TRACE.root_span_id,
    end_time: ENDED,
  };
}

test("a telemetry write opens a new execution trace with the empty kind and keeps the kind of a stored row", (t) => {
  const { store, service } = harness(t);
  service.telemetryWrite(TRACE.execution_id, [toolStart()], caller(store));
  assert.deepEqual([kindOf(store)], [""]);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.equal(kindOf(store), ExecutionKind.Steps);
  service.telemetryWrite(TRACE.execution_id, [toolEnd()], caller(store));
  assert.equal(kindOf(store), ExecutionKind.Steps);
});

test("a server span opens a new execution trace with the empty kind and the root start sets the kind", (t) => {
  const { store, service } = harness(t);
  service.serverSpan(TRACE, SCHEDULER_PRODUCER, {
    record_id: `${SPAN}:server`,
    span_id: SPAN,
    parent_span_id: TRACE.root_span_id,
    operation: TRANSITION_SPAN,
    start_time: CREATED,
  });
  assert.deepEqual([kindOf(store)], [""]);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.equal(kindOf(store), ExecutionKind.Steps);
  assert.equal(service.droppedRecords(), NO_DROP);
});

test("the claim writes the flow rows of its execution", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  const rows = store.database
    .prepare(
      "SELECT grain, stage, exit, executions FROM tracking_flow_rollup ORDER BY grain",
    )
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { grain: "day", stage: "executing", exit: "open", executions: 1 },
    { grain: "hour", stage: "executing", exit: "open", executions: 1 },
  ]);
});

test("a trace delete removes its spans, records, texts and session entries", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  service.telemetryWrite(
    TRACE.execution_id,
    [
      {
        record_id: `${SPAN}:start`,
        trace_id: TRACE.trace_id,
        kind: RecordKind.Span,
        span_id: SPAN,
        operation: "agent.tool",
        parent_span_id: TRACE.root_span_id,
        start_time: CREATED,
        text_ids: [`${SPAN}:input`],
      },
      {
        record_id: `${SPAN}:input`,
        trace_id: TRACE.trace_id,
        kind: RecordKind.Text,
        text_id: `${SPAN}:input`,
        text: INPUT_TEXT,
      },
      {
        record_id: `${SPAN}:entry.e1`,
        trace_id: TRACE.trace_id,
        kind: RecordKind.SessionEntry,
        session_id: SPAN,
        entry_id: "e1",
        parent_entry_id: null,
        sequence: 1,
        entry_type: "message",
        entry_time: CREATED,
        tool_call_id: null,
        truncated: false,
        entry: { role: "user" },
      },
    ],
    caller(store),
  );
  assert.equal(
    store.database
      .prepare("SELECT count(*) AS count FROM tracking_session_entry")
      .get()?.count,
    ONE_ENTRY,
  );
  store.transaction((tx) =>
    tx.database
      .prepare("DELETE FROM tracking_trace WHERE trace_id = ?")
      .run(TRACE.trace_id),
  );
  for (const read of [
    () => service.traceGet(TRACE.trace_id, caller(store)),
    () => service.spanList(TRACE.trace_id, { limit: SPAN_PAGE }, caller(store)),
    () => service.textGet(TRACE.trace_id, `${SPAN}:input`, caller(store)),
  ])
    assert.throws(
      read,
      (error) =>
        error instanceof OperationError && error.code === TRACE_NOT_FOUND,
    );
  for (const table of [
    "tracking_span",
    "tracking_record",
    "tracking_telemetry_text",
    "tracking_session_entry",
  ])
    assert.equal(
      store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get()
        ?.count,
      NO_ROWS,
    );
});

test("a server span of another producer under the root span is stored", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  const contribution = {
    record_id: `${SPAN}:end`,
    span_id: SPAN,
    parent_span_id: TRACE.root_span_id,
    operation: "mission.evidence.asset.complete",
    start_time: CREATED,
    end_time: CREATED,
    status: SpanStatus.Error,
    attributes: { "error.type": "intake.storage.object_mismatch" },
  };
  service.serverSpan(TRACE, MISSION_PRODUCER, contribution);
  const spans = service.spanList(
    TRACE.trace_id,
    { limit: SPAN_PAGE },
    caller(store),
  ).items;
  const span = spans.find((entry) => entry.span_id === SPAN);
  assert.equal(span?.producer, MISSION_PRODUCER);
  assert.equal(span?.origin, SpanOrigin.Observed);
  assert.equal(span?.parent_span_id, TRACE.root_span_id);
  assert.equal(span?.status, SpanStatus.Error);
  assert.equal(
    span?.attributes["error.type"],
    contribution.attributes["error.type"],
  );
  assert.equal(span?.attributes["kanthord.execution.id"], TRACE.execution_id);
  assert.equal(service.droppedRecords(), NO_DROP);
  service.serverSpan(TRACE, "other", {
    ...contribution,
    record_id: `${SPAN}:other`,
  });
  assert.equal(service.droppedRecords(), ONE_DROP);
});

test("a server span outside the root span is refused by assertion", (t) => {
  const { service } = harness(t);
  assert.throws(() =>
    service.serverSpan(TRACE, MISSION_PRODUCER, {
      record_id: `${SPAN}:end`,
      span_id: SPAN,
      parent_span_id: "3".repeat(16),
      operation: "mission.evidence.asset.complete",
      end_time: CREATED,
    }),
  );
});

test("a span page continues from its cursor", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  service.telemetryWrite(
    TRACE.execution_id,
    [
      {
        record_id: `${SPAN}:start`,
        trace_id: TRACE.trace_id,
        kind: RecordKind.Span,
        span_id: SPAN,
        operation: "agent.turn",
        parent_span_id: TRACE.root_span_id,
        start_time: CREATED,
      },
    ],
    caller(store),
  );
  const first = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  );
  assert.ok(first.next_cursor);
  const second = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE, cursor: first.next_cursor },
    caller(store),
  );
  assert.equal(second.items[0]?.span_id, SPAN);
  assert.equal(second.next_cursor, null);
});

test("an unknown trace and an unknown text answer not found", (t) => {
  const { store, service } = harness(t);
  assert.throws(
    () => service.traceGet("c".repeat(32), caller(store)),
    (error) =>
      error instanceof OperationError && error.code === TRACE_NOT_FOUND,
  );
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.throws(
    () => service.textGet(TRACE.trace_id, `${SPAN}:input`, caller(store)),
    (error) => error instanceof OperationError && error.code === TEXT_NOT_FOUND,
  );
});

function traceListQuery(
  overrides: Partial<Parameters<TrackingService["traceList"]>[0]> = {},
) {
  return { sort: TraceSort.StartedAt, limit: PAGE_OF_ONE, ...overrides };
}

function cursorOf(parts: unknown): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function cursorInvalid(error: unknown): boolean {
  return error instanceof OperationError && error.code === CURSOR_INVALID;
}

test("a trace page continues from its cursor and ends with a null cursor", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  store.transaction((tx) =>
    insertTrace(
      tx,
      {
        ...TRACE,
        trace_id: OTHER_TRACE,
        execution_id: OTHER_EXECUTION,
        root_span_id: "4".repeat(16),
      },
      ENDED,
    ),
  );
  const first = service.traceList(traceListQuery(), caller(store));
  assert.equal(first.items[0]?.trace_id, OTHER_TRACE);
  assert.ok(first.next_cursor);
  const second = service.traceList(
    traceListQuery({ cursor: first.next_cursor }),
    caller(store),
  );
  assert.equal(second.items[0]?.trace_id, TRACE.trace_id);
  assert.equal(second.next_cursor, null);
});

test("a malformed cursor and a cursor of another sort are refused", (t) => {
  const { store, service } = harness(t);
  for (const cursor of [
    "not-a-cursor",
    cursorOf("text"),
    cursorOf([TraceSort.StartedAt, 1]),
    cursorOf([TraceSort.StartedAt, "1", 1]),
    cursorOf([TraceSort.StartedAt, 1, 0]),
    cursorOf(["unknown", 1, 1]),
    cursorOf([TraceSort.CostUsd, 1, 1]),
  ])
    assert.throws(
      () => service.traceList(traceListQuery({ cursor }), caller(store)),
      cursorInvalid,
    );
});

const TIMELINE_PAGE = 100;

function timelineListQuery(
  overrides: Partial<Parameters<TrackingService["timelineList"]>[0]> = {},
) {
  return {
    node_id: TRACE.node_id,
    depth: TimelineDepth.Child,
    limit: TIMELINE_PAGE,
    ...overrides,
  };
}

test("a trace list and a timeline with from after to answer the range error", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  const inverted = { from: ENDED, to: CREATED };
  assert.throws(
    () => service.traceList(traceListQuery(inverted), caller(store)),
    rangeInvalid,
  );
  assert.throws(
    () => service.timelineList(timelineListQuery(inverted), caller(store)),
    rangeInvalid,
  );
  assert.equal(
    service.traceList(
      traceListQuery({ from: CREATED, to: CREATED }),
      caller(store),
    ).items.length,
    ONE_ENTRY,
  );
});

test("a malformed timeline cursor is refused", (t) => {
  const { store, service } = harness(t);
  for (const cursor of [
    "not-a-cursor",
    cursorOf("text"),
    cursorOf([1, TRACE.trace_id, 1]),
    cursorOf([1, TRACE.trace_id, 1, SPAN, 1]),
    cursorOf(["1", TRACE.trace_id, 1, SPAN]),
    cursorOf([1, "short", 1, SPAN]),
    cursorOf([1, TRACE.trace_id, 1.5, SPAN]),
    cursorOf([1, TRACE.trace_id, 1, "short"]),
    cursorOf([1, TRACE.trace_id, 1, null]),
  ])
    assert.throws(
      () => service.timelineList(timelineListQuery({ cursor }), caller(store)),
      cursorInvalid,
    );
});

test("the facet read answers the five arrays", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.deepEqual(service.facetGet({}, caller(store)), {
    worker_names: [OPENING.worker_name],
    agent_names: [],
    models: [],
    error_types: [],
    cause_categories: [],
  });
});

const SECOND_SESSION = "3".repeat(16);
const ENTRY_PAGE = 2;
const ENTRY_COUNT = 5;
const ENTRY_PAGES = 3;
const FIRST_SEQUENCE = 1;
const TRUNCATED_SEQUENCE = 2;
const TOOL_RESULT_SEQUENCE = 4;
const TOOL_CALL = "call_1";
const ENTRY_NOT_FOUND = "tracking.entry.not_found";

function entryRecord(
  sessionId: string,
  sequence: number,
  toolCallId: string | null,
): SessionEntryRecord {
  return {
    record_id: `${sessionId}:entry.e${sequence}`,
    trace_id: TRACE.trace_id,
    kind: RecordKind.SessionEntry,
    session_id: sessionId,
    entry_id: `e${sequence}`,
    parent_entry_id: sequence === FIRST_SEQUENCE ? null : `e${sequence - 1}`,
    sequence,
    entry_type: toolCallId === null ? "message" : "tool_result",
    entry_time: CREATED + sequence,
    tool_call_id: toolCallId,
    truncated: sequence === TRUNCATED_SEQUENCE,
    entry: { sequence, nested: { value: [sequence] } },
  };
}

function entryHarness(
  t: TestContext,
  sessionHosts: SessionHosts = unusedSessionHosts,
) {
  const { store, service } = harness(t, () => NOW, sessionHosts);
  const records = [
    ...Array.from({ length: ENTRY_COUNT }, (_, index) =>
      entryRecord(
        SPAN,
        index + 1,
        index + 1 === TOOL_RESULT_SEQUENCE ? TOOL_CALL : null,
      ),
    ),
    entryRecord(SECOND_SESSION, 1, null),
  ];
  service.telemetryWrite(TRACE.execution_id, records, caller(store));
  return { store, service, records };
}

test("a session entry list pages one session in sequence order", (t) => {
  const { store, service, records } = entryHarness(t);
  const params = { trace_id: TRACE.trace_id, session_id: SPAN };
  const sequences: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = service.sessionEntryList(
      params,
      { limit: ENTRY_PAGE, cursor },
      caller(store),
    );
    sequences.push(...page.items.map((item) => item.sequence));
    cursor = page.next_cursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined && pages <= ENTRY_COUNT);
  assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
  assert.equal(pages, ENTRY_PAGES);
  const first = service.sessionEntryList(
    params,
    { limit: ENTRY_COUNT },
    caller(store),
  );
  assert.equal(first.next_cursor, null);
  for (const [index, item] of first.items.entries()) {
    const written = records[index];
    assert.ok(written?.kind === RecordKind.SessionEntry);
    assert.deepEqual(item, {
      trace_id: written.trace_id,
      session_id: written.session_id,
      entry_id: written.entry_id,
      parent_entry_id: written.parent_entry_id,
      sequence: written.sequence,
      entry_type: written.entry_type,
      entry_time: written.entry_time,
      tool_call_id: written.tool_call_id,
      truncated: written.truncated,
      entry: written.entry,
      created_at: item.created_at,
    });
    assert.ok(Number.isSafeInteger(item.created_at));
  }
});

test("a session entry read answers one entry or a refusal", (t) => {
  const { store, service } = entryHarness(t);
  const params = {
    trace_id: TRACE.trace_id,
    session_id: SECOND_SESSION,
    entry_id: "e1",
  };
  const entry = service.sessionEntryGet(params, caller(store));
  assert.equal(entry.session_id, SECOND_SESSION);
  assert.deepEqual(entry.entry, { sequence: 1, nested: { value: [1] } });
  assert.throws(
    () => service.sessionEntryGet({ ...params, entry_id: "e9" }, caller(store)),
    (error) =>
      error instanceof OperationError && error.code === ENTRY_NOT_FOUND,
  );
  assert.throws(
    () =>
      service.sessionEntryGet(
        { ...params, trace_id: OTHER_TRACE },
        caller(store),
      ),
    (error) =>
      error instanceof OperationError && error.code === TRACE_NOT_FOUND,
  );
});

const REBUILD_INSTANCE = "coder-one";
const REBUILD_PLACEMENT = "server";
const REBUILD_TARGET = {
  instance: REBUILD_INSTANCE,
  placement: REBUILD_PLACEMENT,
};
const FULL_ENTRY = {
  type: "message",
  id: `e${TRUNCATED_SEQUENCE}`,
  full: true,
};
const TOO_LARGE_BYTES = SESSION_ENTRY_FULL_MAX_BYTES + 1;

function rebuildHarness(t: TestContext, answer: SessionReadAnswer) {
  const reads: SessionRead[] = [];
  const hosts: SessionHosts = {
    read: async (read) => {
      reads.push(read);
      return answer;
    },
  };
  return { ...entryHarness(t, hosts), reads };
}

const CUT_ENTRY = {
  trace_id: TRACE.trace_id,
  session_id: SPAN,
  entry_id: `e${TRUNCATED_SEQUENCE}`,
};

async function rejectsWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
  details: unknown,
): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}

test("a rebuild of a cut entry answers the full entry with truncated false", async (t) => {
  const { store, service, reads } = rebuildHarness(t, {
    result: { outcome: SessionReadOutcome.Resolved, entry: FULL_ENTRY },
    ...REBUILD_TARGET,
  });
  const stored = service.sessionEntryGet(CUT_ENTRY, caller(store));
  const rebuilt = await service.sessionEntryRebuild(CUT_ENTRY, caller(store));
  assert.deepEqual(rebuilt, { ...stored, truncated: false, entry: FULL_ENTRY });
  assert.deepEqual(reads, [
    {
      execution_id: TRACE.execution_id,
      session_id: SPAN,
      entry_id: `e${TRUNCATED_SEQUENCE}`,
      entry_type: "message",
    },
  ]);
  assert.deepEqual(service.sessionEntryGet(CUT_ENTRY, caller(store)), stored);
});

test("a rebuild of an uncut entry answers the stored entry and reads no host", async (t) => {
  const { store, service, reads } = rebuildHarness(t, {
    result: { outcome: SessionReadOutcome.Unreadable },
    ...REBUILD_TARGET,
  });
  const params = { ...CUT_ENTRY, entry_id: `e${FIRST_SEQUENCE}` };
  assert.deepEqual(
    await service.sessionEntryRebuild(params, caller(store)),
    service.sessionEntryGet(params, caller(store)),
  );
  assert.equal(reads.length, NO_ROWS);
});

test("a rebuild refuses an unknown trace and an unknown entry before a host read", async (t) => {
  const { store, service, reads } = rebuildHarness(t, {
    result: { outcome: SessionReadOutcome.Unreadable },
    ...REBUILD_TARGET,
  });
  await assert.rejects(
    service.sessionEntryRebuild(
      { ...CUT_ENTRY, trace_id: OTHER_TRACE },
      caller(store),
    ),
    (error) =>
      error instanceof OperationError && error.code === TRACE_NOT_FOUND,
  );
  await assert.rejects(
    service.sessionEntryRebuild(
      { ...CUT_ENTRY, entry_id: "e9" },
      caller(store),
    ),
    (error) =>
      error instanceof OperationError && error.code === ENTRY_NOT_FOUND,
  );
  assert.equal(reads.length, NO_ROWS);
});

const REBUILD_FAILURES: readonly (readonly [
  string,
  SessionReadAnswer,
  number,
  string,
  unknown,
])[] = [
  [
    "too_large",
    {
      result: { outcome: SessionReadOutcome.TooLarge, bytes: TOO_LARGE_BYTES },
      ...REBUILD_TARGET,
    },
    HttpStatus.Conflict,
    "tracking.entry.too_large",
    {
      ...REBUILD_TARGET,
      bytes: TOO_LARGE_BYTES,
      limit: SESSION_ENTRY_FULL_MAX_BYTES,
    },
  ],
  [
    "entry_absent",
    { result: { outcome: SessionReadOutcome.EntryAbsent }, ...REBUILD_TARGET },
    HttpStatus.NotFound,
    "tracking.entry.entry_absent",
    REBUILD_TARGET,
  ],
  [
    "unreadable",
    { result: { outcome: SessionReadOutcome.Unreadable }, ...REBUILD_TARGET },
    HttpStatus.ServiceUnavailable,
    "tracking.entry.unreadable",
    REBUILD_TARGET,
  ],
  [
    "session_absent of the host",
    {
      result: { outcome: SessionReadOutcome.SessionAbsent },
      ...REBUILD_TARGET,
    },
    HttpStatus.NotFound,
    "tracking.entry.session_absent",
    { ...REBUILD_TARGET, reason: SessionAbsentReason.NotKept },
  ],
  [
    "archived",
    { session_absent: SessionAbsentReason.Archived, ...REBUILD_TARGET },
    HttpStatus.NotFound,
    "tracking.entry.session_absent",
    { ...REBUILD_TARGET, reason: SessionAbsentReason.Archived },
  ],
  [
    "instance_unknown",
    {
      session_absent: SessionAbsentReason.InstanceUnknown,
      instance: null,
      placement: null,
    },
    HttpStatus.NotFound,
    "tracking.entry.session_absent",
    {
      instance: null,
      placement: null,
      reason: SessionAbsentReason.InstanceUnknown,
    },
  ],
  ...Object.values(UnreachableReason).map(
    (reason) =>
      [
        `unreachable ${reason}`,
        { unreachable: reason, ...REBUILD_TARGET },
        HttpStatus.ServiceUnavailable,
        "tracking.entry.unreachable",
        { ...REBUILD_TARGET, reason },
      ] as const,
  ),
];

for (const [name, answer, status, code, details] of REBUILD_FAILURES)
  test(`a rebuild answers ${code} for ${name}`, async (t) => {
    const { store, service } = rebuildHarness(t, answer);
    await rejectsWith(
      service.sessionEntryRebuild(CUT_ENTRY, caller(store)),
      status,
      code,
      details,
    );
  });

test("a rebuild of an entry of a trace without an execution answers instance_unknown and reads no host", async (t) => {
  const { store, service, reads } = rebuildHarness(t, {
    result: { outcome: SessionReadOutcome.Unreadable },
    ...REBUILD_TARGET,
  });
  store.transaction((tx) => {
    insertTrace(
      tx,
      {
        trace_id: OTHER_TRACE,
        project_id: TRACE.project_id,
        execution_id: null,
        node_id: null,
        attempt: null,
        root_span_id: TRACE.root_span_id,
      },
      NOW,
    );
    insertSessionEntry(
      tx,
      { ...entryRecord(SPAN, TRUNCATED_SEQUENCE, null), trace_id: OTHER_TRACE },
      NOW,
    );
  });
  await rejectsWith(
    service.sessionEntryRebuild(
      { ...CUT_ENTRY, trace_id: OTHER_TRACE },
      caller(store),
    ),
    HttpStatus.NotFound,
    "tracking.entry.session_absent",
    {
      instance: null,
      placement: null,
      reason: SessionAbsentReason.InstanceUnknown,
    },
  );
  assert.equal(reads.length, NO_ROWS);
});

test("a session entry list refuses an unknown trace and a malformed cursor", (t) => {
  const { store, service } = entryHarness(t);
  assert.throws(
    () =>
      service.sessionEntryList(
        { trace_id: OTHER_TRACE, session_id: SPAN },
        { limit: ENTRY_PAGE },
        caller(store),
      ),
    (error) =>
      error instanceof OperationError && error.code === TRACE_NOT_FOUND,
  );
  assert.throws(
    () =>
      service.sessionEntryList(
        { trace_id: TRACE.trace_id, session_id: SPAN },
        { limit: ENTRY_PAGE, cursor: "not-a-cursor" },
        caller(store),
      ),
    cursorInvalid,
  );
});

const EXPIRED_NOW = NOW + EXPIRED_AGE_DAYS * DAY_MS;

function traceCount(store: Store): number {
  const row = store.database
    .prepare("SELECT COUNT(*) AS count FROM tracking_trace")
    .get() as { count: number };
  return Number(row.count);
}

test("start keeps a trace older than the writable period", async (t) => {
  const { store, service } = harness(t);
  store.transaction((tx) =>
    insertTrace(tx, TRACE, NOW - EXPIRED_AGE_DAYS * DAY_MS),
  );
  stopAfter(t, () => service.stop());
  assert.equal(await service.start(), null);
  assert.equal(traceCount(store), ONE_ENTRY);
  assert.equal(service.backfillFailures(), NO_ROWS);
});

function insertUnfilledTrace(store: Store, createdAt: number): void {
  store.transaction((tx) => {
    insertTrace(tx, TRACE, createdAt);
    tx.database
      .prepare("UPDATE tracking_trace SET kind = NULL WHERE trace_id = ?")
      .run(TRACE.trace_id);
  });
}

function kindOfTrace(store: Store): unknown {
  return store.database
    .prepare("SELECT kind FROM tracking_trace WHERE trace_id = ?")
    .get(TRACE.trace_id)?.kind;
}

function rollupRowCount(store: Store): number {
  const row = store.database
    .prepare("SELECT COUNT(*) AS count FROM tracking_flow_rollup")
    .get();
  return Number(row?.count);
}

async function backfillEnded(service: TrackingService, store: Store) {
  for (let turn = 0; turn < BACKFILL_WAIT_TURNS; turn++) {
    if (service.analyticsFlow(flowQuery(), caller(store)).rebuild === null)
      return;
    await setImmediate();
  }
  assert.fail("the backfill did not end");
}

test("start runs the backfill and does not wait for it", async (t) => {
  const { store, service } = harness(t);
  insertUnfilledTrace(store, NOW - DAY_MS);
  stopAfter(t, () => service.stop());
  assert.equal(await service.start(), null);
  assert.equal(kindOfTrace(store), null);
  await backfillEnded(service, store);
  assert.equal(kindOfTrace(store), FlowKind.None);
  assert.equal(rollupRowCount(store), TWO_ROWS);
  assert.equal(service.backfillFailures(), NO_ROWS);
});

test("the backfill fills a trace older than the writable period and keeps it", async (t) => {
  const { store, service } = harness(t);
  insertUnfilledTrace(store, NOW - EXPIRED_AGE_DAYS * DAY_MS);
  stopAfter(t, () => service.stop());
  assert.equal(await service.start(), null);
  await backfillEnded(service, store);
  assert.equal(traceCount(store), ONE_ENTRY);
  assert.equal(kindOfTrace(store), FlowKind.None);
});

test("a failed backfill is counted", async (t) => {
  const { store, service } = harness(t);
  store.close();
  stopAfter(t, () => service.stop());
  assert.equal(await service.start(), null);
  for (let turn = 0; turn < BACKFILL_WAIT_TURNS; turn++) {
    if (service.backfillFailures() === ONE_FAILURE) break;
    await setImmediate();
  }
  assert.equal(service.backfillFailures(), ONE_FAILURE);
});

function insertUsageRow(store: Store, grain: FlowGrain, bucketStart: number) {
  store.database
    .prepare(
      "INSERT INTO tracking_usage_rollup VALUES (?, ?, 'project', 'worker', 'model', 1, 1, 1, 1, 1, 0)",
    )
    .run(grain, bucketStart);
}

function usageBuckets(store: Store, grain: FlowGrain): number[] {
  return store.database
    .prepare(
      "SELECT bucket_start FROM tracking_usage_rollup WHERE grain = ? ORDER BY bucket_start",
    )
    .all(grain)
    .map((row) => Number(row.bucket_start));
}

test("no trace and no rollup row goes after 31 days", async (t) => {
  const { store, service } = harness(t);
  store.transaction((tx) =>
    insertTrace(tx, TRACE, NOW - EXPIRED_AGE_DAYS * DAY_MS),
  );
  insertUsageRow(store, FlowGrain.Hour, NOW - 9 * DAY_MS);
  insertUsageRow(store, FlowGrain.Day, NOW - 65 * DAY_MS);
  stopAfter(t, () => service.stop());
  assert.equal(await service.start(), null);
  await backfillEnded(service, store);
  assert.equal(traceCount(store), ONE_ENTRY);
  assert.deepEqual(usageBuckets(store, FlowGrain.Hour), [NOW - 9 * DAY_MS]);
  assert.deepEqual(usageBuckets(store, FlowGrain.Day), [NOW - 65 * DAY_MS]);
});

test("a telemetry write of an expired execution is refused and opens no trace", (t) => {
  const { store, service } = harness(t, () => EXPIRED_NOW);
  const records = [
    {
      record_id: `${SPAN}:start`,
      trace_id: TRACE.trace_id,
      kind: RecordKind.Span,
      span_id: SPAN,
      operation: "agent.tool",
      parent_span_id: TRACE.root_span_id,
      start_time: CREATED,
    },
    {
      record_id: `${SPAN}:input`,
      trace_id: TRACE.trace_id,
      kind: RecordKind.Text,
      text_id: `${SPAN}:input`,
      text: INPUT_TEXT,
    },
  ];
  const answer = service.telemetryWrite(
    TRACE.execution_id,
    records,
    caller(store),
  );
  assert.equal(answer.submitted, records.length);
  assert.equal(answer.stored, NO_STORED);
  assert.equal(answer.refused, records.length);
  assert.ok(
    answer.dispositions.every(
      (entry) =>
        entry.disposition === Disposition.Refused &&
        entry.reason === RefusalReason.TraceExpired,
    ),
  );
  assert.equal(traceCount(store), NO_ROWS);
});

test("a root open of an expired execution is dropped and counted", (t) => {
  const { store, service } = harness(t, () => EXPIRED_NOW);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.equal(service.droppedRecords(), ONE_DROP);
  assert.equal(traceCount(store), NO_ROWS);
});

const SERVER_TRACE: ServerTrace = {
  trace_id: "c".repeat(32),
  root_span_id: "4".repeat(16),
  project_id: TRACE.project_id,
  created_at: NOW - DAY_MS,
  node_id: null,
  attempt: null,
};
const SECOND_SERVER_TRACE: ServerTrace = {
  trace_id: "d".repeat(32),
  root_span_id: "5".repeat(16),
  project_id: TRACE.project_id,
  created_at: NOW - DAY_MS,
  node_id: null,
  attempt: null,
};
const SERVER_ROOT_OPERATION = "project.onboarding";
const ERROR_TYPE = "onboarding.clone_failed";
const TWO_ROWS = 2;

function serverRootStart(trace: ServerTrace) {
  return {
    record_id: `${trace.root_span_id}:start`,
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: SERVER_ROOT_OPERATION,
    start_time: trace.created_at,
  };
}

function serverRootEnd(
  trace: ServerTrace,
  status: SpanStatus,
  attributes?: Record<string, string>,
) {
  return {
    record_id: `${trace.root_span_id}:end`,
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: SERVER_ROOT_OPERATION,
    end_time: ENDED,
    status,
    attributes,
  };
}

function traceRows(store: Store) {
  return store.database
    .prepare(
      "SELECT trace_id, execution_id, node_id, attempt, state, project_id, created_at FROM tracking_trace ORDER BY trace_id",
    )
    .all();
}

test("a server trace stores a row that names no execution and ends ok", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(
    SERVER_TRACE,
    PROJECT_PRODUCER,
    serverRootStart(SERVER_TRACE),
  );
  service.serverTraceSpan(
    SERVER_TRACE,
    PROJECT_PRODUCER,
    serverRootEnd(SERVER_TRACE, SpanStatus.Ok),
  );
  const rows = traceRows(store);
  assert.equal(rows.length, ONE_ENTRY);
  assert.equal(rows[0]?.execution_id, null);
  assert.equal(rows[0]?.node_id, null);
  assert.equal(rows[0]?.attempt, null);
  assert.equal(rows[0]?.project_id, SERVER_TRACE.project_id);
  assert.equal(rows[0]?.created_at, SERVER_TRACE.created_at);
  assert.equal(rows[0]?.state, TraceState.Ok);
  const root = service.spanList(
    SERVER_TRACE.trace_id,
    { limit: SPAN_PAGE },
    caller(store, false),
  ).items[0];
  assert.equal(root?.producer, PROJECT_PRODUCER);
  assert.equal(root?.start_time, SERVER_TRACE.created_at);
  assert.equal(root?.end_time, ENDED);
  assert.equal(
    Object.keys(root?.attributes ?? {}).some((name) =>
      name.startsWith("kanthord."),
    ),
    false,
  );
  assert.equal(service.droppedRecords(), NO_DROP);
});

test("a server trace admits a child of the root span and refuses another parent by assertion", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(
    SERVER_TRACE,
    PROJECT_PRODUCER,
    serverRootStart(SERVER_TRACE),
  );
  service.serverTraceSpan(SERVER_TRACE, PROJECT_PRODUCER, {
    record_id: `${SPAN}:end`,
    span_id: SPAN,
    parent_span_id: SERVER_TRACE.root_span_id,
    operation: "project.onboarding.clone",
    start_time: SERVER_TRACE.created_at,
    end_time: ENDED,
  });
  const spans = service.spanList(
    SERVER_TRACE.trace_id,
    { limit: SPAN_PAGE },
    caller(store, false),
  ).items;
  assert.equal(spans.length, TWO_ROWS);
  assert.equal(
    spans.find((span) => span.span_id === SPAN)?.parent_span_id,
    SERVER_TRACE.root_span_id,
  );
  assert.equal(service.droppedRecords(), NO_DROP);
  assert.throws(() =>
    service.serverTraceSpan(SERVER_TRACE, PROJECT_PRODUCER, {
      record_id: `${SPAN}:other`,
      span_id: SPAN,
      parent_span_id: "3".repeat(16),
      operation: "project.onboarding.clone",
      end_time: ENDED,
    }),
  );
});

test("a server trace older than the writable period is dropped and counted", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(
    { ...SERVER_TRACE, created_at: NOW - EXPIRED_AGE_DAYS * DAY_MS },
    PROJECT_PRODUCER,
    serverRootStart({
      ...SERVER_TRACE,
      created_at: NOW - EXPIRED_AGE_DAYS * DAY_MS,
    }),
  );
  assert.equal(service.droppedRecords(), ONE_DROP);
  assert.equal(traceCount(store), NO_ROWS);
});

test("a server root end with an error status sets the state and lists the error type", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(
    SERVER_TRACE,
    PROJECT_PRODUCER,
    serverRootStart(SERVER_TRACE),
  );
  service.serverTraceSpan(
    SERVER_TRACE,
    PROJECT_PRODUCER,
    serverRootEnd(SERVER_TRACE, SpanStatus.Error, { "error.type": ERROR_TYPE }),
  );
  const summary = service.traceGet(SERVER_TRACE.trace_id, caller(store, false));
  assert.equal(summary.state, TraceState.Error);
  assert.deepEqual(summary.error_types, [ERROR_TYPE]);
  assert.equal(summary.execution_id, null);
  assert.equal(service.droppedRecords(), NO_DROP);
});

const NODE_ATTEMPT = 2;
const NODE_TRACE: ServerTrace = {
  ...SECOND_SERVER_TRACE,
  node_id: TRACE.node_id,
  attempt: NODE_ATTEMPT,
};
const ACT_TEXT = "the human revoked the attempt";
const SECOND_ACT_TEXT = "the human asked for a retry";

test("a server contribution stores its span and its texts in one transaction", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(NODE_TRACE, PROJECT_PRODUCER, {
    ...serverRootStart(NODE_TRACE),
    text_ids: [`${SPAN}:reason`, `${SPAN}:note`],
    texts: [
      { text_id: `${SPAN}:reason`, text: ACT_TEXT },
      { text_id: `${SPAN}:note`, text: SECOND_ACT_TEXT },
    ],
  });
  assert.equal(service.droppedRecords(), NO_DROP);
  const reader = caller(store, false);
  assert.equal(
    service.textGet(NODE_TRACE.trace_id, `${SPAN}:reason`, reader).content,
    ACT_TEXT,
  );
  assert.equal(
    service.textGet(NODE_TRACE.trace_id, `${SPAN}:note`, reader).content,
    SECOND_ACT_TEXT,
  );
  const root = service.spanList(
    NODE_TRACE.trace_id,
    { limit: SPAN_PAGE },
    reader,
  ).items[0];
  assert.deepEqual(root?.text_ids, [`${SPAN}:reason`, `${SPAN}:note`]);
});

test("a refused server contribution raises no error and counts as a drop", (t) => {
  const { store, service } = harness(t);
  service.serverTraceSpan(NODE_TRACE, PROJECT_PRODUCER, {
    ...serverRootStart(NODE_TRACE),
    text_ids: [`${SPAN}:reason`],
    texts: [{ text_id: `${SPAN}:reason`, text: ACT_TEXT }],
  });
  assert.doesNotThrow(() =>
    service.serverTraceSpan(NODE_TRACE, PROJECT_PRODUCER, {
      record_id: `${SPAN}:end`,
      span_id: SPAN,
      parent_span_id: NODE_TRACE.root_span_id,
      operation: "mission.act",
      start_time: ENDED,
      text_ids: [`${SPAN}:reason`],
      texts: [{ text_id: `${SPAN}:reason`, text: SECOND_ACT_TEXT }],
    }),
  );
  assert.equal(service.droppedRecords(), ONE_DROP);
  assert.equal(
    service.spanList(
      NODE_TRACE.trace_id,
      { limit: SPAN_PAGE },
      caller(store, false),
    ).items.length,
    ONE_ENTRY,
  );
});

const HOUR_MS = 3600000;
const DAY_START = Math.floor(NOW / DAY_MS) * DAY_MS;
const RANGE_INVALID = "tracking.filter.range_invalid";
const ANALYTICS_LIMIT = 1000;
const OVER_LIMIT = 1001;
const TRACES_OVER_STEP = 300;
const ABORT_CALLS = 2;
const TURN_OPERATION = "agent.turn";
const TOOL_OPERATION = "agent.tool";
const MODEL_ATTRIBUTE = "gen_ai.response.model";
const COST_ATTRIBUTE = "kanthord.usage.cost_usd";
const AGENT_ATTRIBUTE = "kanthord.agent.name";

interface AnalyticsSpanSeed {
  trace?: number;
  operation?: string;
  start: number;
  end?: number | null;
  attributes?: Record<string, string | number>;
}

function analyticsTraceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function analyticsSpanId(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function seedAnalytics(
  store: Store,
  spans: readonly AnalyticsSpanSeed[],
  traces = 1,
): void {
  store.transaction((tx) => {
    for (let n = 1; n <= traces; n += 1)
      tx.database
        .prepare(
          "INSERT INTO tracking_trace (trace_id, root_span_id, created_at, started_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          analyticsTraceId(n),
          analyticsSpanId(n),
          NOW - 20 * DAY_MS,
          NOW - 20 * DAY_MS,
        );
    spans.forEach((span, index) =>
      insertSpan(tx, {
        trace_id: analyticsTraceId(span.trace ?? 1),
        span_id: analyticsSpanId(1000 + index),
        parent_span_id: null,
        producer: "worker",
        origin: SpanOrigin.Observed,
        operation: span.operation ?? TURN_OPERATION,
        start_time: span.start,
        end_time: span.end ?? null,
        status: SpanStatus.Unset,
        attributes: span.attributes ?? {},
        events: [],
        links: [],
        text_ids: [],
        created_at: span.start,
      }),
    );
  });
}

function costQuery(query: object = {}) {
  return trackingOperations.analyticsCost.input.shape.query.parse(query);
}

function durationQuery(query: object = {}) {
  return trackingOperations.analyticsDuration.input.shape.query.parse({
    measure: AnalyticsMeasure.SpanDuration,
    ...query,
  });
}

function rangeInvalid(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    error.status === HttpStatus.BadRequest &&
    error.code === RANGE_INVALID
  );
}

function turn(model: string, start: number, cost: number): AnalyticsSpanSeed {
  return {
    start,
    attributes: { [MODEL_ATTRIBUTE]: model, [COST_ATTRIBUTE]: cost },
  };
}

test("a cost read without a query answers the agent turns of the last 7 days by model and day", async (t) => {
  const { store, service } = harness(t);
  seedAnalytics(store, [
    turn("model_a", DAY_START - 2 * DAY_MS + HOUR_MS, 1),
    turn("model_a", DAY_START - 2 * DAY_MS + 2 * HOUR_MS, 2),
    turn("model_b", DAY_START - DAY_MS + HOUR_MS, 4),
    turn("model_a", NOW - 8 * DAY_MS, 8),
    { ...turn("model_a", NOW - DAY_MS, 16), operation: TOOL_OPERATION },
  ]);
  const read = await service.analyticsCost(costQuery(), caller(store));
  assert.equal(read.truncated, false);
  assert.deepEqual(
    read.items.map((item) => [
      item.key,
      item.bucket_start,
      item.turn_count,
      item.cost_usd,
    ]),
    [
      ["model_a", DAY_START - 2 * DAY_MS, 2, 3],
      ["model_b", DAY_START - DAY_MS, 1, 4],
    ],
  );
});

test("a cost range of more than 31 days or with from after to is refused", async (t) => {
  const { store, service } = harness(t);
  const refused = [
    { from: NOW - 32 * DAY_MS, to: NOW },
    { from: NOW - 32 * DAY_MS },
    { from: NOW - DAY_MS, to: NOW - 2 * DAY_MS },
    { from: NOW + 1 },
  ];
  for (const query of refused)
    await assert.rejects(
      service.analyticsCost(costQuery(query), caller(store)),
      rangeInvalid,
    );
  const exact = await service.analyticsCost(
    costQuery({ from: NOW - 31 * DAY_MS }),
    caller(store),
  );
  assert.deepEqual(exact, { items: [], truncated: false });
});

test("a duration range of more than 31 days or with from after to is refused", async (t) => {
  const { store, service } = harness(t);
  for (const query of [
    { from: NOW - 32 * DAY_MS },
    { from: NOW - DAY_MS, to: NOW - 2 * DAY_MS },
  ])
    await assert.rejects(
      service.analyticsDuration(durationQuery(query), caller(store)),
      rangeInvalid,
    );
});

test("a read with only to takes from 7 days before it", async (t) => {
  const { store, service } = harness(t);
  const to = NOW - 10 * DAY_MS;
  seedAnalytics(store, [
    { ...turn("model_a", to - 6 * DAY_MS, 1), end: to - 6 * DAY_MS + 5 },
    { ...turn("model_a", to - 8 * DAY_MS, 2), end: to - 8 * DAY_MS + 5 },
  ]);
  const cost = await service.analyticsCost(costQuery({ to }), caller(store));
  assert.deepEqual(
    cost.items.map((item) => item.turn_count),
    [1],
  );
  const duration = await service.analyticsDuration(
    durationQuery({ to, operation: TURN_OPERATION }),
    caller(store),
  );
  assert.deepEqual(
    duration.items.map((item) => item.count),
    [1],
  );
});

test("a cost read answers truncated and at most 1000 items", async (t) => {
  const { store, service } = harness(t);
  seedAnalytics(
    store,
    Array.from({ length: OVER_LIMIT }, (_, index) => ({
      start: NOW - HOUR_MS,
      attributes: { [AGENT_ATTRIBUTE]: `agent_${index}` },
    })),
  );
  const read = await service.analyticsCost(
    costQuery({
      group_by: CostGroupBy.AgentName,
      bucket: AnalyticsBucket.None,
    }),
    caller(store),
  );
  assert.equal(read.items.length, ANALYTICS_LIMIT);
  assert.equal(read.truncated, true);
});

test("an analytics read never commits and yields to the event loop between steps", async (t) => {
  const { store, service } = harness(t);
  seedAnalytics(store, [turn("model_a", NOW - HOUR_MS, 1)], TRACES_OVER_STEP);
  const reader: CallerContext = {
    ...caller(store),
    commit: () => assert.fail("an analytics read must not commit"),
  };
  const reads = [
    (): Promise<unknown> => service.analyticsCost(costQuery(), reader),
    (): Promise<unknown> => service.analyticsDuration(durationQuery(), reader),
  ];
  for (const read of reads) {
    const order: string[] = [];
    void setImmediate().then(() => order.push("callback"));
    await read();
    order.push("answer");
    assert.deepEqual(order, ["callback", "answer"]);
  }
});

test("an analytics read stops at the step after its signal aborts", async (t) => {
  const { store, service } = harness(t);
  seedAnalytics(store, [turn("model_a", NOW - HOUR_MS, 1)], TRACES_OVER_STEP);
  const transaction = t.mock.method(store, "transaction");
  const context = new CancellationContext();
  const reader: CallerContext = { ...caller(store), context };
  void setImmediate().then(() => context.cancel());
  await assert.rejects(
    service.analyticsCost(costQuery(), reader),
    (error: unknown) => error === context.signal.reason,
  );
  assert.equal(transaction.mock.callCount(), ABORT_CALLS);
});

function flowQuery(query: object = {}) {
  return trackingOperations.analyticsFlow.input.shape.query.parse(query);
}

function seedFlowRow(
  store: Store,
  bucketStart: number,
  executions: number,
): void {
  const values = {
    grain: FlowGrain.Day,
    bucket_start: bucketStart,
    project_id: "project_a",
    worker_name: "worker_a",
    stage: FlowStage.Outcome,
    exit: FlowExit.Completed,
    stop_reason: "",
    cause_category: "",
    cause_detail: "",
    cause_assigner: "",
    ...Object.fromEntries(FLOW_VECTOR_COLUMNS.map((column) => [column, 0])),
    executions,
    changed_after_end: 0,
  };
  const columns = Object.keys(values);
  store.transaction((tx) =>
    tx.database
      .prepare(
        `INSERT INTO tracking_flow_rollup (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(values)),
  );
}

test("declare refuses a flow operation with another access", (t) => {
  const { service } = harness(t);
  t.mock.property(
    trackingOperations.analyticsFlow as { access: AccessPolicy },
    "access",
    AccessPolicy.Client,
  );
  assert.throws(() => service.declare(new OperationRegistry()), Error);
});

test("a flow read answers the schema for a store with rows", (t) => {
  const { store, service } = harness(t);
  seedFlowRow(store, DAY_START - 2 * DAY_MS, 2);
  seedFlowRow(store, DAY_START - 9 * DAY_MS, 3);
  seedFlowRow(store, DAY_START - 15 * DAY_MS, 1);
  const read = service.analyticsFlow(flowQuery(), caller(store));
  assert.deepEqual(trackingOperations.analyticsFlow.output.parse(read), read);
  assert.equal(read.window.bucket, FlowGrain.Day);
  assert.equal(read.window.now, NOW);
  assert.equal(read.window.from, DAY_START - 7 * DAY_MS);
  assert.deepEqual(read.previous_window, {
    from: DAY_START - 15 * DAY_MS,
    to: DAY_START - 7 * DAY_MS,
  });
  assert.equal(read.cost.current.success, CURRENT_FLOW_SUCCESS);
  assert.equal(read.cost.previous?.success, PREVIOUS_FLOW_SUCCESS);
  assert.equal(read.rebuild, null);
});

test("a flow range above 31 days, a from after to and the hour bucket above 2 days are refused", (t) => {
  const { store, service } = harness(t);
  const refused = [
    { from: NOW - 31 * DAY_MS - 1 },
    { from: NOW - 31 * DAY_MS - 1, to: NOW },
    { from: NOW - DAY_MS, to: NOW - 2 * DAY_MS },
    { from: NOW + 1 },
    { bucket: FlowGrain.Hour },
    { bucket: FlowGrain.Hour, from: NOW - 2 * DAY_MS - 1 },
  ];
  for (const query of refused)
    assert.throws(
      () => service.analyticsFlow(flowQuery(query), caller(store)),
      rangeInvalid,
    );
  for (const query of [
    { from: NOW - 31 * DAY_MS },
    { bucket: FlowGrain.Hour, from: NOW - 2 * DAY_MS },
  ])
    assert.doesNotThrow(() =>
      service.analyticsFlow(flowQuery(query), caller(store)),
    );
});

test("the cause label operation answers the cause with the assigner human and writes the username", (t) => {
  const { store, service } = harness(t, () => ENDED);
  service.executionOpened(TRACE, CREATED, OPENING);
  service.executionEnded({
    trace: TRACE,
    ended_at: ENDED,
    end: ExecutionEnd.Finished,
    revoke_cause: null,
    stop: { reason: "provider_failed", code: RATE_LIMITED },
    cause: unattributed([CauseCategory.Prompt, CauseCategory.Model]),
  });
  const body = {
    category: CauseCategory.Prompt,
    subcategory: CauseSubcategory.ContextMissing,
    reason: "The prompt lacked the build command.",
  };
  const answer = service.causeLabel(TRACE.trace_id, body, caller(store));
  assert.deepEqual(answer, {
    trace_id: TRACE.trace_id,
    span_id: `${TRACE.root_span_id}.cause_label`,
    cause: {
      category: CauseCategory.Prompt,
      subcategory: CauseSubcategory.ContextMissing,
      assigner: CauseAssigner.Human,
    },
    reason: body.reason,
    created_at: ENDED,
  });
  assert.doesNotThrow(() => trackingOperations.causeLabel.output.parse(answer));
  for (const grain of Object.values(FlowGrain)) {
    const rows = store.database
      .prepare(
        "SELECT cause_category, cause_detail, cause_assigner, executions FROM tracking_flow_rollup WHERE grain = ?",
      )
      .all(grain);
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          cause_category: CauseCategory.Prompt,
          cause_detail: CauseSubcategory.ContextMissing,
          cause_assigner: CauseAssigner.Human,
          executions: 1,
        },
      ],
    );
  }
  const label = service
    .spanList(TRACE.trace_id, { limit: SPAN_PAGE }, caller(store))
    .items.find((span) => span.span_id === answer.span_id);
  assert.equal(label?.attributes[HUMAN_USERNAME_ATTRIBUTE], HUMAN_ACCOUNT);
  assert.equal(
    service.textGet(
      TRACE.trace_id,
      `${TRACE.root_span_id}.cause_label:reason`,
      caller(store),
    ).content,
    body.reason,
  );
});

test("the cause label operation refuses a trace that is still open", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED, OPENING);
  assert.throws(
    () =>
      service.causeLabel(
        TRACE.trace_id,
        {
          category: CauseCategory.Prompt,
          subcategory: CauseSubcategory.ContextMissing,
          reason: "why",
        },
        caller(store),
      ),
    (error) =>
      error instanceof OperationError &&
      error.code === CauseLabelCode.TraceOpen,
  );
});

function traceDelete(
  t: TestContext,
  identity: CallerContext["identity"],
  body: {
    trace_ids: string[];
    requested_by?: { kind: "human"; account: string; name: string };
  },
) {
  const { store, service } = harness(t);
  const registry = new OperationRegistry();
  service.declare(registry);
  const handler = registry.get(trackingOperations.traceDelete.id).handler;
  const call = () =>
    handler(
      { params: {}, query: {}, body },
      {
        identity,
        context: background,
        requestId: "request",
        commit: (write) => store.transaction(write),
      },
    );
  return { store, call };
}

const DELETE_ACTOR = {
  kind: "human" as const,
  account: "ulrich",
  name: "Ulrich",
};
const ENDED_TRACE = "c".repeat(32);
const OPEN_TRACE = "d".repeat(32);

function seedDeleteTraces(store: Store): void {
  store.transaction((tx) => {
    const insert = tx.database.prepare(
      "INSERT INTO tracking_trace (trace_id, root_span_id, created_at, state) VALUES (?, ?, ?, ?)",
    );
    insert.run(ENDED_TRACE, "1".repeat(16), NOW - 86400000, "ok");
    insert.run(OPEN_TRACE, "2".repeat(16), NOW, "open");
    tx.database
      .prepare(
        "INSERT INTO tracking_session_entry (trace_id, session_id, entry_id, sequence, entry_type, entry_time, truncated, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        ENDED_TRACE,
        "3".repeat(16),
        "entry-1",
        1,
        "message",
        NOW,
        0,
        "{}",
        NOW,
      );
  });
}

test("tracking.trace.delete keeps an open trace as live, deletes an ended trace and cascades its session entries", async (t) => {
  const { store, call } = traceDelete(t, testServiceIdentity("footprint"), {
    trace_ids: [ENDED_TRACE, OPEN_TRACE, "e".repeat(32)],
    requested_by: DELETE_ACTOR,
  });
  seedDeleteTraces(store);
  assert.deepEqual(await call(), {
    removed: 1,
    absent: 1,
    refused: [{ key: OPEN_TRACE, reason: "live" }],
  });
  const entries = store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT COUNT(*) AS count FROM tracking_session_entry")
        .get() as { count: number },
  );
  assert.equal(entries.count, NO_ROWS);
});

test("tracking.trace.delete answers 400 for requested_by from a human caller", async (t) => {
  const { call } = traceDelete(
    t,
    testHumanIdentity("ulrich", "Ulrich", "jti"),
    { trace_ids: [ENDED_TRACE], requested_by: DELETE_ACTOR },
  );
  await assert.rejects(
    async () => call(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      JSON.stringify(error.details).includes("requested_by"),
  );
});
