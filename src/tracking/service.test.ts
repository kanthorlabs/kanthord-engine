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
  RecordKind,
  ROOT_SPAN_OPERATION,
  SCHEDULER_PRODUCER,
  SpanStatus,
  TextState,
  TRACKING_SERVICE_NAME,
  type ExecutionTrace,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { TrackingService } from "./service.ts";

const TRACE: ExecutionTrace = {
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
};
const SPAN = "2".repeat(16);
const RUNTIME = "worker_instance_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const CREATED = 1000;
const ENDED = 5000;
const NO_DROP = 0;
const ONE_DROP = 1;
const PAGE_OF_ONE = 1;
const RATE_LIMITED = "rate_limited";
const INPUT_TEXT = "npm test";
const TRACE_NOT_FOUND = "tracking.trace.not_found";
const TEXT_NOT_FOUND = "tracking.text.not_found";

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const service = new TrackingService({
    store,
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
  assert.equal(text.state, TextState.Present);
  assert.equal(text.content, INPUT_TEXT);
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
