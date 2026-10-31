import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HttpStatus } from "../kernel/http.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  type AnalyticsFlowQuery,
  FLOW_PERCENTILE_METHOD,
  FlowCompare,
  FlowExit,
  FlowGrain,
  FlowMeasure,
  flowReadSchema,
  FlowStage,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { BIN_COUNT, binOf, encodeBins } from "./flow-bins.ts";
import { readFlow } from "./flow-read.ts";
import { FLOW_VECTOR_COLUMNS } from "./flow-model.ts";
import { trackingMigrations } from "./migrations.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D0 = Date.UTC(2024, 5, 15);
const NOW = D0 + 10 * HOUR + 30 * 60_000;
const RANGE_INVALID = "tracking.filter.range_invalid";
const NO_COUNT = 0;
const COUNT_ONE = 1;
const COUNT_TWO = 2;
const COUNT_THREE = 3;
const COUNT_FOUR = 4;
const COUNT_FIVE = 5;
const STATEMENTS_MAX = 6;
const STATEMENTS_WITHOUT_HOURS = 4;
const OPTIONS = { isHostedWorker: () => false, rebuild: null };

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function query(overrides: Partial<AnalyticsFlowQuery>): AnalyticsFlowQuery {
  return { compare: FlowCompare.Previous, ...overrides };
}

function insert(
  store: Store,
  table: string,
  values: Record<string, string | number | Uint8Array>,
): void {
  const columns = Object.keys(values);
  store.transaction((tx) =>
    tx.database
      .prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(values)),
  );
}

function rollup(
  store: Store,
  grain: FlowGrain,
  bucketStart: number,
  overrides: Record<string, string | number> = {},
): void {
  insert(store, "tracking_flow_rollup", {
    grain,
    bucket_start: bucketStart,
    project_id: "p1",
    worker_name: "w1",
    stage: FlowStage.Executing,
    exit: FlowExit.FurtherWork,
    stop_reason: "",
    cause_category: "",
    cause_detail: "",
    cause_assigner: "",
    ...Object.fromEntries(FLOW_VECTOR_COLUMNS.map((column) => [column, 0])),
    executions: COUNT_ONE,
    changed_after_end: 0,
    ...overrides,
  });
}

function completed(
  store: Store,
  grain: FlowGrain,
  bucketStart: number,
  executions: number,
  costUsd: number,
): void {
  rollup(store, grain, bucketStart, {
    stage: FlowStage.Outcome,
    exit: FlowExit.Completed,
    executions,
    cost_usd: costUsd,
  });
}

function usage(
  store: Store,
  grain: FlowGrain,
  bucketStart: number,
  costUsd: number,
  overrides: Record<string, string | number> = {},
): void {
  insert(store, "tracking_usage_rollup", {
    grain,
    bucket_start: bucketStart,
    project_id: "p1",
    worker_name: "w1",
    model: "model_a",
    turn_count: COUNT_ONE,
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 50,
    cost_usd: costUsd,
    unpriced_tokens: NO_COUNT,
    ...overrides,
  });
}

function histogram(
  store: Store,
  grain: FlowGrain,
  bucketStart: number,
  projectId: string,
  workerName: string,
  value: number,
): void {
  const bins = Array.from({ length: BIN_COUNT }, () => NO_COUNT);
  bins[binOf(value)] = COUNT_ONE;
  insert(store, "tracking_flow_histogram", {
    grain,
    bucket_start: bucketStart,
    project_id: projectId,
    worker_name: workerName,
    measure: FlowMeasure.ExecutionTime,
    bins: encodeBins(bins),
  });
}

function stageOf(read: ReturnType<typeof readFlow>, stage: FlowStage) {
  const found = read.stages.find((result) => result.stage === stage);
  assert.ok(found);
  return found;
}

function hourStore(t: TestContext): Store {
  const store = memoryStore(t);
  rollup(store, FlowGrain.Hour, D0 + HOUR, { executions: 7 });
  rollup(store, FlowGrain.Hour, D0 + 3 * HOUR, { executions: COUNT_TWO });
  rollup(store, FlowGrain.Hour, D0 + 7 * HOUR, { executions: COUNT_THREE });
  rollup(store, FlowGrain.Hour, D0 + 10 * HOUR, { executions: 9 });
  usage(store, FlowGrain.Hour, D0 + HOUR, 100);
  usage(store, FlowGrain.Hour, D0 + 3 * HOUR, COUNT_ONE);
  usage(store, FlowGrain.Hour, D0 + 7 * HOUR, COUNT_TWO);
  usage(store, FlowGrain.Hour, D0 + 10 * HOUR, 1000);
  return store;
}

const HOUR_QUERY = { from: D0 + 6 * HOUR, to: D0 + 10 * HOUR };

test("a row lands in its window and a row outside both adds nothing", (t) => {
  const read = readFlow(hourStore(t), query(HOUR_QUERY), NOW, OPTIONS);
  assert.deepEqual(read.window.buckets, [
    D0 + 6 * HOUR,
    D0 + 7 * HOUR,
    D0 + 8 * HOUR,
    D0 + 9 * HOUR,
  ]);
  assert.deepEqual(read.previous_window, {
    from: D0 + 2 * HOUR,
    to: D0 + 6 * HOUR,
  });
  assert.equal(read.window.now, D0 + 10 * HOUR);
  const executing = stageOf(read, FlowStage.Executing);
  assert.equal(executing.current.entered, COUNT_THREE);
  assert.equal(executing.previous?.entered, COUNT_TWO);
  assert.deepEqual(executing.series.entered, [
    NO_COUNT,
    COUNT_THREE,
    NO_COUNT,
    NO_COUNT,
  ]);
  assert.equal(read.usage.current.cost_usd, COUNT_TWO);
  assert.equal(read.usage.previous?.cost_usd, COUNT_ONE);
  assert.equal(read.completeness.executions, COUNT_THREE);
});

test("the answer parses with the output schema", (t) => {
  const store = hourStore(t);
  rollup(store, FlowGrain.Hour, D0 + 7 * HOUR, {
    exit: FlowExit.Stopped,
    stop_reason: "operation_failed",
    cause_category: "environment",
    cause_detail: "dependency",
    cause_assigner: "rule",
    cost_usd: 1.5,
  });
  rollup(store, FlowGrain.Hour, D0 + 3 * HOUR, {
    stage: FlowStage.Outcome,
    exit: FlowExit.Rework,
    cause_category: "unattributed",
    cause_assigner: "rule",
  });
  histogram(store, FlowGrain.Hour, D0 + 7 * HOUR, "p1", "w1", 1000);
  const read = readFlow(store, query(HOUR_QUERY), NOW, {
    isHostedWorker: () => false,
    rebuild: { pending_until: NOW },
  });
  assert.deepEqual(flowReadSchema.parse(read), read);
  assert.deepEqual(read.rebuild, { pending_until: NOW });
  assert.equal(read.percentile_method, FLOW_PERCENTILE_METHOD);
});

test("project_id and worker_name filter the rows", (t) => {
  const store = hourStore(t);
  rollup(store, FlowGrain.Hour, D0 + 7 * HOUR, {
    project_id: "p2",
    worker_name: "w2",
    executions: COUNT_FIVE,
  });
  usage(store, FlowGrain.Hour, D0 + 7 * HOUR, COUNT_FOUR, {
    project_id: "p2",
    worker_name: "w2",
    model: "model_b",
  });
  histogram(store, FlowGrain.Hour, D0 + 7 * HOUR, "p2", "w2", 5000);
  const entered = (overrides: Partial<AnalyticsFlowQuery>) => {
    const read = readFlow(
      store,
      query({ ...HOUR_QUERY, ...overrides }),
      NOW,
      OPTIONS,
    );
    const executing = stageOf(read, FlowStage.Executing);
    return [
      executing.current.entered,
      read.usage.current.cost_usd,
      executing.current.time?.count ?? NO_COUNT,
    ];
  };
  assert.deepEqual(entered({}), [
    COUNT_THREE + COUNT_FIVE,
    COUNT_TWO + COUNT_FOUR,
    COUNT_ONE,
  ]);
  assert.deepEqual(entered({ project_id: "project_p1" as never }), [
    NO_COUNT,
    NO_COUNT,
    NO_COUNT,
  ]);
  assert.deepEqual(entered({ worker_name: "w2" }), [
    COUNT_FIVE,
    COUNT_FOUR,
    COUNT_ONE,
  ]);
  assert.deepEqual(entered({ worker_name: "w1" }), [
    COUNT_THREE,
    COUNT_TWO,
    NO_COUNT,
  ]);
});

test("a project filter keeps the rows of that project only", (t) => {
  const store = memoryStore(t);
  const first = "project_01";
  const second = "project_02";
  rollup(store, FlowGrain.Hour, D0 + 7 * HOUR, {
    project_id: first,
    executions: COUNT_THREE,
  });
  rollup(store, FlowGrain.Hour, D0 + 7 * HOUR, {
    project_id: second,
    executions: COUNT_FIVE,
  });
  rollup(store, FlowGrain.Hour, D0 + 3 * HOUR, { project_id: second });
  const read = readFlow(
    store,
    query({ ...HOUR_QUERY, project_id: first as never }),
    NOW,
    OPTIONS,
  );
  assert.equal(stageOf(read, FlowStage.Executing).current.entered, COUNT_THREE);
  assert.equal(read.previous_window, null);
});

function dayStore(t: TestContext): Store {
  const store = memoryStore(t);
  completed(store, FlowGrain.Day, D0 - 5 * DAY, COUNT_ONE, COUNT_ONE);
  completed(store, FlowGrain.Day, D0 - 4 * DAY, COUNT_ONE, COUNT_ONE);
  completed(store, FlowGrain.Day, D0 - 3 * DAY, COUNT_FIVE, COUNT_ONE);
  completed(store, FlowGrain.Day, D0 - 2 * DAY, COUNT_TWO, COUNT_ONE);
  usage(store, FlowGrain.Day, D0 - 5 * DAY, COUNT_ONE);
  usage(store, FlowGrain.Day, D0 - 4 * DAY, COUNT_TWO);
  usage(store, FlowGrain.Day, D0 - 3 * DAY, 100);
  usage(store, FlowGrain.Day, D0 - 2 * DAY, COUNT_TWO);
  const cutDay = D0 - 3 * DAY;
  completed(store, FlowGrain.Hour, cutDay + 3 * HOUR, COUNT_ONE, COUNT_ONE);
  completed(store, FlowGrain.Hour, cutDay + 10 * HOUR, COUNT_TWO, COUNT_ONE);
  completed(store, FlowGrain.Hour, cutDay + 11 * HOUR, 50, COUNT_ONE);
  completed(store, FlowGrain.Hour, D0 - 4 * DAY + 3 * HOUR, 70, COUNT_ONE);
  usage(store, FlowGrain.Hour, cutDay + 3 * HOUR, COUNT_FOUR);
  usage(store, FlowGrain.Hour, cutDay + 10 * HOUR, 8);
  usage(store, FlowGrain.Hour, cutDay + 11 * HOUR, 1000);
  usage(store, FlowGrain.Hour, D0 - 4 * DAY + 3 * HOUR, 7000);
  return store;
}

const DAY_QUERY = { from: D0 - 2 * DAY, to: NOW, bucket: FlowGrain.Day };

test("the hour rows of the cut day give the same-hour sums for the grain day", (t) => {
  const read = readFlow(dayStore(t), query(DAY_QUERY), NOW, OPTIONS);
  assert.equal(read.window.from, D0 - 2 * DAY);
  assert.deepEqual(read.previous_window, {
    from: D0 - 5 * DAY,
    to: D0 - 2 * DAY,
  });
  assert.equal(read.cost.previous?.total_usd, COUNT_ONE + COUNT_TWO + 100);
  assert.equal(read.cost.previous?.success, COUNT_ONE + COUNT_ONE + COUNT_FIVE);
  assert.deepEqual(read.cost.previous_same_hour, {
    total_usd: COUNT_ONE + COUNT_TWO + COUNT_FOUR + 8,
    success: COUNT_ONE + COUNT_ONE + COUNT_ONE + COUNT_TWO,
    rejected_review_usd: NO_COUNT,
  });
  assert.equal(
    read.usage.previous_same_hour?.cost_usd,
    COUNT_ONE + COUNT_TWO + COUNT_FOUR + 8,
  );
  assert.deepEqual(read.usage.by.model[0]?.previous_same_hour, {
    cost_usd: COUNT_ONE + COUNT_TWO + COUNT_FOUR + 8,
  });
});

function statementsOf(
  t: TestContext,
  store: Store,
  input: AnalyticsFlowQuery,
  now: number,
): string[] {
  const prepare = t.mock.method(store.database, "prepare");
  readFlow(store, input, now, OPTIONS);
  return prepare.mock.calls.map((call) => String(call.arguments[0]));
}

test("the read skips the hour statements for a cut on a day boundary", (t) => {
  const store = dayStore(t);
  const boundary = query({ from: D0 - 2 * DAY, to: D0, bucket: FlowGrain.Day });
  const statements = statementsOf(t, store, boundary, D0);
  assert.equal(statements.length, STATEMENTS_WITHOUT_HOURS);
  const read = readFlow(store, boundary, D0, OPTIONS);
  assert.equal(read.cost.previous_same_hour?.success, COUNT_ONE + COUNT_FIVE);
});

test("the read runs at most six statements on the three rollup tables", (t) => {
  const store = dayStore(t);
  const statements = statementsOf(t, store, query(DAY_QUERY), NOW);
  assert.equal(statements.length, STATEMENTS_MAX);
  for (const sql of statements) {
    assert.match(sql, /^SELECT /);
    assert.match(
      sql,
      /FROM tracking_(flow_rollup|flow_histogram|usage_rollup) /,
    );
    assert.doesNotMatch(sql, /tracking_(trace|span)/);
  }
});

test("each statement searches a primary-key range or prefix", (t) => {
  const store = dayStore(t);
  const filtered = query({
    ...DAY_QUERY,
    project_id: "project_01" as never,
    worker_name: "w1",
  });
  for (const sql of statementsOf(t, store, filtered, NOW)) {
    const marks = sql.split("?").length - COUNT_ONE;
    const values = ["day", D0 - 5 * DAY, D0, "project_01", "w1"].slice(
      NO_COUNT,
      marks,
    );
    const plan = store.database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...values)
      .map((row) => String(row.detail))
      .join(" ");
    assert.match(plan, /SEARCH/);
    assert.doesNotMatch(plan, /SCAN/);
  }
});

test("the read runs in one read transaction", (t) => {
  const store = dayStore(t);
  const transaction = t.mock.method(store, "transaction");
  readFlow(store, query(DAY_QUERY), NOW, OPTIONS);
  assert.equal(transaction.mock.callCount(), COUNT_ONE);
});

test("a range error opens no transaction", (t) => {
  const store = dayStore(t);
  const transaction = t.mock.method(store, "transaction");
  assert.throws(
    () => readFlow(store, query({ from: NOW, to: NOW - 1 }), NOW, OPTIONS),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === RANGE_INVALID &&
      "status" in error &&
      error.status === HttpStatus.BadRequest,
  );
  assert.equal(transaction.mock.callCount(), NO_COUNT);
});

test("a store with rows from a later day gives a null previous window", (t) => {
  const store = memoryStore(t);
  completed(store, FlowGrain.Day, D0 - DAY, COUNT_THREE, COUNT_ONE);
  usage(store, FlowGrain.Day, D0 - DAY, COUNT_ONE);
  const read = readFlow(store, query(DAY_QUERY), NOW, OPTIONS);
  assert.equal(read.previous_window, null);
  assert.equal(read.cost.previous, null);
  assert.equal(read.cost.previous_same_hour, null);
  assert.equal(read.usage.previous_same_hour, null);
  assert.equal(read.causes.previous_rows, null);
  assert.equal(read.stop_reasons.previous_totals, null);
  assert.equal(stageOf(read, FlowStage.Outcome).previous, null);
  assert.equal(stageOf(read, FlowStage.Outcome).current.entered, COUNT_THREE);
});

test("an empty store gives a null previous window and zero sums", (t) => {
  const read = readFlow(memoryStore(t), query(DAY_QUERY), NOW, OPTIONS);
  assert.equal(read.previous_window, null);
  assert.equal(read.cost.current.total_usd, NO_COUNT);
  assert.deepEqual(read.usage.by.model, []);
  assert.deepEqual(flowReadSchema.parse(read), read);
});
