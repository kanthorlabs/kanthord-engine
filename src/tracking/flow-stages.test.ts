import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FlowDimensionBy,
  FlowExit,
  FlowGrain,
  FlowMeasure,
  FlowStage,
} from "./contract.ts";
import { BIN_COUNT, binOf, percentilesOf } from "./flow-bins.ts";
import {
  FLOW_VECTOR_COLUMNS,
  FlowStageKey,
  type FlowVector,
} from "./flow-model.ts";
import {
  type FlowHistogramRow,
  type FlowRow,
  stagesOf,
} from "./flow-stages.ts";

const HOUR = 3_600_000;
const FROM = 100 * HOUR;
const PROJECT_ONE = "p1";
const WORKER_TWO = "w2";
const HOSTED = "hosted-worker";
const EXTERNAL = "external-worker";
const NO_ROWS: FlowRow[] = [];
const NO_HISTOGRAMS: FlowHistogramRow[] = [];
const FIRST = FROM;
const SECOND = FROM + HOUR;
const NO_COUNT = 0;
const COUNT_ONE = 1;
const COUNT_TWO = 2;
const COUNT_THREE = 3;
const COUNT_FOUR = 4;
const COUNT_FIVE = 5;
const COUNT_EIGHT = 8;
const MEDIAN_ODD = 1;
const MEDIAN_EVEN = 2;
const BUCKETS_ODD = 3;
const BUCKETS_EVEN = 4;
const FRACTION_QUARTER = 0.25;
const SIGNAL_KEYS = {
  queued: [],
  executing: [
    "turns_per_execution",
    "tool_error_rate",
    "turn_rate_limited",
    "turn_quota_exhausted",
    "turn_unavailable",
    "turn_error_other",
    "leak_rate",
  ],
  verification: [
    "gate_routed",
    "affected_runs",
    "affected_failed",
    "affected_base_red",
    "affected_flaky_runs",
    "flaky_tests",
    "loops_per_entry",
    "affected_fail_rate",
    "flaky_run_share",
    "base_red_share",
    "budget",
    "unobserved",
    "unobserved_external",
    "unobserved_no_gate",
  ],
  release_gate: [
    "gate_affected_passed",
    "gate_affected_base_red",
    "gate_affected_absent",
    "leak_rate",
  ],
  evaluation: [
    "evaluation_time_p90",
    "evaluation_setup",
    "evaluation_verification",
    "evaluation_affected",
    "evaluation_judgement",
  ],
  outcome: [
    "success",
    "rework_rate",
    "blocked_rate",
    "blocked_rework_limit",
    "blocked_plan_defect",
  ],
};
const REMOVED_KEYS = [
  "tools_per_execution",
  "gate_runs",
  "review_wait_p50",
  "evaluation_time_p50",
  "blocked_none",
];

const ZERO_VECTOR = Object.fromEntries(
  FLOW_VECTOR_COLUMNS.map((column) => [column, 0]),
) as FlowVector;

function row(overrides: Partial<FlowRow>): FlowRow {
  return {
    bucket_start: FIRST,
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

function binsOf(values: readonly number[]): number[] {
  const bins = Array.from({ length: BIN_COUNT }, () => 0);
  for (const value of values)
    bins[binOf(value)] = (bins[binOf(value)] ?? 0) + 1;
  return bins;
}

function histogram(
  measure: FlowMeasure,
  values: readonly number[],
  overrides: Partial<FlowHistogramRow> = {},
): FlowHistogramRow {
  return {
    bucket_start: FIRST,
    project_id: "p1",
    worker_name: "w1",
    measure,
    bins: binsOf(values),
    ...overrides,
  };
}

function windows(count: number, hasPrevious = true) {
  const length = count * HOUR;
  return {
    grain: FlowGrain.Hour,
    window: {
      from: FROM,
      to: FROM + length,
      now: FROM + length,
      bucket: FlowGrain.Hour,
      buckets: Array.from({ length: count }, (_, index) => FROM + index * HOUR),
    },
    previous_window: hasPrevious ? { from: FROM - length, to: FROM } : null,
  };
}

function isHosted(workerName: string): boolean {
  return workerName === HOSTED;
}

function stageOf(
  rows: FlowRow[],
  stage: FlowStage,
  histograms: FlowHistogramRow[] = NO_HISTOGRAMS,
  count = COUNT_TWO,
) {
  const found = stagesOf(rows, histograms, windows(count), isHosted).find(
    (result) => result.stage === stage,
  );
  assert.ok(found);
  return found;
}

test("the answer holds the six stages in order", () => {
  const stages = stagesOf(NO_ROWS, NO_HISTOGRAMS, windows(COUNT_TWO), isHosted);
  assert.deepEqual(
    stages.map((stage) => stage.stage),
    [
      FlowStage.Queued,
      FlowStage.Executing,
      FlowStage.Verification,
      FlowStage.ReleaseGate,
      FlowStage.Evaluation,
      FlowStage.Outcome,
    ],
  );
});

const COUNT_ROWS = [
  row({ stage: FlowStage.Executing, exit: FlowExit.Open }),
  row({
    stage: FlowStage.Executing,
    exit: FlowExit.Stopped,
    executions: COUNT_TWO,
    cost_usd: 1.5,
  }),
  row({
    stage: FlowStage.Verification,
    exit: FlowExit.Budget,
    cost_usd: COUNT_TWO,
  }),
  row({
    stage: FlowStage.ReleaseGate,
    exit: FlowExit.HandedOn,
    unobserved: COUNT_ONE,
  }),
  row({
    stage: FlowStage.ReleaseGate,
    exit: FlowExit.FurtherWork,
    executions: COUNT_THREE,
  }),
  row({
    stage: FlowStage.Outcome,
    exit: FlowExit.Completed,
    executions: COUNT_TWO,
    cost_usd: COUNT_FOUR,
  }),
  row({ stage: FlowStage.Outcome, exit: FlowExit.Rework }),
  row({ stage: FlowStage.Evaluation, exit: FlowExit.Open }),
  row({
    stage: FlowStageKey.None,
    exit: FlowExit.Unknown,
    executions: COUNT_FIVE,
  }),
];

test("queued counts every stage of the kind steps and has no exit", () => {
  const { current } = stageOf(COUNT_ROWS, FlowStage.Queued);
  assert.equal(current.entered, COUNT_EIGHT);
  assert.deepEqual(current.exits, {});
  assert.deepEqual(current.signals, {});
});

test("executing counts the unobserved execution", () => {
  const { current } = stageOf(COUNT_ROWS, FlowStage.Executing);
  assert.equal(current.entered, COUNT_EIGHT);
  assert.equal(current.unobserved, NO_COUNT);
  assert.equal(current.open, COUNT_ONE);
  assert.deepEqual(current.exits, {
    open: { count: COUNT_ONE, cost_usd: 0 },
    stopped: { count: COUNT_TWO, cost_usd: 1.5 },
  });
});

test("verification does not count the unobserved execution", () => {
  const { current } = stageOf(COUNT_ROWS, FlowStage.Verification);
  assert.equal(current.entered, COUNT_FOUR);
  assert.equal(current.unobserved, COUNT_ONE);
  assert.equal(current.open, NO_COUNT);
  assert.deepEqual(current.exits, {
    budget: { count: COUNT_ONE, cost_usd: COUNT_TWO },
  });
});

test("release_gate does not count the unobserved execution", () => {
  const { current } = stageOf(COUNT_ROWS, FlowStage.ReleaseGate);
  assert.equal(current.entered, COUNT_THREE);
  assert.equal(current.unobserved, COUNT_ONE);
  assert.deepEqual(current.exits, {
    handed_on: { count: COUNT_ONE, cost_usd: 0 },
    further_work: { count: COUNT_THREE, cost_usd: 0 },
  });
});

test("evaluation and outcome read the rows of the kind evaluation", () => {
  const evaluation = stageOf(COUNT_ROWS, FlowStage.Evaluation).current;
  assert.equal(evaluation.entered, COUNT_FOUR);
  assert.equal(evaluation.open, COUNT_ONE);
  assert.equal(evaluation.unobserved, NO_COUNT);
  const outcome = stageOf(COUNT_ROWS, FlowStage.Outcome).current;
  assert.equal(outcome.entered, COUNT_THREE);
  assert.deepEqual(outcome.exits, {
    completed: { count: COUNT_TWO, cost_usd: COUNT_FOUR },
    rework: { count: COUNT_ONE, cost_usd: 0 },
  });
});

test("a row of the stage none counts at no stage", () => {
  const rows = [
    row({
      stage: FlowStageKey.None,
      exit: FlowExit.Unknown,
      executions: COUNT_FIVE,
    }),
  ];
  const stages = stagesOf(rows, NO_HISTOGRAMS, windows(COUNT_TWO), isHosted);
  for (const stage of stages) {
    assert.equal(stage.current.entered, NO_COUNT);
    assert.deepEqual(stage.current.exits, {});
    assert.deepEqual(stage.dimensions, []);
  }
});

test("the time of a stage is the percentile result of its measure over the merged bins", () => {
  const first = [100, 200, 300];
  const second = [5000, 6000];
  const histograms = [
    histogram(FlowMeasure.ExecutionTime, first),
    histogram(FlowMeasure.ExecutionTime, second, { project_id: "p2" }),
    histogram(FlowMeasure.QueueWait, [COUNT_ONE]),
  ];
  const stages = stagesOf(NO_ROWS, histograms, windows(COUNT_TWO), isHosted);
  const time = (stage: FlowStage) =>
    stages.find((result) => result.stage === stage)?.current.time;
  assert.deepEqual(
    time(FlowStage.Executing),
    percentilesOf(binsOf([...first, ...second])),
  );
  assert.deepEqual(time(FlowStage.Queued), percentilesOf(binsOf([COUNT_ONE])));
  assert.equal(time(FlowStage.Verification), null);
});

test("each stage reads its own measure", () => {
  const measures: [FlowStage, FlowMeasure][] = [
    [FlowStage.Queued, FlowMeasure.QueueWait],
    [FlowStage.Executing, FlowMeasure.ExecutionTime],
    [FlowStage.Verification, FlowMeasure.VerificationRunTime],
    [FlowStage.ReleaseGate, FlowMeasure.GateRunTime],
    [FlowStage.Evaluation, FlowMeasure.ReviewWait],
    [FlowStage.Outcome, FlowMeasure.LeadTime],
  ];
  for (const [stage, measure] of measures) {
    const result = stageOf(NO_ROWS, stage, [histogram(measure, [1000])]);
    assert.equal(result.current.time?.count, COUNT_ONE);
  }
});

test("the executing signals follow the table", () => {
  const rows = [
    row({
      executions: COUNT_TWO,
      turn_count: 6,
      tool_count: 10,
      tool_error_count: COUNT_ONE,
      turn_rate_limited: COUNT_ONE,
      turn_quota_exhausted: COUNT_TWO,
      turn_unavailable: COUNT_THREE,
      turn_error_other: COUNT_FOUR,
    }),
    row({
      exit: FlowExit.Open,
      turn_count: 100,
      tool_count: 10,
      tool_error_count: COUNT_FOUR,
    }),
    row({ exit: FlowExit.Stopped, turn_count: COUNT_TWO }),
  ];
  const { signals } = stageOf(rows, FlowStage.Executing).current;
  assert.deepEqual(signals, {
    turns_per_execution: (6 + COUNT_TWO) / (COUNT_TWO + COUNT_ONE),
    tool_error_rate: FRACTION_QUARTER,
    turn_rate_limited: COUNT_ONE,
    turn_quota_exhausted: COUNT_TWO,
    turn_unavailable: COUNT_THREE,
    turn_error_other: COUNT_FOUR,
    leak_rate: COUNT_ONE / (COUNT_FOUR - COUNT_ONE),
  });
});

test("the verification signals follow the table and split the unobserved executions by worker", () => {
  const rows = [
    row({
      stage: FlowStage.Verification,
      executions: COUNT_FOUR,
      gate_routed: 6,
      affected_runs: 10,
      affected_failed: COUNT_TWO,
      affected_base_red: COUNT_ONE,
      affected_flaky_runs: COUNT_THREE,
      flaky_tests: COUNT_FIVE,
    }),
    row({ stage: FlowStage.Verification, exit: FlowExit.Budget }),
    row({
      stage: FlowStage.ReleaseGate,
      exit: FlowExit.HandedOn,
      worker_name: HOSTED,
      unobserved: COUNT_ONE,
    }),
    row({
      stage: FlowStage.ReleaseGate,
      exit: FlowExit.HandedOn,
      worker_name: EXTERNAL,
      executions: COUNT_TWO,
      unobserved: COUNT_TWO,
    }),
  ];
  const { signals } = stageOf(rows, FlowStage.Verification).current;
  assert.deepEqual(signals, {
    gate_routed: 6,
    affected_runs: 10,
    affected_failed: COUNT_TWO,
    affected_base_red: COUNT_ONE,
    affected_flaky_runs: COUNT_THREE,
    flaky_tests: COUNT_FIVE,
    loops_per_entry: 6 / COUNT_FIVE,
    affected_fail_rate: COUNT_TWO / 10,
    flaky_run_share: COUNT_THREE / 10,
    base_red_share: COUNT_ONE / 10,
    budget: COUNT_ONE,
    unobserved: COUNT_THREE,
    unobserved_external: COUNT_TWO,
    unobserved_no_gate: COUNT_ONE,
  });
});

test("the release_gate signals follow the table", () => {
  const rows = [
    row({
      stage: FlowStage.ReleaseGate,
      executions: COUNT_FOUR,
      gate_affected_passed: COUNT_TWO,
      gate_affected_base_red: COUNT_ONE,
      gate_affected_absent: COUNT_ONE,
    }),
    row({
      stage: FlowStage.ReleaseGate,
      exit: FlowExit.Paused,
      gate_affected_absent: COUNT_ONE,
    }),
  ];
  const { signals } = stageOf(rows, FlowStage.ReleaseGate).current;
  assert.deepEqual(signals, {
    gate_affected_passed: COUNT_TWO,
    gate_affected_base_red: COUNT_ONE,
    gate_affected_absent: COUNT_TWO,
    leak_rate: COUNT_ONE / COUNT_FIVE,
  });
});

test("the evaluation signals count the rejected rows and read the p90 of evaluation_time", () => {
  const rows = [
    row({ stage: FlowStage.Evaluation, exit: FlowExit.Open }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Rework,
      executions: COUNT_TWO,
      evaluation_setup: COUNT_TWO,
      evaluation_judgement: COUNT_ONE,
    }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Blocked,
      evaluation_verification: COUNT_ONE,
      evaluation_affected: COUNT_ONE,
    }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Completed,
      evaluation_setup: COUNT_ONE,
    }),
  ];
  const values = [1000, 2000, 4000];
  const { signals } = stageOf(rows, FlowStage.Evaluation, [
    histogram(FlowMeasure.EvaluationTime, values),
    histogram(FlowMeasure.ReviewWait, [COUNT_ONE]),
  ]).current;
  assert.deepEqual(signals, {
    evaluation_time_p90: percentilesOf(binsOf(values)).p90,
    evaluation_setup: COUNT_TWO,
    evaluation_verification: COUNT_ONE,
    evaluation_affected: COUNT_ONE,
    evaluation_judgement: COUNT_ONE,
  });
});

test("the outcome signals follow the table", () => {
  const rows = [
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Completed,
      executions: COUNT_THREE,
    }),
    row({ stage: FlowStage.Outcome, exit: FlowExit.External }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Rework,
      executions: COUNT_TWO,
    }),
    row({
      stage: FlowStage.Outcome,
      exit: FlowExit.Blocked,
      blocked_rework_limit: COUNT_ONE,
      blocked_plan_defect: COUNT_ONE,
    }),
  ];
  const { signals } = stageOf(rows, FlowStage.Outcome).current;
  assert.deepEqual(signals, {
    success: COUNT_FOUR,
    rework_rate: COUNT_TWO / (COUNT_FOUR + COUNT_TWO + COUNT_ONE),
    blocked_rate: COUNT_ONE / (COUNT_FOUR + COUNT_TWO + COUNT_ONE),
    blocked_rework_limit: COUNT_ONE,
    blocked_plan_defect: COUNT_ONE,
  });
});

test("a ratio with a denominator of 0 has no key in a window and a null in a series", () => {
  const executing = stageOf(NO_ROWS, FlowStage.Executing);
  assert.deepEqual(Object.keys(executing.current.signals).sort(), [
    "turn_error_other",
    "turn_quota_exhausted",
    "turn_rate_limited",
    "turn_unavailable",
  ]);
  assert.deepEqual(executing.series.signals["leak_rate"], [null, null]);
  assert.deepEqual(executing.series.signals["turns_per_execution"], [
    null,
    null,
  ]);
  assert.deepEqual(executing.series.signals["turn_rate_limited"], [0, 0]);
});

test("the series of each stage holds each signal key of the table", () => {
  const stages = stagesOf(NO_ROWS, NO_HISTOGRAMS, windows(COUNT_TWO), isHosted);
  for (const stage of stages)
    assert.deepEqual(
      Object.keys(stage.series.signals).sort(),
      [...SIGNAL_KEYS[stage.stage]].sort(),
    );
});

test("no stage carries a removed signal key", () => {
  const rows = COUNT_ROWS;
  for (const stage of stagesOf(
    rows,
    NO_HISTOGRAMS,
    windows(COUNT_TWO),
    isHosted,
  )) {
    for (const key of REMOVED_KEYS) {
      assert.equal(key in stage.current.signals, false);
      assert.equal(key in stage.series.signals, false);
    }
  }
});

test("the series holds one value for each bucket with changed_after_end", () => {
  const rows = [
    row({ bucket_start: FIRST, exit: FlowExit.Open }),
    row({
      bucket_start: FIRST,
      stage: FlowStage.Verification,
      changed_after_end: COUNT_ONE,
    }),
    row({
      bucket_start: SECOND,
      exit: FlowExit.Stopped,
      executions: COUNT_TWO,
      changed_after_end: COUNT_ONE,
    }),
    row({
      bucket_start: SECOND,
      exit: FlowExit.Budget,
    }),
  ];
  const histograms = [
    histogram(FlowMeasure.ExecutionTime, [1000], { bucket_start: SECOND }),
  ];
  const { series } = stageOf(rows, FlowStage.Executing, histograms);
  assert.deepEqual(series.entered, [COUNT_TWO, COUNT_THREE]);
  assert.deepEqual(series.open, [COUNT_ONE, 0]);
  assert.deepEqual(series.leaked, [0, COUNT_TWO]);
  assert.deepEqual(series.loops, [0, COUNT_ONE]);
  assert.deepEqual(series.time_p90, [null, percentilesOf(binsOf([1000])).p90]);
  assert.deepEqual(series.changed_after_end, [false, true]);
  assert.deepEqual(series.signals["leak_rate"], [0, COUNT_TWO / COUNT_THREE]);
  assert.deepEqual(series.signals["turn_rate_limited"], [0, 0]);
});

test("the dimensions list each project and worker by entered, by and key", () => {
  const rows = [
    row({ project_id: "p1", worker_name: "w1", executions: COUNT_THREE }),
    row({ project_id: "p1", worker_name: "w2" }),
    row({ project_id: "p2", worker_name: "w3", executions: COUNT_TWO }),
    row({ project_id: "p3", worker_name: "w4", executions: COUNT_TWO }),
    row({
      bucket_start: FROM - HOUR,
      project_id: "p9",
      worker_name: "w9",
      executions: COUNT_FIVE,
    }),
    row({
      project_id: "p1",
      worker_name: "w1",
      exit: FlowExit.Stopped,
      executions: COUNT_ONE,
    }),
  ];
  const { dimensions } = stageOf(rows, FlowStage.Executing);
  assert.deepEqual(
    dimensions.map((item) => [item.by, item.key, item.entered]),
    [
      ["project_id", "p1", COUNT_FIVE],
      ["worker_name", "w1", COUNT_FOUR],
      ["project_id", "p2", COUNT_TWO],
      ["project_id", "p3", COUNT_TWO],
      ["worker_name", "w3", COUNT_TWO],
      ["worker_name", "w4", COUNT_TWO],
      ["worker_name", "w2", COUNT_ONE],
    ],
  );
});

test("a dimension reads the rows and the histogram rows of its key", () => {
  const rows = [
    row({ project_id: "p1", worker_name: "w1", executions: COUNT_THREE }),
    row({
      project_id: "p1",
      worker_name: "w1",
      exit: FlowExit.Paused,
      executions: COUNT_ONE,
    }),
    row({ project_id: "p2", worker_name: "w2", executions: COUNT_TWO }),
  ];
  const histograms = [
    histogram(FlowMeasure.ExecutionTime, [100, 200], { project_id: "p1" }),
    histogram(FlowMeasure.ExecutionTime, [90000], {
      project_id: "p2",
      worker_name: "w2",
    }),
  ];
  const { dimensions } = stageOf(rows, FlowStage.Executing, histograms);
  const item = dimensions.find(
    (candidate) =>
      candidate.by === FlowDimensionBy.ProjectId &&
      candidate.key === PROJECT_ONE,
  );
  assert.ok(item);
  assert.equal(item.leaked, COUNT_ONE);
  assert.equal(item.loops, COUNT_THREE);
  assert.deepEqual(item.time, percentilesOf(binsOf([100, 200])));
  assert.equal(item.signals["leak_rate"], COUNT_ONE / COUNT_FOUR);
  const workerItem = dimensions.find(
    (candidate) =>
      candidate.by === FlowDimensionBy.WorkerName &&
      candidate.key === WORKER_TWO,
  );
  assert.deepEqual(workerItem?.time, percentilesOf(binsOf([90000])));
});

test("a worker with unobserved executions and no entered has a dimension at verification and release_gate", () => {
  const rows = [
    row({
      stage: FlowStage.ReleaseGate,
      exit: FlowExit.HandedOn,
      worker_name: EXTERNAL,
      unobserved: COUNT_ONE,
    }),
  ];
  for (const stage of [FlowStage.Verification, FlowStage.ReleaseGate]) {
    const { dimensions } = stageOf(rows, stage);
    assert.equal(dimensions.length, COUNT_ONE);
    const [item] = dimensions;
    assert.equal(item?.by, FlowDimensionBy.WorkerName);
    assert.equal(item?.key, EXTERNAL);
    assert.equal(item?.entered, NO_COUNT);
  }
  const verification = stageOf(rows, FlowStage.Verification).dimensions[0];
  assert.equal(verification?.signals["unobserved_external"], COUNT_ONE);
  const executing = stageOf(rows, FlowStage.Executing).dimensions;
  assert.equal(executing.length, COUNT_TWO);
});

test("the previous window holds the rows before window.from and is null without a previous window", () => {
  const rows = [
    row({ bucket_start: FROM - HOUR, executions: COUNT_THREE }),
    row({ executions: COUNT_TWO }),
  ];
  const result = stageOf(rows, FlowStage.Executing);
  assert.equal(result.current.entered, COUNT_TWO);
  assert.equal(result.previous?.entered, COUNT_THREE);
  const without = stagesOf(
    rows,
    NO_HISTOGRAMS,
    windows(COUNT_TWO, false),
    isHosted,
  );
  for (const stage of without) {
    assert.equal(stage.previous, null);
    assert.equal(stage.previous_bucket_median, null);
  }
});

function previousRows(values: readonly number[]): FlowRow[] {
  return values.flatMap((value, index) =>
    value === NO_COUNT
      ? []
      : [
          row({
            bucket_start: FROM - (values.length - index) * HOUR,
            turn_rate_limited: value,
            turn_quota_exhausted: value * COUNT_TWO,
          }),
        ],
  );
}

test("previous_bucket_median is the median of an odd count of previous buckets with a bucket of no row as 0", () => {
  const result = stageOf(
    previousRows([COUNT_FIVE, 0, COUNT_ONE]),
    FlowStage.Executing,
    NO_HISTOGRAMS,
    BUCKETS_ODD,
  );
  assert.deepEqual(result.previous_bucket_median, {
    turn_rate_limited: MEDIAN_ODD,
    turn_quota_exhausted: MEDIAN_EVEN,
    turn_unavailable: 0,
  });
});

test("previous_bucket_median is the mean of the two middle values for an even count", () => {
  const result = stageOf(
    previousRows([COUNT_FIVE, 0, COUNT_ONE, COUNT_THREE]),
    FlowStage.Executing,
    NO_HISTOGRAMS,
    BUCKETS_EVEN,
  );
  assert.deepEqual(result.previous_bucket_median, {
    turn_rate_limited: MEDIAN_EVEN,
    turn_quota_exhausted: MEDIAN_EVEN * COUNT_TWO,
    turn_unavailable: 0,
  });
});

test("previous_bucket_median is empty for the other stages", () => {
  const rows = previousRows([COUNT_FIVE, COUNT_ONE]);
  for (const stage of [
    FlowStage.Queued,
    FlowStage.Verification,
    FlowStage.ReleaseGate,
    FlowStage.Evaluation,
    FlowStage.Outcome,
  ])
    assert.deepEqual(stageOf(rows, stage).previous_bucket_median, {});
});
