import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import {
  type Attributes,
  FlowGrain,
  FlowMeasure,
  RecordKind,
  ROOT_SPAN_OPERATION,
  type SpanContribution,
  SpanOrigin,
  SpanStatus,
  type TelemetryRecord,
  TRACKING_SERVICE_NAME,
  TRANSITION_SPAN_OPERATION,
} from "./contract.ts";
import { admitRecords, admitServerSpan } from "./admission.ts";
import { decodeBins, percentilesOf } from "./flow-bins.ts";
import { openFlow } from "./flow-admission.ts";
import { FLOW_VECTOR_COLUMNS } from "./flow-model.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, type TraceRow } from "./trace-store.ts";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const ANCHOR = Date.UTC(2026, 9, 31, 10, 30);
const HOUR_START = Date.UTC(2026, 9, 31, 10);
const DAY_START = Date.UTC(2026, 9, 31);
const PRODUCER = "producer";
const HOSTED = "hosted_worker";
const EXTERNAL = "external_worker";
const MODEL = "model-a";
const GRAINS = Object.values(FlowGrain);

function isHosted(workerName: string): boolean {
  return workerName === HOSTED;
}

function traceOf(
  sequence: number,
  anchor = ANCHOR,
  executionId: string | null = `execution_${ulid(anchor)}`,
): TraceRow {
  return {
    trace_id: sequence.toString(16).padStart(32, "0"),
    root_span_id: sequence.toString(16).padStart(16, "1"),
    execution_id: executionId,
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

interface SpanFields {
  start?: number;
  end?: number;
  attributes?: Attributes;
  status?: SpanStatus;
  parent?: boolean;
}

function record(
  trace: TraceRow,
  key: string,
  spanId: string,
  operation: string,
  fields: SpanFields = {},
): TelemetryRecord {
  return {
    record_id: key,
    trace_id: trace.trace_id,
    kind: RecordKind.Span,
    span_id: spanId,
    operation,
    parent_span_id: spanId === trace.root_span_id ? null : trace.root_span_id,
    ...(fields.start === undefined ? {} : { start_time: fields.start }),
    ...(fields.end === undefined ? {} : { end_time: fields.end }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    attributes: fields.attributes ?? {},
  } as TelemetryRecord;
}

function rootStart(
  trace: TraceRow,
  kind: string,
  attributes: Attributes = {},
): TelemetryRecord {
  return record(
    trace,
    `${trace.trace_id}:root:start`,
    trace.root_span_id,
    ROOT_SPAN_OPERATION,
    {
      start: ANCHOR,
      attributes: {
        "kanthord.execution.kind": kind,
        "kanthord.worker.name": HOSTED,
        "kanthord.queue.wait_ms": 250,
        ...attributes,
      },
    },
  );
}

function rootEnd(
  trace: TraceRow,
  attributes: Attributes = {},
  end = ANCHOR + 1000,
): TelemetryRecord {
  return record(
    trace,
    `${trace.trace_id}:root:end`,
    trace.root_span_id,
    ROOT_SPAN_OPERATION,
    {
      end,
      attributes: { "kanthord.execution.end": "finished", ...attributes },
    },
  );
}

function transition(
  trace: TraceRow,
  to: string,
  attributes: Attributes = {},
): TelemetryRecord {
  return record(
    trace,
    `${trace.trace_id}:transition`,
    "3".repeat(16),
    TRANSITION_SPAN_OPERATION,
    {
      start: ANCHOR + 900,
      end: ANCHOR + 900,
      attributes: {
        "kanthord.node.state.to": to,
        "kanthord.transition.rule": "none",
        ...attributes,
      },
    },
  );
}

function turn(
  trace: TraceRow,
  index: number,
  attributes: Attributes = {},
): TelemetryRecord {
  return record(
    trace,
    `${trace.trace_id}:turn:${index}`,
    `4${index}`.padStart(16, "4"),
    "agent.turn",
    {
      start: ANCHOR + 100,
      end: ANCHOR + 200,
      attributes: {
        "gen_ai.response.model": MODEL,
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 10,
        "gen_ai.usage.cache_read.input_tokens": 40,
        "kanthord.usage.cost_usd": 0.25,
        ...attributes,
      },
    },
  );
}

function toolError(trace: TraceRow): TelemetryRecord {
  return record(trace, `${trace.trace_id}:tool`, "5".repeat(16), "agent.tool", {
    start: ANCHOR + 300,
    end: ANCHOR + 400,
    attributes: { "error.type": "tool_error" },
  });
}

function releaseGate(trace: TraceRow, attributes: Attributes = {}) {
  return record(
    trace,
    `${trace.trace_id}:gate`,
    "6".repeat(16),
    "worker.release_gate",
    {
      start: ANCHOR + 500,
      end: ANCHOR + 800,
      attributes: { "kanthord.release_gate.result": "passed", ...attributes },
    },
  );
}

function affectedVerification(trace: TraceRow) {
  return record(
    trace,
    `${trace.trace_id}:affected`,
    "7".repeat(16),
    "worker.verification",
    {
      start: ANCHOR + 520,
      end: ANCHOR + 620,
      attributes: {
        "kanthord.verification.kind": "affected",
        "kanthord.verification.context": "release",
        "kanthord.affected.verdict": "failed",
      },
    },
  );
}

function write(
  store: Store,
  trace: TraceRow,
  records: readonly TelemetryRecord[],
  now = ANCHOR + 2000,
): void {
  store.transaction((tx) => {
    const inserted = insertTrace(tx, trace, now);
    const flow = openFlow(tx, trace.trace_id, inserted, isHosted);
    admitRecords(
      tx,
      { trace, producer: PRODUCER, origin: SpanOrigin.Observed, now, flow },
      records,
    );
  });
}

function writeServer(
  store: Store,
  trace: TraceRow,
  contribution: SpanContribution,
  now = ANCHOR + 2000,
): void {
  store.transaction((tx) => {
    const inserted = insertTrace(tx, trace, now);
    const flow = openFlow(tx, trace.trace_id, inserted, isHosted);
    const reason = admitServerSpan(
      tx,
      { trace, producer: PRODUCER, origin: SpanOrigin.Observed, now, flow },
      contribution,
    );
    assert.equal(reason, null);
  });
}

type Row = Record<string, unknown>;

function rollup(store: Store, grain: FlowGrain): Row[] {
  return store.database
    .prepare(
      "SELECT * FROM tracking_flow_rollup WHERE grain = ? ORDER BY exit, stage, stop_reason",
    )
    .all(grain);
}

function shape(row: Row, names: readonly string[]): Row {
  return Object.fromEntries(names.map((name) => [name, row[name]]));
}

function keysOf(rows: Row[]): string[] {
  return rows.map((row) => `${String(row.stage)}/${String(row.exit)}`);
}

function usageRows(store: Store, grain: FlowGrain): Row[] {
  return store.database
    .prepare("SELECT * FROM tracking_usage_rollup WHERE grain = ?")
    .all(grain);
}

function histogramOf(store: Store, grain: FlowGrain, measure: FlowMeasure) {
  const row = store.database
    .prepare(
      "SELECT bins FROM tracking_flow_histogram WHERE grain = ? AND measure = ?",
    )
    .get(grain, measure);
  if (row === undefined) return null;
  assert.ok(row.bins instanceof Uint8Array);
  return percentilesOf(decodeBins(row.bins));
}

function tableDump(store: Store): string {
  return JSON.stringify(
    [
      "SELECT * FROM tracking_flow_rollup ORDER BY grain, exit, stage",
      "SELECT * FROM tracking_flow_histogram ORDER BY grain, measure",
      "SELECT * FROM tracking_usage_rollup ORDER BY grain, model",
      "SELECT * FROM tracking_trace ORDER BY trace_id",
    ].map((sql) => store.database.prepare(sql).all()),
  );
}

function countOf(store: Store, table: string): number {
  const row = store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get();
  return Number(row?.count);
}

function traceColumns(store: Store, trace: TraceRow, names: string): Row {
  const row = store.database
    .prepare(`SELECT ${names} FROM tracking_trace WHERE trace_id = ?`)
    .get(trace.trace_id);
  assert.ok(row);
  return { ...row };
}

const OUTCOME_COLUMNS = [
  "stage",
  "exit",
  "stop_reason",
  "cause_category",
  "cause_detail",
  "cause_assigner",
  "executions",
];

test("a steps execution handed on after a passed gate lands in one row of each grain", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    turn(trace, 1),
    turn(trace, 2, { "error.type": "rate_limited" }),
    toolError(trace),
    releaseGate(trace),
    transition(trace, "Waiting"),
    rootEnd(trace),
  ]);
  for (const grain of GRAINS) {
    const rows = rollup(store, grain);
    assert.deepEqual([rows.length], [1]);
    assert.deepEqual(
      shape(rows[0] ?? {}, [
        ...OUTCOME_COLUMNS,
        "worker_name",
        "project_id",
        "unobserved",
        "awaiting_ingestion",
        "turn_count",
        "tool_count",
        "tool_error_count",
        "turn_rate_limited",
        "gate_affected_absent",
        "cost_usd",
        "changed_after_end",
        "late_records",
      ]),
      {
        stage: "release_gate",
        exit: "handed_on",
        stop_reason: "",
        cause_category: "",
        cause_detail: "",
        cause_assigner: "",
        executions: 1,
        worker_name: HOSTED,
        project_id: "project_a",
        unobserved: 0,
        awaiting_ingestion: 0,
        turn_count: 2,
        tool_count: 1,
        tool_error_count: 1,
        turn_rate_limited: 1,
        gate_affected_absent: 1,
        cost_usd: 0.5,
        changed_after_end: 0,
        late_records: 0,
      },
    );
  }
  assert.deepEqual(
    [
      rollup(store, FlowGrain.Hour)[0]?.bucket_start,
      rollup(store, FlowGrain.Day)[0]?.bucket_start,
    ],
    [HOUR_START, DAY_START],
  );
});

test("the same execution with no gate span is unobserved at the stage release_gate", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    turn(trace, 1),
    transition(trace, "Waiting"),
    rootEnd(trace),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["stage", "exit", "unobserved", "executions"]),
      ),
      [
        {
          stage: "release_gate",
          exit: "handed_on",
          unobserved: 1,
          executions: 1,
        },
      ],
    );
});

test("an evaluation execution with an assessed end and a transition to Available is a rework", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "evaluation"),
    record(trace, "evaluation", "8".repeat(16), "worker.evaluation", {
      start: ANCHOR + 100,
      end: ANCHOR + 200,
      attributes: { "kanthord.evaluation.stage": "judgement" },
    }),
    transition(trace, "Available"),
    rootEnd(trace),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["stage", "exit", "evaluation_judgement", "executions"]),
      ),
      [
        {
          stage: "outcome",
          exit: "rework",
          evaluation_judgement: 1,
          executions: 1,
        },
      ],
    );
  assert.deepEqual(
    [histogramOf(store, FlowGrain.Hour, FlowMeasure.ReviewWait)?.count],
    [1],
  );
});

test("a root end after the transition moves the row from open to the final exit", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    transition(trace, "Waiting"),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(keysOf(rollup(store, grain)), ["executing/open"]);
  write(store, trace, [rootEnd(trace)]);
  for (const grain of GRAINS)
    assert.deepEqual(keysOf(rollup(store, grain)), ["release_gate/handed_on"]);
});

test("a batch with the root start, the transition and the root end leaves no open row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    transition(trace, "Waiting"),
    rootEnd(trace),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(keysOf(rollup(store, grain)), ["release_gate/handed_on"]);
});

test("an exit change from open to stopped moves the vector and deletes the old row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps"), turn(trace, 1)]);
  write(store, trace, [
    rootEnd(trace, {
      "kanthord.execution.end": "finished",
      "kanthord.stop.reason": "no_progress",
      "kanthord.cause.category": "model",
      "kanthord.cause.subcategory": "no_progress",
      "kanthord.cause.assigner": "rule",
    }),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, [...OUTCOME_COLUMNS, "turn_count"]),
      ),
      [
        {
          stage: "executing",
          exit: "stopped",
          stop_reason: "no_progress",
          cause_category: "model",
          cause_detail: "no_progress",
          cause_assigner: "rule",
          executions: 1,
          turn_count: 1,
        },
      ],
    );
});

test("a handed on execution keys an empty stop reason and an empty cause", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    transition(trace, "Waiting"),
    rootEnd(trace, {
      "kanthord.cause.category": "model",
      "kanthord.cause.subcategory": "no_progress",
      "kanthord.cause.assigner": "rule",
    }),
  ]);
  assert.deepEqual(
    rollup(store, FlowGrain.Day).map((row) => shape(row, OUTCOME_COLUMNS)),
    [
      {
        stage: "release_gate",
        exit: "handed_on",
        stop_reason: "",
        cause_category: "",
        cause_detail: "",
        cause_assigner: "",
        executions: 1,
      },
    ],
  );
  assert.deepEqual(
    traceColumns(store, trace, "cause_category, cause_assigner"),
    { cause_category: "model", cause_assigner: "rule" },
  );
});

test("a duplicate record changes no row and no flow column", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  const records = [
    rootStart(trace, "steps"),
    turn(trace, 1),
    releaseGate(trace),
    transition(trace, "Waiting"),
    rootEnd(trace),
  ];
  write(store, trace, records);
  const before = tableDump(store);
  write(store, trace, records);
  assert.equal(tableDump(store), before);
});

test("a record two hours after the end is late and marks the past-bucket rows of its transaction", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    transition(trace, "Waiting"),
    rootEnd(trace),
  ]);
  const now = ANCHOR + 1000 + 2 * HOUR_MS;
  write(store, trace, [turn(trace, 1)], now);
  const marks = (grain: FlowGrain) =>
    rollup(store, grain).map((row) =>
      shape(row, ["changed_after_end", "late_records", "turn_count"]),
    );
  assert.deepEqual(marks(FlowGrain.Hour), [
    { changed_after_end: 1, late_records: 1, turn_count: 1 },
  ]);
  assert.deepEqual(marks(FlowGrain.Day), [
    { changed_after_end: 0, late_records: 1, turn_count: 1 },
  ]);
  assert.deepEqual(traceColumns(store, trace, "late_records"), {
    late_records: 1,
  });
});

test("a record within an hour after the end is not late", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps"), rootEnd(trace)]);
  write(store, trace, [turn(trace, 1)], ANCHOR + 1000 + HOUR_MS);
  assert.deepEqual(traceColumns(store, trace, "late_records"), {
    late_records: 0,
  });
});

test("an on-time root end after the end of its claim bucket sets no mark", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps")], ANCHOR + 1000);
  const endedAt = HOUR_START + HOUR_MS + 5 * 60000;
  write(store, trace, [rootEnd(trace, {}, endedAt)], endedAt);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["exit", "changed_after_end", "late_records"]),
      ),
      [{ exit: "unknown", changed_after_end: 0, late_records: 0 }],
    );
});

test("a batch that ends the trace reads ended_at from the state for a later record", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  const now = ANCHOR + 1000 + 2 * HOUR_MS;
  write(store, trace, [rootStart(trace, "steps")], ANCHOR + 1000);
  write(store, trace, [rootEnd(trace), turn(trace, 1)], now);
  assert.deepEqual(traceColumns(store, trace, "late_records"), {
    late_records: 1,
  });
  assert.deepEqual(
    rollup(store, FlowGrain.Hour).map((row) =>
      shape(row, ["changed_after_end", "late_records"]),
    ),
    [{ changed_after_end: 1, late_records: 1 }],
  );
});

test("two turn ends with one key add to one usage row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    turn(trace, 1),
    turn(trace, 2),
  ]);
  for (const grain of GRAINS)
    assert.deepEqual(
      usageRows(store, grain).map((row) =>
        shape(row, [
          "model",
          "project_id",
          "worker_name",
          "turn_count",
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cost_usd",
          "unpriced_tokens",
        ]),
      ),
      [
        {
          model: MODEL,
          project_id: "project_a",
          worker_name: HOSTED,
          turn_count: 2,
          input_tokens: 200,
          output_tokens: 20,
          cache_read_tokens: 80,
          cost_usd: 0.5,
          unpriced_tokens: 0,
        },
      ],
    );
  write(store, trace, [turn(trace, 3)]);
  assert.deepEqual(
    usageRows(store, FlowGrain.Day).map((row) => row.turn_count),
    [3],
  );
});

test("a turn with tokens and no cost adds to the unpriced tokens", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    turn(trace, 1, { "kanthord.usage.cost_usd": 0 }),
    turn(trace, 2),
    turn(trace, 3, {
      "gen_ai.usage.input_tokens": 0,
      "gen_ai.usage.output_tokens": 0,
      "kanthord.usage.cost_usd": 0,
    }),
  ]);
  assert.deepEqual(
    usageRows(store, FlowGrain.Hour).map((row) =>
      shape(row, ["turn_count", "unpriced_tokens", "cost_usd"]),
    ),
    [{ turn_count: 3, unpriced_tokens: 110, cost_usd: 0.25 }],
  );
});

test("a turn with no model keys the empty model", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    record(trace, "bare-turn", "9".repeat(16), "agent.turn", {
      start: ANCHOR + 100,
      end: ANCHOR + 200,
    }),
  ]);
  assert.deepEqual(
    usageRows(store, FlowGrain.Hour).map((row) => row.model),
    [""],
  );
});

test("the release affected verification and the release gate add one histogram value each", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [
    rootStart(trace, "steps"),
    affectedVerification(trace),
    releaseGate(trace),
  ]);
  for (const grain of GRAINS) {
    assert.deepEqual(
      [histogramOf(store, grain, FlowMeasure.VerificationRunTime)?.count],
      [1],
    );
    assert.deepEqual(
      [histogramOf(store, grain, FlowMeasure.GateRunTime)?.count],
      [1],
    );
  }
  assert.deepEqual(
    rollup(store, FlowGrain.Hour).map((row) =>
      shape(row, ["affected_runs", "affected_failed", "gate_affected_absent"]),
    ),
    [{ affected_runs: 1, affected_failed: 1, gate_affected_absent: 1 }],
  );
});

test("the queue wait adds one value at the root start and a later key move adds none", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps")]);
  for (const grain of GRAINS)
    assert.deepEqual(
      [histogramOf(store, grain, FlowMeasure.QueueWait)?.count],
      [1],
    );
  write(store, trace, [transition(trace, "Waiting"), rootEnd(trace)]);
  for (const grain of GRAINS) {
    assert.deepEqual(
      [histogramOf(store, grain, FlowMeasure.QueueWait)?.count],
      [1],
    );
    assert.deepEqual(
      [histogramOf(store, grain, FlowMeasure.ExecutionTime)?.count],
      [1],
    );
    assert.equal(histogramOf(store, grain, FlowMeasure.LeadTime), null);
  }
  assert.deepEqual(
    store.database
      .prepare(
        "SELECT project_id, worker_name FROM tracking_flow_histogram WHERE grain = 'day' AND measure = 'queue_wait'",
      )
      .all()
      .map((row) => ({ ...row })),
    [{ project_id: "project_a", worker_name: HOSTED }],
  );
});

function countFlowUpdates(store: Store): () => number {
  store.database.exec(`
    CREATE TEMP TABLE flow_updates (n INTEGER);
    CREATE TEMP TRIGGER flow_updates_trigger AFTER UPDATE OF kind, stage, root_end, revoke_cause, transition_to, transition_rule, cause_category, cause_detail, cause_assigner, evaluation_stage, tool_error_count, turn_rate_limited, turn_quota_exhausted, turn_unavailable, turn_error_other, gate_routed, gate_affected, affected_runs, affected_failed, affected_base_red, affected_flaky_runs, flaky_tests, late_records ON main.tracking_trace BEGIN INSERT INTO flow_updates VALUES (1); END;
  `);
  return () => countOf(store, "temp.flow_updates");
}

test("a turn batch with no new fact writes no flow columns", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps")]);
  const updates = countFlowUpdates(store);
  write(store, trace, [turn(trace, 1), turn(trace, 2)]);
  assert.deepEqual([updates()], [0]);
  write(store, trace, [toolError(trace)]);
  assert.deepEqual([updates()], [1]);
});

test("a trace with no execution holds a null kind and writes no flow row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1, ANCHOR, null);
  write(store, trace, [turn(trace, 1), toolError(trace)]);
  assert.deepEqual(traceColumns(store, trace, "kind IS NULL AS absent"), {
    absent: 1,
  });
  assert.deepEqual(
    [
      "tracking_flow_rollup",
      "tracking_flow_histogram",
      "tracking_usage_rollup",
    ].map((table) => countOf(store, table)),
    [0, 0, 0],
  );
  store.transaction((tx) => {
    assert.equal(openFlow(tx, trace.trace_id, false, isHosted), null);
  });
});

function negativeCounters(store: Store): number {
  const condition = [...FLOW_VECTOR_COLUMNS, "changed_after_end"]
    .map((column) => `${column} < 0`)
    .join(" OR ");
  return countOf(
    store,
    `(SELECT 1 FROM tracking_flow_rollup WHERE ${condition})`,
  );
}

test("a new trace whose first batch holds only turns adds one execution to the stage empty row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [turn(trace, 1), turn(trace, 2)]);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["stage", "exit", "executions", "turn_count"]),
      ),
      [{ stage: "", exit: "open", executions: 1, turn_count: 2 }],
    );
  assert.deepEqual([negativeCounters(store)], [0]);
});

test("a new trace whose first batch holds the root start adds one execution to the executing row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [rootStart(trace, "steps")]);
  for (const grain of GRAINS)
    assert.deepEqual(keysOf(rollup(store, grain)), ["executing/open"]);
  assert.deepEqual(
    rollup(store, FlowGrain.Hour).map((row) => row.executions),
    [1],
  );
  assert.deepEqual([negativeCounters(store)], [0]);
});

test("a later root start subtracts the old contribution and deletes the stage empty row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(store, trace, [turn(trace, 1)]);
  write(store, trace, [rootStart(trace, "steps")]);
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["stage", "exit", "executions", "turn_count"]),
      ),
      [{ stage: "executing", exit: "open", executions: 1, turn_count: 1 }],
    );
  assert.deepEqual([negativeCounters(store)], [0]);
});

test("the server span path moves the contribution across spans", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  writeServer(store, trace, {
    record_id: "start",
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: ROOT_SPAN_OPERATION,
    start_time: ANCHOR,
    attributes: {
      "kanthord.execution.kind": "steps",
      "kanthord.worker.name": EXTERNAL,
    },
  });
  for (const grain of GRAINS)
    assert.deepEqual(keysOf(rollup(store, grain)), ["executing/open"]);
  writeServer(store, trace, {
    record_id: "end",
    span_id: trace.root_span_id,
    parent_span_id: null,
    operation: ROOT_SPAN_OPERATION,
    end_time: ANCHOR + 1000,
    status: SpanStatus.Ok,
    attributes: { "kanthord.execution.end": "lost" },
  });
  for (const grain of GRAINS)
    assert.deepEqual(
      rollup(store, grain).map((row) =>
        shape(row, ["exit", "stop_reason", "awaiting_ingestion", "executions"]),
      ),
      [
        {
          exit: "stopped",
          stop_reason: "lost",
          awaiting_ingestion: 1,
          executions: 1,
        },
      ],
    );
});

test("insertTrace answers true for a new row and false for a stored row", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  const answers = store.transaction((tx) => [
    insertTrace(tx, trace, ANCHOR),
    insertTrace(tx, trace, ANCHOR + 1),
  ]);
  assert.deepEqual(answers, [true, false]);
  assert.deepEqual(traceColumns(store, trace, "kind, created_at"), {
    kind: "",
    created_at: ANCHOR,
  });
});

test("an anchor older than 8 days writes no hour row and still writes its day row", (t) => {
  const store = memoryStore(t);
  const now = ANCHOR + 10 * DAY_MS;
  const trace = traceOf(1);
  write(
    store,
    trace,
    [rootStart(trace, "steps"), turn(trace, 1), releaseGate(trace)],
    now,
  );
  assert.deepEqual(rollup(store, FlowGrain.Hour), []);
  assert.deepEqual(usageRows(store, FlowGrain.Hour), []);
  assert.deepEqual(
    histogramOf(store, FlowGrain.Hour, FlowMeasure.GateRunTime),
    null,
  );
  assert.deepEqual(keysOf(rollup(store, FlowGrain.Day)), ["release_gate/open"]);
  assert.deepEqual([usageRows(store, FlowGrain.Day).length], [1]);
  assert.deepEqual(
    [histogramOf(store, FlowGrain.Day, FlowMeasure.GateRunTime)?.count],
    [1],
  );
});

test("an anchor older than 64 days writes no row of either grain", (t) => {
  const store = memoryStore(t);
  const trace = traceOf(1);
  write(
    store,
    trace,
    [rootStart(trace, "steps"), turn(trace, 1)],
    ANCHOR + 70 * DAY_MS,
  );
  assert.deepEqual(
    [
      "tracking_flow_rollup",
      "tracking_flow_histogram",
      "tracking_usage_rollup",
    ].map((table) => countOf(store, table)),
    [0, 0, 0],
  );
});
