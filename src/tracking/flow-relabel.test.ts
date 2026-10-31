import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { CauseAssigner, type EffectiveCause } from "../kernel/cause.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  FlowGrain,
  RecordKind,
  ROOT_SPAN_OPERATION,
  SpanOrigin,
  type TelemetryRecord,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { admitRecords } from "./admission.ts";
import { openFlow } from "./flow-admission.ts";
import { relabelFlow } from "./flow-relabel.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, type TraceRow } from "./trace-store.ts";

const ANCHOR = Date.UTC(2026, 9, 31, 10, 30);
const NOW = ANCHOR + 2000;
const GRAINS = Object.values(FlowGrain);
const HOSTED = "hosted_worker";
const NO_ROWS = 0;
const FIRST: EffectiveCause = {
  category: "prompt",
  subcategory: "context_missing",
  assigner: CauseAssigner.Human,
};
const SECOND: EffectiveCause = {
  category: "plan",
  subcategory: "oversized",
  assigner: CauseAssigner.Human,
};

type Row = Record<string, unknown>;

function isHosted(workerName: string): boolean {
  return workerName === HOSTED;
}

function traceOf(sequence: number): TraceRow {
  return {
    trace_id: sequence.toString(16).padStart(32, "0"),
    root_span_id: sequence.toString(16).padStart(16, "1"),
    execution_id: `execution_${ulid(ANCHOR)}`,
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

function spanRecord(
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

function stoppedRecords(trace: TraceRow): TelemetryRecord[] {
  return [
    spanRecord(trace, "start", trace.root_span_id, ROOT_SPAN_OPERATION, {
      start_time: ANCHOR,
      attributes: {
        "kanthord.execution.kind": "steps",
        "kanthord.worker.name": HOSTED,
      },
    }),
    spanRecord(trace, "turn", "4".repeat(16), "agent.turn", {
      start_time: ANCHOR + 100,
      end_time: ANCHOR + 200,
      attributes: {
        "gen_ai.response.model": "model-a",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 10,
        "kanthord.usage.cost_usd": 0.25,
      },
    }),
    spanRecord(trace, "end", trace.root_span_id, ROOT_SPAN_OPERATION, {
      end_time: ANCHOR + 1000,
      attributes: {
        "kanthord.execution.end": "finished",
        "kanthord.stop.reason": "no_progress",
        "kanthord.cause.category": "model",
        "kanthord.cause.subcategory": "no_progress",
        "kanthord.cause.assigner": "rule",
      },
    }),
  ];
}

function admit(store: Store, trace: TraceRow, records: TelemetryRecord[]) {
  store.transaction((tx) => {
    const inserted = insertTrace(tx, trace, NOW);
    const flow = openFlow(tx, trace.trace_id, inserted, isHosted);
    admitRecords(
      tx,
      {
        trace,
        producer: "producer",
        origin: SpanOrigin.Observed,
        now: NOW,
        flow,
      },
      records,
    );
  });
}

function relabel(store: Store, trace: TraceRow, cause: EffectiveCause) {
  store.transaction((tx) =>
    relabelFlow(tx, trace.trace_id, cause, isHosted, NOW),
  );
}

function causeKeys(store: Store, grain: FlowGrain): string[] {
  return store.database
    .prepare(
      "SELECT cause_category, cause_detail, cause_assigner, executions, turn_count FROM tracking_flow_rollup WHERE grain = ? ORDER BY cause_category",
    )
    .all(grain)
    .map(
      (row: Row) =>
        `${String(row.cause_category)}/${String(row.cause_detail)}/${String(row.cause_assigner)}:${String(row.executions)}:${String(row.turn_count)}`,
    );
}

function dump(store: Store, table: string): string {
  return JSON.stringify(store.database.prepare(`SELECT * FROM ${table}`).all());
}

function traceCause(store: Store, trace: TraceRow): Row {
  const row = store.database
    .prepare(
      "SELECT cause_category, cause_detail, cause_assigner FROM tracking_trace WHERE trace_id = ?",
    )
    .get(trace.trace_id);
  assert.ok(row);
  return { ...row };
}

test("a label moves a stopped trace from the rule key to the label key in both grains", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  admit(store, trace, stoppedRecords(trace));
  for (const grain of GRAINS)
    assert.deepEqual(causeKeys(store, grain), ["model/no_progress/rule:1:1"]);
  relabel(store, trace, FIRST);
  for (const grain of GRAINS)
    assert.deepEqual(causeKeys(store, grain), [
      "prompt/context_missing/human:1:1",
    ]);
  assert.deepEqual(traceCause(store, trace), {
    cause_category: "prompt",
    cause_detail: "context_missing",
    cause_assigner: "human",
  });
});

test("a second label moves the count again and deletes the row of the first label", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  admit(store, trace, stoppedRecords(trace));
  relabel(store, trace, FIRST);
  relabel(store, trace, SECOND);
  for (const grain of GRAINS)
    assert.deepEqual(causeKeys(store, grain), ["plan/oversized/human:1:1"]);
  assert.deepEqual(traceCause(store, trace), {
    cause_category: "plan",
    cause_detail: "oversized",
    cause_assigner: "human",
  });
});

test("a label changes no histogram row and no usage row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  admit(store, trace, stoppedRecords(trace));
  const histogram = dump(store, "tracking_flow_histogram");
  const usage = dump(store, "tracking_usage_rollup");
  relabel(store, trace, FIRST);
  relabel(store, trace, SECOND);
  assert.equal(dump(store, "tracking_flow_histogram"), histogram);
  assert.equal(dump(store, "tracking_usage_rollup"), usage);
});

test("a label of a trace with a NULL kind changes no trace row and no rollup", (t) => {
  const store = memoryStore(t);
  const trace = { ...traceOf(1), execution_id: null };
  store.transaction((tx) => insertTrace(tx, trace, NOW));
  const before = [
    dump(store, "tracking_trace"),
    dump(store, "tracking_flow_rollup"),
  ];
  relabel(store, trace, FIRST);
  assert.deepEqual(
    [dump(store, "tracking_trace"), dump(store, "tracking_flow_rollup")],
    before,
  );
  assert.equal(
    store.database
      .prepare("SELECT COUNT(*) AS count FROM tracking_flow_rollup")
      .get()?.count,
    NO_ROWS,
  );
});
