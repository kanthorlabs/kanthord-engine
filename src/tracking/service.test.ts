import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Disposition,
  ExecutionEnd,
  MISSION_PRODUCER,
  PROJECT_PRODUCER,
  RecordKind,
  RefusalReason,
  RevokeCause,
  ROOT_SPAN_OPERATION,
  SCHEDULER_PRODUCER,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
  TraceSort,
  TraceState,
  traceSummarySchema,
  type ExecutionTrace,
  type ServerTrace,
  type SessionEntryRecord,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { TrackingService } from "./service.ts";
import { insertTrace } from "./trace-store.ts";

const TRACE: ExecutionTrace = {
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
};
const SPAN = "2".repeat(16);
const RUNTIME = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const CREATED = 1000;
const NOW = 1751566593132;
const RETENTION_DAYS = 30;
const EXPIRED_AGE_DAYS = 31;
const DAY_MS = 86400000;
const NO_STORED = 0;
const ENDED = 5000;
const NO_DROP = 0;
const NO_ROWS = 0;
const ONE_ENTRY = 1;
const ONE_DROP = 1;
const PAGE_OF_ONE = 1;
const STOP_DETAIL = "Cannot find module";
const SPAN_PAGE = 10;
const SUMMARY_FIELDS = 27;
const RATE_LIMITED = "rate_limited";
const INPUT_TEXT = "npm test";
const TRACE_NOT_FOUND = "tracking.trace.not_found";
const TEXT_NOT_FOUND = "tracking.text.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const OTHER_EXECUTION = "execution_01JZ8R2B3C4D5E6F7G8H9J0K1N";
const OTHER_TRACE = "b".repeat(32);

function harness(t: TestContext, now: () => number = () => NOW) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const service = new TrackingService({
    store,
    retentionDays: RETENTION_DAYS,
    now,
    executions: {
      traceOf: (executionId) =>
        executionId === TRACE.execution_id ? TRACE : undefined,
    },
  });
  return { store, service };
}

function caller(store: Store, execution = true): CallerContext {
  return {
    identity: {
      kind: IdentityKind.Human,
      accountId: "account_01JZ8R2B3C4D5E6F7G8H9J0K1M",
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

test("the root span opens at the claim and ends at the release", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED);
  service.executionEnded({
    trace: TRACE,
    ended_at: ENDED,
    end: ExecutionEnd.Finished,
    revoke_cause: null,
    stop: { reason: "provider_failed", code: RATE_LIMITED },
  });
  const page = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  );
  const root = page.items[0];
  assert.equal(root?.operation, ROOT_SPAN_OPERATION);
  assert.equal(root?.producer, SCHEDULER_PRODUCER);
  assert.equal(root?.start_time, CREATED);
  assert.equal(root?.end_time, ENDED);
  assert.equal(root?.status, SpanStatus.Error);
  assert.equal(root?.attributes["kanthord.stop.code"], RATE_LIMITED);
  assert.equal(service.droppedRecords(), NO_DROP);
});

for (const [cause, status, state] of [
  [RevokeCause.Human, SpanStatus.Error, TraceState.Error],
  [RevokeCause.Assessment, SpanStatus.Ok, TraceState.Ok],
] as const) {
  test(`a revocation by ${cause} stores the cause and ends the trace as ${state}`, (t) => {
    const { store, service } = harness(t);
    service.executionOpened(TRACE, CREATED);
    service.executionEnded({
      trace: TRACE,
      ended_at: ENDED,
      end: ExecutionEnd.Revoked,
      revoke_cause: cause,
      stop: null,
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
  service.executionOpened(TRACE, CREATED);
  assert.throws(() =>
    service.executionEnded({
      trace: TRACE,
      ended_at: ENDED,
      end: ExecutionEnd.Revoked,
      revoke_cause: "other" as RevokeCause,
      stop: null,
    }),
  );
  const root = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  ).items[0];
  assert.equal(root?.end_time, null);
});

test("the root span end carries the stop detail", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED);
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
  service.executionOpened(TRACE, CREATED);
  service.executionOpened(TRACE, ENDED);
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

test("the trace summary answers exactly the 27 fields with the node and the attempt of the execution", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED);
  const trace = service.traceGet(TRACE.trace_id, caller(store));
  assert.deepEqual(
    Object.keys(trace).sort(),
    Object.keys(traceSummarySchema.shape).sort(),
  );
  assert.equal(Object.keys(trace).length, SUMMARY_FIELDS);
  assert.equal(trace.node_id, TRACE.node_id);
  assert.equal(trace.attempt, TRACE.attempt);
  assert.equal(trace.started_at, CREATED);
  assert.equal(trace.span_count, ONE_ENTRY);
  assert.doesNotThrow(() => traceSummarySchema.parse(trace));
});

test("a failed root write is counted and never thrown", (t) => {
  const { store, service } = harness(t);
  store.close();
  assert.doesNotThrow(() => service.executionOpened(TRACE, CREATED));
  assert.equal(service.droppedRecords(), ONE_DROP);
});

test("the claimant writes spans and texts of its execution", (t) => {
  const { store, service } = harness(t);
  const answer = service.telemetryWrite(
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
    ],
    caller(store),
  );
  assert.deepEqual(
    answer.dispositions.map((entry) => entry.disposition),
    [Disposition.Stored, Disposition.Stored],
  );
  const span = service.spanList(
    TRACE.trace_id,
    { limit: PAGE_OF_ONE },
    caller(store),
  ).items[0];
  assert.equal(span?.producer, RUNTIME);
  const text = service.textGet(TRACE.trace_id, `${SPAN}:input`, caller(store));
  assert.equal(text.content, INPUT_TEXT);
  assert.equal("state" in text, false);
});

test("textGet answers exactly the trace, the text id, the content and the creation time", (t) => {
  const { store, service } = harness(t);
  service.telemetryWrite(
    TRACE.execution_id,
    [
      {
        record_id: `${SPAN}:input`,
        trace_id: TRACE.trace_id,
        kind: RecordKind.Text,
        text_id: `${SPAN}:input`,
        text: INPUT_TEXT,
      },
    ],
    caller(store),
  );
  const text = service.textGet(TRACE.trace_id, `${SPAN}:input`, caller(store));
  assert.deepEqual(Object.keys(text).sort(), [
    "content",
    "created_at",
    "text_id",
    "trace_id",
  ]);
  assert.equal(text.trace_id, TRACE.trace_id);
  assert.equal(text.text_id, `${SPAN}:input`);
  assert.equal(text.content, INPUT_TEXT);
  assert.ok(Number.isSafeInteger(text.created_at));
});

test("a trace delete removes its spans, records, texts and session entries", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED);
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
  service.executionOpened(TRACE, CREATED);
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
  service.executionOpened(TRACE, CREATED);
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
  service.executionOpened(TRACE, CREATED);
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
  service.executionOpened(TRACE, CREATED);
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

test("the facet read answers the four arrays", (t) => {
  const { store, service } = harness(t);
  service.executionOpened(TRACE, CREATED);
  assert.deepEqual(service.facetGet({}, caller(store)), {
    worker_names: [],
    agent_names: [],
    models: [],
    error_types: [],
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

function entryHarness(t: TestContext) {
  const { store, service } = harness(t);
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

test("a tool call identity filters the session entry list", (t) => {
  const { store, service } = entryHarness(t);
  const page = service.sessionEntryList(
    { trace_id: TRACE.trace_id, session_id: SPAN },
    { limit: ENTRY_PAGE, tool_call_id: TOOL_CALL },
    caller(store),
  );
  assert.deepEqual(
    page.items.map((item) => item.entry_id),
    [`e${TOOL_RESULT_SEQUENCE}`],
  );
  assert.equal(page.next_cursor, null);
});

test("a session that the trace does not hold answers an empty page", (t) => {
  const { store, service } = entryHarness(t);
  const page = service.sessionEntryList(
    { trace_id: TRACE.trace_id, session_id: "4".repeat(16) },
    { limit: ENTRY_PAGE },
    caller(store),
  );
  assert.deepEqual(page, { items: [], next_cursor: null });
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

test("start sweeps an expired trace", async (t) => {
  const { store, service } = harness(t);
  store.transaction((tx) =>
    insertTrace(tx, TRACE, NOW - EXPIRED_AGE_DAYS * DAY_MS),
  );
  assert.equal(traceCount(store), ONE_ENTRY);
  t.after(() => service.stop());
  assert.equal(await service.start(), null);
  assert.equal(traceCount(store), NO_ROWS);
  assert.equal(service.sweepFailures(), NO_ROWS);
});

test("a failed sweep is counted and answers zero", (t) => {
  const { store, service } = harness(t);
  store.close();
  assert.equal(service.sweep(), NO_ROWS);
  assert.equal(service.sweepFailures(), ONE_DROP);
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
  service.executionOpened(TRACE, CREATED);
  assert.equal(service.droppedRecords(), ONE_DROP);
  assert.equal(traceCount(store), NO_ROWS);
});

const SERVER_TRACE: ServerTrace = {
  trace_id: "c".repeat(32),
  root_span_id: "4".repeat(16),
  project_id: TRACE.project_id,
  created_at: NOW - DAY_MS,
};
const SECOND_SERVER_TRACE: ServerTrace = {
  trace_id: "d".repeat(32),
  root_span_id: "5".repeat(16),
  project_id: TRACE.project_id,
  created_at: NOW - DAY_MS,
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

test("a server trace older than the retention is dropped and counted", (t) => {
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

test("two server traces of one project keep their rows", (t) => {
  const { store, service } = harness(t);
  for (const trace of [SERVER_TRACE, SECOND_SERVER_TRACE])
    service.serverTraceSpan(trace, PROJECT_PRODUCER, serverRootStart(trace));
  assert.equal(traceRows(store).length, TWO_ROWS);
  assert.equal(service.droppedRecords(), NO_DROP);
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
