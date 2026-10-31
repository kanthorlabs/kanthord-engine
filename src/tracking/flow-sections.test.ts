import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionStopReason } from "../scheduler/contract.ts";
import {
  ANALYTICS_ITEMS_MAX,
  FlowExit,
  FlowStage,
  FlowStopReason,
} from "./contract.ts";
import {
  causesOf,
  completenessOf,
  costOf,
  type FlowUsageRow,
  stopReasonsOf,
  usageOf,
} from "./flow-sections.ts";
import {
  FLOW_VECTOR_COLUMNS,
  FlowStageKey,
  type FlowVector,
} from "./flow-model.ts";
import type { FlowRow } from "./flow-stages.ts";

const HOUR = 3_600_000;
const B0 = 100 * HOUR;
const B1 = B0 + HOUR;
const B2 = B1 + HOUR;
const BUCKETS = [B0, B1];
const NO_COUNT = 0;
const COUNT_ONE = 1;
const COUNT_TWO = 2;
const COUNT_THREE = 3;
const COUNT_FOUR = 4;
const COUNT_FIVE = 5;
const HALF = 0.5;
const EXTERNAL = "external-worker";

const ZERO_VECTOR = Object.fromEntries(
  FLOW_VECTOR_COLUMNS.map((column) => [column, 0]),
) as FlowVector;

function row(overrides: Partial<FlowRow>): FlowRow {
  return {
    bucket_start: B0,
    changed_after_end: 0,
    project_id: "p1",
    worker_name: "w1",
    stage: FlowStage.Executing,
    exit: FlowExit.FurtherWork,
    stop_reason: "",
    cause_category: "",
    cause_detail: "",
    cause_assigner: "",
    ...ZERO_VECTOR,
    executions: 1,
    ...overrides,
  };
}

function usage(overrides: Partial<FlowUsageRow>): FlowUsageRow {
  return {
    bucket_start: B0,
    project_id: "p1",
    worker_name: "w1",
    model: "model_a",
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    unpriced_tokens: 0,
    ...overrides,
  };
}

const NO_ROWS = { current: [], previous: null };

test("the cost sections sum the usage rows and the flow rows of each window", () => {
  const rows = {
    current: [
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Completed,
        executions: COUNT_TWO,
        cost_usd: COUNT_FOUR,
      }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.External,
        cost_usd: COUNT_ONE,
      }),
      row({ exit: FlowExit.Stopped, cost_usd: COUNT_TWO }),
      row({ exit: FlowExit.Budget, cost_usd: 100 }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Blocked,
        cost_usd: COUNT_THREE,
      }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Rework,
        cost_usd: COUNT_FIVE,
      }),
    ],
    previous: [
      row({ bucket_start: B0 - HOUR, exit: FlowExit.Paused, cost_usd: HALF }),
    ],
  };
  const usageRows = {
    current: [
      usage({ cost_usd: 10 }),
      usage({ bucket_start: B1, cost_usd: 6 }),
    ],
    previous: [usage({ bucket_start: B0 - HOUR, cost_usd: COUNT_ONE })],
  };
  const cost = costOf({
    buckets: BUCKETS,
    rows,
    usage: usageRows,
    same_hour: null,
  });
  assert.deepEqual(cost.current, {
    total_usd: 16,
    success: COUNT_THREE,
    per_success_usd: 16 / COUNT_THREE,
    leaked_usd: COUNT_TWO + COUNT_THREE,
    rejected_review_usd: COUNT_THREE + COUNT_FIVE,
  });
  assert.deepEqual(cost.previous, {
    total_usd: COUNT_ONE,
    success: NO_COUNT,
    per_success_usd: null,
    leaked_usd: HALF,
    rejected_review_usd: NO_COUNT,
  });
  assert.deepEqual(cost.series, {
    total_usd: [10, 6],
    leaked_usd: [COUNT_FIVE, NO_COUNT],
    rejected_review_usd: [8, NO_COUNT],
    success: [COUNT_THREE, NO_COUNT],
  });
  assert.equal(cost.previous_same_hour, null);
});

test("the cost sections answer a null previous without a previous window", () => {
  const cost = costOf({
    buckets: BUCKETS,
    rows: NO_ROWS,
    usage: NO_ROWS,
    same_hour: null,
  });
  assert.equal(cost.previous, null);
  assert.deepEqual(cost.current.per_success_usd, null);
});

test("the same-hour sums read the same-hour rows and are null without a cut", () => {
  const sameHour = {
    rows: [
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Completed,
        executions: COUNT_TWO,
      }),
      row({ stage: FlowStage.Outcome, exit: FlowExit.Rework, cost_usd: 1.5 }),
      row({ exit: FlowExit.Stopped, cost_usd: 100 }),
    ],
    usage: [
      usage({ cost_usd: COUNT_THREE, input_tokens: 10, turn_count: COUNT_ONE }),
      usage({
        cost_usd: COUNT_FOUR,
        model: "model_b",
        project_id: "p2",
        worker_name: "w2",
      }),
    ],
  };
  const input = { buckets: BUCKETS, rows: NO_ROWS, usage: NO_ROWS };
  const cost = costOf({ ...input, same_hour: sameHour });
  assert.deepEqual(cost.previous_same_hour, {
    total_usd: 7,
    success: COUNT_TWO,
    rejected_review_usd: 1.5,
  });
  const read = usageOf({
    buckets: BUCKETS,
    rows: [],
    usage: {
      current: [
        usage({ cost_usd: 9 }),
        usage({ model: "model_b", cost_usd: 8 }),
        usage({ model: "model_c", cost_usd: 7 }),
      ],
      previous: null,
    },
    same_hour: sameHour,
  });
  assert.deepEqual(read.previous_same_hour, {
    turn_count: COUNT_ONE,
    input_tokens: 10,
    output_tokens: NO_COUNT,
    cache_read_tokens: NO_COUNT,
    cost_usd: 7,
    unpriced_tokens: NO_COUNT,
  });
  assert.deepEqual(
    read.by.model.map((item) => [item.key, item.previous_same_hour]),
    [
      ["model_a", { cost_usd: COUNT_THREE }],
      ["model_b", { cost_usd: COUNT_FOUR }],
      ["model_c", { cost_usd: NO_COUNT }],
    ],
  );
  assert.deepEqual(
    read.by.worker_name.map((item) => [item.key, item.previous_same_hour]),
    [["w1", { cost_usd: COUNT_THREE }]],
  );
  const none = usageOf({
    buckets: BUCKETS,
    rows: [],
    usage: { current: [usage({ cost_usd: 9 })], previous: null },
    same_hour: null,
  });
  assert.equal(none.previous_same_hour, null);
  assert.equal(none.by.model[0]?.previous_same_hour, null);
});

function causeRow(overrides: Partial<FlowRow>): FlowRow {
  return row({
    exit: FlowExit.Stopped,
    cause_category: "environment",
    cause_detail: "d1",
    cause_assigner: "rule",
    ...overrides,
  });
}

test("the cause rows sum by key and sort by count, stage rank, exit, category, detail and assigner", () => {
  const rows = {
    current: [
      causeRow({ executions: COUNT_TWO, cost_usd: 1 }),
      causeRow({ worker_name: "w2", cost_usd: HALF }),
      row({ stage: FlowStage.Verification, exit: FlowExit.Paused }),
      row({
        stage: FlowStage.Verification,
        exit: FlowExit.Budget,
        executions: COUNT_FIVE,
      }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Rework,
        executions: COUNT_THREE,
        cause_category: "plan",
        cause_detail: "decomposition",
        cause_assigner: "reviewer",
      }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Revoked,
        cause_category: "human",
        cause_assigner: "human",
      }),
      row({ exit: FlowExit.Open }),
      row({ stage: FlowStage.Outcome, exit: FlowExit.Completed }),
      row({ stage: FlowStageKey.None, exit: FlowExit.Stopped }),
    ],
    previous: null,
  };
  const {
    rows: caused,
    previous_rows: previous,
    truncated,
  } = causesOf(rows, BUCKETS);
  assert.deepEqual(caused, [
    {
      stage: "verification",
      exit: "budget",
      category: "",
      detail: "",
      assigner: "",
      count: COUNT_FIVE,
      cost_usd: NO_COUNT,
    },
    {
      stage: "executing",
      exit: "stopped",
      category: "environment",
      detail: "d1",
      assigner: "rule",
      count: COUNT_THREE,
      cost_usd: 1.5,
    },
    {
      stage: "outcome",
      exit: "rework",
      category: "plan",
      detail: "decomposition",
      assigner: "reviewer",
      count: COUNT_THREE,
      cost_usd: NO_COUNT,
    },
    {
      stage: "verification",
      exit: "paused",
      category: "",
      detail: "",
      assigner: "",
      count: COUNT_ONE,
      cost_usd: NO_COUNT,
    },
    {
      stage: "outcome",
      exit: "revoked",
      category: "human",
      detail: "",
      assigner: "human",
      count: COUNT_ONE,
      cost_usd: NO_COUNT,
    },
  ]);
  assert.equal(previous, null);
  assert.equal(truncated, false);
});

test("the previous cause rows sum by stage, exit and category", () => {
  const previous = [
    causeRow({
      bucket_start: B0 - HOUR,
      executions: COUNT_TWO,
      cause_detail: "a",
    }),
    causeRow({
      bucket_start: B0 - HOUR,
      cause_detail: "b",
      cause_assigner: "reviewer",
    }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Rework,
      cause_category: "unattributed",
    }),
    row({ stage: FlowStage.Verification, exit: FlowExit.Budget }),
    row({ exit: FlowExit.Open }),
  ];
  const result = causesOf({ current: [], previous }, BUCKETS);
  assert.deepEqual(result.previous_rows, [
    {
      stage: "executing",
      exit: "stopped",
      category: "environment",
      count: COUNT_THREE,
    },
    { stage: "verification", exit: "budget", category: "", count: COUNT_ONE },
    {
      stage: "outcome",
      exit: "rework",
      category: "unattributed",
      count: COUNT_ONE,
    },
  ]);
});

test("the cause lists cap at ANALYTICS_ITEMS_MAX and report truncated", () => {
  const distinct = (count: number, bucket: number) =>
    Array.from({ length: count }, (_, index) =>
      causeRow({
        bucket_start: bucket,
        cause_category: `category_${index}`,
        cause_detail: `detail_${index}`,
      }),
    );
  const exact = causesOf(
    { current: distinct(ANALYTICS_ITEMS_MAX, B0), previous: [] },
    BUCKETS,
  );
  assert.equal(exact.rows.length, ANALYTICS_ITEMS_MAX);
  assert.equal(exact.truncated, false);
  const current = causesOf(
    { current: distinct(ANALYTICS_ITEMS_MAX + COUNT_ONE, B0), previous: [] },
    BUCKETS,
  );
  assert.equal(current.rows.length, ANALYTICS_ITEMS_MAX);
  assert.equal(current.truncated, true);
  const previous = causesOf(
    {
      current: [],
      previous: distinct(ANALYTICS_ITEMS_MAX + COUNT_ONE, B0 - HOUR),
    },
    BUCKETS,
  );
  assert.equal(previous.previous_rows?.length, ANALYTICS_ITEMS_MAX);
  assert.equal(previous.truncated, true);
});

test("previous_unattributed_share leaves out the exit budget and is null with no caused row", () => {
  const unattributed = (overrides: Partial<FlowRow>) =>
    causeRow({ cause_category: "unattributed", ...overrides });
  const previous = [
    unattributed({}),
    causeRow({ executions: COUNT_THREE }),
    unattributed({ exit: FlowExit.Budget, executions: 10 }),
  ];
  assert.equal(
    causesOf({ current: [], previous }, BUCKETS).previous_unattributed_share,
    COUNT_ONE / COUNT_FOUR,
  );
  const onlyBudget = [unattributed({ exit: FlowExit.Budget })];
  assert.equal(
    causesOf({ current: [], previous: onlyBudget }, BUCKETS)
      .previous_unattributed_share,
    null,
  );
  assert.equal(
    causesOf({ current: [], previous: [] }, BUCKETS)
      .previous_unattributed_share,
    null,
  );
  assert.equal(causesOf(NO_ROWS, BUCKETS).previous_unattributed_share, null);
});

test("unattributed_share_series holds the share of each bucket and null for no caused row", () => {
  const rows = {
    current: [
      causeRow({ cause_category: "unattributed" }),
      row({
        stage: FlowStage.Outcome,
        exit: FlowExit.Rework,
        cause_category: "plan",
      }),
      causeRow({
        bucket_start: B2,
        exit: FlowExit.Budget,
        cause_category: "unattributed",
      }),
    ],
    previous: null,
  };
  const result = causesOf(rows, [B0, B1, B2]);
  assert.deepEqual(result.unattributed_share_series, [HALF, null, null]);
});

test("stop_reasons holds the order, a lost row, a budget_end row and the previous totals", () => {
  const expectedOrder = [
    ...Object.values(ExecutionStopReason).filter(
      (reason) => reason !== ExecutionStopReason.BudgetEnd,
    ),
    "lost",
    ExecutionStopReason.BudgetEnd,
  ];
  const rows = {
    current: [
      row({
        exit: FlowExit.Stopped,
        stop_reason: "operation_failed",
        executions: COUNT_TWO,
      }),
      row({ exit: FlowExit.Stopped, stop_reason: "lost" }),
      row({ exit: FlowExit.Budget, executions: COUNT_FOUR }),
      row({ exit: FlowExit.Stopped }),
      row({ exit: FlowExit.Paused, stop_reason: "operation_failed" }),
      row({
        bucket_start: B1,
        exit: FlowExit.Stopped,
        stop_reason: "operation_failed",
      }),
    ],
    previous: [
      row({
        bucket_start: B0 - HOUR,
        exit: FlowExit.Stopped,
        stop_reason: "no_progress",
        executions: COUNT_THREE,
      }),
      row({ bucket_start: B0 - HOUR, exit: FlowExit.Budget }),
      row({ bucket_start: B0 - HOUR, exit: FlowExit.Budget }),
    ],
  };
  const result = stopReasonsOf(rows, BUCKETS);
  assert.deepEqual(result.order, expectedOrder);
  assert.deepEqual(Object.keys(result.rows), expectedOrder);
  assert.deepEqual(result.rows[FlowStopReason.OperationFailed], [
    COUNT_TWO,
    COUNT_ONE,
  ]);
  assert.deepEqual(result.rows[FlowStopReason.Lost], [COUNT_ONE, NO_COUNT]);
  assert.deepEqual(result.rows[FlowStopReason.BudgetEnd], [
    COUNT_FOUR,
    NO_COUNT,
  ]);
  assert.deepEqual(result.rows[FlowStopReason.NoProgress], [
    NO_COUNT,
    NO_COUNT,
  ]);
  assert.deepEqual(result.previous_totals, {
    ...Object.fromEntries(expectedOrder.map((reason) => [reason, NO_COUNT])),
    no_progress: COUNT_THREE,
    budget_end: COUNT_TWO,
  });
  assert.equal(stopReasonsOf(NO_ROWS, BUCKETS).previous_totals, null);
});

test("usage holds the totals, the series and each list with success on the project rows only", () => {
  const usageRows = {
    current: [
      usage({
        turn_count: COUNT_TWO,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 40,
        cost_usd: COUNT_THREE,
        unpriced_tokens: COUNT_FIVE,
      }),
      usage({
        project_id: "p2",
        model: "model_b",
        turn_count: COUNT_ONE,
        output_tokens: 10,
        cost_usd: COUNT_ONE,
      }),
      usage({
        bucket_start: B1,
        worker_name: "w2",
        turn_count: COUNT_ONE,
        input_tokens: 200,
        output_tokens: 20,
        cache_read_tokens: 100,
        cost_usd: COUNT_TWO,
      }),
      usage({
        bucket_start: B1,
        project_id: "p3",
        worker_name: "w3",
        model: "model_c",
        input_tokens: 10,
        cost_usd: COUNT_ONE,
      }),
    ],
    previous: [
      usage({ bucket_start: B0 - HOUR, cost_usd: HALF, turn_count: COUNT_ONE }),
    ],
  };
  const rows = [
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Completed,
      executions: COUNT_TWO,
    }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.External,
      project_id: "p2",
    }),
    row({ stage: FlowStage.Outcome, exit: FlowExit.Rework, project_id: "p2" }),
  ];
  const result = usageOf({
    buckets: BUCKETS,
    rows,
    usage: usageRows,
    same_hour: null,
  });
  assert.deepEqual(result.current, {
    turn_count: COUNT_FOUR,
    input_tokens: 310,
    output_tokens: 80,
    cache_read_tokens: 140,
    cost_usd: 7,
    unpriced_tokens: COUNT_FIVE,
  });
  assert.equal(result.previous?.cost_usd, HALF);
  assert.deepEqual(result.series, {
    total_tokens: [160, 230],
    cache_hit: [0.4, 100 / 210],
    unpriced_tokens: [COUNT_FIVE, NO_COUNT],
  });
  assert.deepEqual(
    result.by.model.map((item) => [item.key, item.cost_usd]),
    [
      ["model_a", COUNT_FIVE],
      ["model_b", COUNT_ONE],
      ["model_c", COUNT_ONE],
    ],
  );
  const modelA = result.by.model[0];
  assert.deepEqual(modelA?.series, {
    cost_usd: [COUNT_THREE, COUNT_TWO],
    cache_hit: [0.4, HALF],
  });
  assert.equal(modelA?.turn_count, COUNT_THREE);
  assert.deepEqual(result.by.model[1]?.series, {
    cost_usd: [COUNT_ONE, NO_COUNT],
    cache_hit: [null, null],
  });
  assert.deepEqual(
    result.by.worker_name.map((item) => [item.key, item.cost_usd]),
    [
      ["w1", COUNT_FOUR],
      ["w2", COUNT_TWO],
      ["w3", COUNT_ONE],
    ],
  );
  assert.deepEqual(
    result.by.project_id.map((item) => [item.key, item.cost_usd, item.success]),
    [
      ["p1", COUNT_FIVE, COUNT_TWO],
      ["p2", COUNT_ONE, COUNT_ONE],
      ["p3", COUNT_ONE, NO_COUNT],
    ],
  );
  for (const item of [...result.by.model, ...result.by.worker_name])
    assert.equal("success" in item, false);
});

test("completeness reads the no-root rows and the workers that await ingestion", () => {
  const rows = [
    row({ exit: FlowExit.Open, executions: COUNT_TWO }),
    row({ stage: FlowStage.ReleaseGate, executions: COUNT_THREE }),
    row({
      stage: FlowStageKey.None,
      exit: FlowExit.Open,
      executions: COUNT_FOUR,
    }),
    row({ exit: FlowExit.Unknown }),
    row({
      stage: FlowStageKey.None,
      exit: FlowExit.Unknown,
      executions: COUNT_TWO,
    }),
    row({
      worker_name: EXTERNAL,
      executions: COUNT_TWO,
      awaiting_ingestion: COUNT_TWO,
      late_records: COUNT_ONE,
    }),
    row({
      worker_name: EXTERNAL,
      awaiting_ingestion: COUNT_ONE,
      late_records: COUNT_TWO,
    }),
    row({ worker_name: "alpha", awaiting_ingestion: COUNT_THREE }),
    row({ worker_name: "beta", awaiting_ingestion: COUNT_ONE }),
    row({ worker_name: "gamma" }),
  ];
  assert.deepEqual(completenessOf(rows), {
    executions: 12,
    open: COUNT_TWO,
    no_root: 6,
    exit_unknown: COUNT_THREE,
    awaiting_ingestion: [
      { worker_name: "alpha", count: COUNT_THREE },
      { worker_name: EXTERNAL, count: COUNT_THREE },
      { worker_name: "beta", count: COUNT_ONE },
    ],
    late_records: COUNT_THREE,
  });
});
