import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { isNumber } from "../kernel/values.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  type Attributes,
  RecordKind,
  ROOT_SPAN_OPERATION,
  SpanOrigin,
  type TelemetryRecord,
  TRACKING_SERVICE_NAME,
  TRANSITION_SPAN_OPERATION,
} from "./contract.ts";
import { admitRecords } from "./admission.ts";
import { BACKFILL_FILL_TRACES, runFlowBackfill } from "./flow-backfill.ts";
import { openFlow } from "./flow-admission.ts";
import { decodeBins } from "./flow-bins.ts";
import { FLOW_COLUMNS } from "./flow-trace.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, type TraceRow } from "./trace-store.ts";

const HOUR_MS = 3600000;
const ANCHOR = Date.UTC(2026, 9, 31, 10, 30);
const NOW = ANCHOR + 2000;
const JOB_START = ANCHOR + 3 * HOUR_MS;
const HOSTED = "hosted_worker";
const MODEL = "model-a";
const TOLERANCE = 1e-9;
const NO_ROWS = 0;
const ONE_EXECUTION = 1;
const UNSTARTED_TRACE_ROWS = 2;
const STOPPED_PROGRESS_VALUES = 3;
const STEPS_KIND = "steps";
const OMITTED_COLUMN = "changed_after_end";
const TRACE_COUNT_OVER_ONE_CHUNK = BACKFILL_FILL_TRACES + 5;
const FLOW_TABLES = [
  "tracking_flow_rollup ORDER BY grain, bucket_start, project_id, worker_name, stage, exit, stop_reason, cause_category, cause_detail, cause_assigner",
  "tracking_flow_histogram ORDER BY grain, bucket_start, project_id, worker_name, measure",
  "tracking_usage_rollup ORDER BY grain, bucket_start, project_id, worker_name, model",
];
const NULL_COLUMNS: ReadonlySet<string> = new Set([
  "kind",
  "stage",
  "root_end",
  "revoke_cause",
  "transition_to",
  "transition_rule",
  "evaluation_stage",
  "gate_affected",
]);
const TEXT_COLUMNS: ReadonlySet<string> = new Set([
  "cause_category",
  "cause_detail",
  "cause_assigner",
]);

type Row = Record<string, unknown>;

function isHosted(workerName: string): boolean {
  return workerName === HOSTED;
}

function traceOf(sequence: number, anchor = ANCHOR): TraceRow {
  return {
    trace_id: sequence.toString(16).padStart(32, "0"),
    root_span_id: sequence.toString(16).padStart(16, "1"),
    execution_id: `execution_${ulid(anchor)}`,
    project_id: "project_a",
    node_id: null,
    attempt: null,
  };
}

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function record(
  trace: TraceRow,
  key: string,
  spanId: string,
  operation: string,
  fields: Record<string, unknown>,
): TelemetryRecord {
  return {
    record_id: `${trace.trace_id}:${key}`,
    trace_id: trace.trace_id,
    kind: RecordKind.Span,
    span_id: spanId,
    operation,
    parent_span_id: spanId === trace.root_span_id ? null : trace.root_span_id,
    ...fields,
  } as TelemetryRecord;
}

function rootStart(trace: TraceRow, kind: string): TelemetryRecord {
  return record(trace, "start", trace.root_span_id, ROOT_SPAN_OPERATION, {
    start_time: ANCHOR,
    attributes: {
      "kanthord.execution.kind": kind,
      "kanthord.worker.name": HOSTED,
      "kanthord.queue.wait_ms": 250,
    },
  });
}

function rootEnd(trace: TraceRow, attributes: Attributes = {}) {
  return record(trace, "end", trace.root_span_id, ROOT_SPAN_OPERATION, {
    end_time: ANCHOR + 1000,
    attributes: { "kanthord.execution.end": "finished", ...attributes },
  });
}

function transition(trace: TraceRow, to: string): TelemetryRecord {
  return record(
    trace,
    "transition",
    "3".repeat(16),
    TRANSITION_SPAN_OPERATION,
    {
      start_time: ANCHOR + 900,
      end_time: ANCHOR + 900,
      attributes: {
        "kanthord.node.state.to": to,
        "kanthord.transition.rule": "none",
      },
    },
  );
}

function turn(trace: TraceRow, index: number): TelemetryRecord {
  return record(
    trace,
    `turn:${index}`,
    `4${index}`.padStart(16, "4"),
    "agent.turn",
    {
      start_time: ANCHOR + 100,
      end_time: ANCHOR + 200,
      attributes: {
        "gen_ai.response.model": MODEL,
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 10,
        "kanthord.usage.cost_usd": 0.1 * index,
      },
    },
  );
}

function toolError(trace: TraceRow, key: string): TelemetryRecord {
  return record(trace, key, key.padEnd(16, "5"), "agent.tool", {
    start_time: ANCHOR + 300,
    end_time: ANCHOR + 400,
    attributes: { "error.type": "tool_error" },
  });
}

function releaseGate(trace: TraceRow): TelemetryRecord {
  return record(trace, "gate", "6".repeat(16), "worker.release_gate", {
    start_time: ANCHOR + 500,
    end_time: ANCHOR + 800,
    attributes: { "kanthord.release_gate.result": "passed" },
  });
}

function write(
  store: Store,
  trace: TraceRow,
  records: readonly TelemetryRecord[],
  now = NOW,
): void {
  store.transaction((tx) => {
    const inserted = insertTrace(tx, trace, now);
    const flow = openFlow(tx, trace.trace_id, inserted, isHosted);
    admitRecords(
      tx,
      {
        trace,
        producer: "producer",
        origin: SpanOrigin.Observed,
        now,
        flow,
      },
      records,
    );
  });
}

function admitMixedTraces(store: Store): TraceRow[] {
  const stopped = traceOf(1, ANCHOR);
  const evaluated = traceOf(2, ANCHOR - 2 * HOUR_MS);
  const handedOn = traceOf(3, ANCHOR - 30 * HOUR_MS);
  const unstarted = traceOf(4, ANCHOR - 50 * HOUR_MS);
  write(store, stopped, [
    rootStart(stopped, "steps"),
    turn(stopped, 1),
    turn(stopped, 2),
    toolError(stopped, "7"),
  ]);
  write(store, stopped, [
    rootEnd(stopped, {
      "kanthord.stop.reason": "no_progress",
      "kanthord.cause.category": "model",
      "kanthord.cause.subcategory": "no_progress",
      "kanthord.cause.assigner": "rule",
    }),
  ]);
  write(store, stopped, [toolError(stopped, "8")], ANCHOR + 2 * HOUR_MS);
  write(store, evaluated, [
    rootStart(evaluated, "evaluation"),
    transition(evaluated, "Completed"),
    rootEnd(evaluated),
  ]);
  write(store, handedOn, [
    rootStart(handedOn, "steps"),
    turn(handedOn, 1),
    releaseGate(handedOn),
    transition(handedOn, "Waiting"),
    rootEnd(handedOn),
  ]);
  write(store, unstarted, [turn(unstarted, 1)]);
  return [stopped, evaluated, handedOn, unstarted];
}

function traceColumns(store: Store): Row[] {
  return store.database
    .prepare(
      `SELECT trace_id, ${FLOW_COLUMNS.join(", ")} FROM tracking_trace ORDER BY trace_id`,
    )
    .all()
    .map((row) => ({ ...row }));
}

function flowTables(store: Store): Row[][] {
  return FLOW_TABLES.map((table) =>
    store.database
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => {
        return Object.fromEntries(
          Object.entries(row)
            .filter(([name]) => name !== OMITTED_COLUMN)
            .map(([name, value]) => [
              name,
              value instanceof Uint8Array ? decodeBins(value) : value,
            ]),
        );
      }),
  );
}

function assertRowsMatch(actual: Row[], expected: Row[]): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((row, index) => {
    const other = expected[index];
    assert.ok(other);
    assert.deepEqual(Object.keys(row), Object.keys(other));
    for (const [name, value] of Object.entries(row)) {
      const wanted: unknown = other[name];
      if (isNumber(value) && isNumber(wanted))
        assert.ok(Math.abs(value - wanted) <= TOLERANCE, name);
      else assert.deepEqual(value, wanted, name);
    }
  });
}

function resetFlow(store: Store): void {
  const assignments = FLOW_COLUMNS.map((column) => {
    if (NULL_COLUMNS.has(column)) return `${column} = NULL`;
    return TEXT_COLUMNS.has(column) ? `${column} = ''` : `${column} = 0`;
  });
  store.database.exec(
    `DELETE FROM tracking_flow_rollup; DELETE FROM tracking_flow_histogram; DELETE FROM tracking_usage_rollup; UPDATE tracking_trace SET ${assignments.join(", ")}`,
  );
}

function runBackfill(
  store: Store,
  signal: AbortSignal = new AbortController().signal,
  progress: (pendingUntil: number | null) => void = () => undefined,
) {
  return runFlowBackfill(
    store,
    { isHostedWorker: isHosted, now: () => JOB_START },
    signal,
    progress,
  );
}

test("the backfill gives the flow columns, rollups, histograms and usage that the admission gave", async (t) => {
  const store = memoryStore(t);
  admitMixedTraces(store);
  const columns = traceColumns(store);
  const tables = flowTables(store);
  assert.ok(tables.every((rows) => rows.length > NO_ROWS));
  resetFlow(store);
  assert.notDeepEqual(traceColumns(store), columns);
  await runBackfill(store);
  assertRowsMatch(traceColumns(store), columns);
  flowTables(store).forEach((rows, index) =>
    assertRowsMatch(rows, tables[index] ?? []),
  );
  const stages = store.database
    .prepare(
      "SELECT stage, executions FROM tracking_flow_rollup WHERE stage = ''",
    )
    .all();
  assert.equal(stages.length, UNSTARTED_TRACE_ROWS);
  assert.ok(stages.every((row) => Number(row.executions) === ONE_EXECUTION));
  const kinds = store.database
    .prepare("SELECT kind FROM tracking_trace WHERE kind IS NULL")
    .all();
  assert.equal(kinds.length, NO_ROWS);
});

test("a trace with a kind that is not NULL is not handled again", async (t) => {
  const store = memoryStore(t);
  admitMixedTraces(store);
  const columns = traceColumns(store);
  const tables = flowTables(store);
  await runBackfill(store);
  await runBackfill(store);
  assert.deepEqual(traceColumns(store), columns);
  assert.deepEqual(flowTables(store), tables);
});

test("pending_until holds the job start, then the anchor of the oldest handled trace, then null", async (t) => {
  const store = memoryStore(t);
  admitMixedTraces(store);
  resetFlow(store);
  const values: (number | null)[] = [];
  await runBackfill(store, undefined, (value) => values.push(value));
  assert.deepEqual(values, [JOB_START, ANCHOR - 50 * HOUR_MS, null]);
});

test("a start that finds no trace to handle reports the job start and then null", async (t) => {
  const store = memoryStore(t);
  const values: (number | null)[] = [];
  await runBackfill(store, undefined, (value) => values.push(value));
  assert.deepEqual(values, [JOB_START, null]);
});

function admitSimpleTraces(store: Store): TraceRow[] {
  const traces = Array.from(
    { length: TRACE_COUNT_OVER_ONE_CHUNK },
    (_, index) => traceOf(index + 1, ANCHOR + index * 1000),
  );
  for (const trace of traces) write(store, trace, [rootStart(trace, "steps")]);
  return traces;
}

function kindOf(store: Store, trace: TraceRow): unknown {
  return store.database
    .prepare("SELECT kind FROM tracking_trace WHERE trace_id = ?")
    .get(trace.trace_id)?.kind;
}

test("the fill handles the newest anchors first, 20 traces in each transaction", async (t) => {
  const store = memoryStore(t);
  const traces = admitSimpleTraces(store);
  resetFlow(store);
  const values: (number | null)[] = [];
  await runBackfill(store, undefined, (value) => values.push(value));
  assert.deepEqual(values, [
    JOB_START,
    ANCHOR + (TRACE_COUNT_OVER_ONE_CHUNK - BACKFILL_FILL_TRACES) * 1000,
    ANCHOR,
    null,
  ]);
  assert.ok(traces.every((trace) => kindOf(store, trace) === STEPS_KIND));
});

test("a stop between two transactions ends the job and keeps the committed work", async (t) => {
  const store = memoryStore(t);
  const traces = admitSimpleTraces(store);
  resetFlow(store);
  const controller = new AbortController();
  const values: (number | null)[] = [];
  await runBackfill(store, controller.signal, (value) => {
    values.push(value);
    if (value !== null && value !== JOB_START) controller.abort();
  });
  assert.equal(values.length, STOPPED_PROGRESS_VALUES);
  const newest = traces.slice(-BACKFILL_FILL_TRACES);
  assert.ok(newest.every((trace) => kindOf(store, trace) === STEPS_KIND));
  const rest = traces.slice(0, traces.length - BACKFILL_FILL_TRACES);
  assert.ok(rest.every((trace) => kindOf(store, trace) === null));
  const executions = store.database
    .prepare(
      "SELECT SUM(executions) AS total FROM tracking_flow_rollup WHERE grain = 'day'",
    )
    .get();
  assert.equal(Number(executions?.total), BACKFILL_FILL_TRACES);
});
