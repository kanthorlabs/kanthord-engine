import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AnalyticsFlowQuery,
  analyticsFlowQuerySchema,
  FlowCompare,
  FlowExit,
  FlowGrain,
  flowReadSchema,
  FlowStage,
  FlowStopReason,
} from "./contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { flowWindowOf } from "./flow-window.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D0 = Date.UTC(2024, 5, 15);
const NOW = D0 + 10 * HOUR + 30 * 60_000;
const NOW_ON_HOUR = D0 + 10 * HOUR;
const COVERED = 0;
const RANGE_INVALID = "tracking.filter.range_invalid";
const HOURS_IN_TWO_DAYS_PLUS_ONE = 49;
const FOUR_BUCKETS = 4;
const DAYS_PER_WEEK = 7;

function query(overrides: Partial<AnalyticsFlowQuery>): AnalyticsFlowQuery {
  return { compare: FlowCompare.Previous, ...overrides };
}

function isRangeInvalid(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === RANGE_INVALID &&
    "status" in error &&
    error.status === HttpStatus.BadRequest
  );
}

function refuses(overrides: Partial<AnalyticsFlowQuery>): void {
  assert.throws(
    () => flowWindowOf(query(overrides), NOW, COVERED),
    isRangeInvalid,
  );
}

test("a range of 2 days defaults to the hour bucket and ends at the time of the read", () => {
  const { grain, window } = flowWindowOf(
    query({ from: NOW - 2 * DAY }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Hour);
  assert.equal(window.bucket, FlowGrain.Hour);
  assert.equal(window.from, NOW_ON_HOUR - 2 * DAY);
  assert.equal(window.to, NOW_ON_HOUR + HOUR);
  assert.equal(window.now, NOW);
  assert.equal(window.buckets.length, HOURS_IN_TWO_DAYS_PLUS_ONE);
});

test("a range of 3 days defaults to the day bucket", () => {
  const { grain, window } = flowWindowOf(
    query({ from: NOW - 3 * DAY }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Day);
  assert.equal(window.from, D0 - 3 * DAY);
  assert.equal(window.to, D0 + DAY);
  assert.deepEqual(window.buckets, [D0 - 3 * DAY, D0 - 2 * DAY, D0 - DAY, D0]);
});

test("a query with no range reads 7 days back from the time of the read by day", () => {
  const { grain, window } = flowWindowOf(query({}), NOW, COVERED);
  assert.equal(grain, FlowGrain.Day);
  assert.equal(window.from, D0 - DAYS_PER_WEEK * DAY);
  assert.equal(window.now, NOW);
});

test("a query with only to reads 7 days back from to", () => {
  const to = D0 - 2 * DAY;
  const { window } = flowWindowOf(query({ to }), NOW, COVERED);
  assert.equal(window.from, to - DAYS_PER_WEEK * DAY);
  assert.equal(window.to, to);
});

test("a range of 31 days passes and 31 days plus 1 ms is refused", () => {
  const { grain } = flowWindowOf(
    query({ from: NOW - 31 * DAY, to: NOW }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Day);
  refuses({ from: NOW - 31 * DAY - 1, to: NOW });
});

test("the bucket hour passes with 2 days and is refused with 2 days plus 1 ms", () => {
  const { grain } = flowWindowOf(
    query({ from: NOW - 2 * DAY, to: NOW, bucket: FlowGrain.Hour }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Hour);
  refuses({ from: NOW - 2 * DAY - 1, to: NOW, bucket: FlowGrain.Hour });
});

test("the bucket day takes a range of 2 days or less", () => {
  const { grain } = flowWindowOf(
    query({ from: NOW - DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(grain, FlowGrain.Day);
});

test("a from after to is refused", () => {
  refuses({ from: NOW, to: NOW - 1 });
});

test("the hour grain floors from, ceils to and lists each bucket start", () => {
  const { window } = flowWindowOf(
    query({
      from: D0 + 10 * HOUR + 15 * 60_000,
      to: D0 + 13 * HOUR + 5 * 60_000,
    }),
    NOW,
    COVERED,
  );
  assert.equal(window.from, D0 + 10 * HOUR);
  assert.equal(window.to, D0 + 14 * HOUR);
  assert.deepEqual(window.buckets, [
    D0 + 10 * HOUR,
    D0 + 11 * HOUR,
    D0 + 12 * HOUR,
    D0 + 13 * HOUR,
  ]);
});

test("a to on a bucket boundary stays", () => {
  const { window } = flowWindowOf(
    query({ from: D0 + 10 * HOUR, to: D0 + 13 * HOUR }),
    NOW,
    COVERED,
  );
  assert.equal(window.to, D0 + 13 * HOUR);
  assert.equal(window.buckets.length, FOUR_BUCKETS - 1);
});

test("the day grain floors from, ceils to and lists each bucket start", () => {
  const { window } = flowWindowOf(
    query({
      from: D0 - 5 * DAY + 5 * HOUR,
      to: D0 - 3 * DAY + 5 * HOUR,
      bucket: FlowGrain.Day,
    }),
    NOW,
    COVERED,
  );
  assert.equal(window.from, D0 - 5 * DAY);
  assert.equal(window.to, D0 - 2 * DAY);
  assert.deepEqual(window.buckets, [D0 - 5 * DAY, D0 - 4 * DAY, D0 - 3 * DAY]);
});

test("window.now is to for a to in the past and the time of the read for a later to", () => {
  const past = flowWindowOf(
    query({ from: D0 + 2 * HOUR, to: D0 + 5 * HOUR + 1 }),
    NOW,
    COVERED,
  );
  assert.equal(past.window.now, D0 + 5 * HOUR + 1);
  assert.ok(past.window.now < past.window.to);
  const later = flowWindowOf(
    query({ from: D0 + 2 * HOUR, to: D0 + 14 * HOUR }),
    NOW,
    COVERED,
  );
  assert.equal(later.window.now, NOW);
});

test("the previous window of the hour grain ends where the window starts", () => {
  const { previous_window } = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR }),
    NOW,
    COVERED,
  );
  assert.deepEqual(previous_window, {
    from: D0 + 2 * HOUR,
    to: D0 + 6 * HOUR,
  });
});

test("the previous window of the day grain ends where the window starts", () => {
  const { previous_window } = flowWindowOf(
    query({ from: D0 - 4 * DAY, to: D0 - DAY }),
    NOW,
    COVERED,
  );
  assert.deepEqual(previous_window, {
    from: D0 - 7 * DAY,
    to: D0 - 4 * DAY,
  });
});

test("compare none answers a null previous window and a null cut", () => {
  const result = flowWindowOf(
    query({ from: D0 - 4 * DAY, compare: FlowCompare.None }),
    NOW,
    COVERED,
  );
  assert.equal(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the previous window of the hour grain is null before the cutoff of 8 days", () => {
  const cutoff = NOW_ON_HOUR - 8 * DAY;
  const at = flowWindowOf(
    query({ from: cutoff + 4 * HOUR, to: cutoff + 8 * HOUR }),
    NOW_ON_HOUR,
    COVERED,
  );
  assert.deepEqual(at.previous_window, { from: cutoff, to: cutoff + 4 * HOUR });
  const before = flowWindowOf(
    query({ from: cutoff + 3 * HOUR, to: cutoff + 7 * HOUR }),
    NOW_ON_HOUR,
    COVERED,
  );
  assert.equal(before.previous_window, null);
});

test("the previous window of the day grain is null before the cutoff of 64 days", () => {
  const at = flowWindowOf(
    query({ from: D0 - 62 * DAY, to: D0 - 61 * DAY, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.deepEqual(at.previous_window, {
    from: D0 - 63 * DAY,
    to: D0 - 62 * DAY,
  });
  const before = flowWindowOf(
    query({ from: D0 - 63 * DAY, to: D0 - 62 * DAY, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(before.previous_window, null);
});

test("the previous window is null before the coverage start of its grain", () => {
  const input = query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR });
  const start = D0 + 2 * HOUR;
  assert.notEqual(flowWindowOf(input, NOW, start).previous_window, null);
  assert.equal(flowWindowOf(input, NOW, start + 1).previous_window, null);
});

test("the previous window is null when the grain holds no row", () => {
  const result = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 10 * HOUR }),
    NOW,
    null,
  );
  assert.equal(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the cut of the hour grain inside an hour ends the hour of window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 14 * HOUR }),
    NOW,
    COVERED,
  );
  assert.equal(result.cut, D0 + 11 * HOUR - 8 * HOUR);
});

test("the cut of the hour grain on an hour boundary ends at window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 + 6 * HOUR, to: D0 + 14 * HOUR }),
    NOW_ON_HOUR,
    COVERED,
  );
  assert.equal(result.cut, D0 + 10 * HOUR - 8 * HOUR);
});

test("the cut of the day grain inside an hour ends the hour of window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 - 6 * DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(result.window.to - result.window.from, 7 * DAY);
  assert.equal(result.cut, D0 + 11 * HOUR - 7 * DAY);
});

test("the cut of the day grain on an hour boundary ends at window.now", () => {
  const result = flowWindowOf(
    query({ from: D0 - 6 * DAY, to: NOW_ON_HOUR, bucket: FlowGrain.Day }),
    NOW_ON_HOUR,
    COVERED,
  );
  assert.equal(result.cut, D0 + 10 * HOUR - 7 * DAY);
});

test("the cut of the day grain is null when a window of 8 days needs expired hour rows", () => {
  const result = flowWindowOf(
    query({ from: D0 - 7 * DAY, to: NOW, bucket: FlowGrain.Day }),
    NOW,
    COVERED,
  );
  assert.equal(result.window.to - result.window.from, 8 * DAY);
  assert.notEqual(result.previous_window, null);
  assert.equal(result.cut, null);
});

test("the cut of the day grain on a day boundary needs no hour rows", () => {
  const result = flowWindowOf(
    query({ from: D0 - 30 * DAY, to: D0, bucket: FlowGrain.Day }),
    D0,
    COVERED,
  );
  assert.equal(result.cut, D0 - 30 * DAY);
});

test("the query schema defaults compare and refuses an unknown value of a closed set", () => {
  assert.equal(
    analyticsFlowQuerySchema.parse({}).compare,
    FlowCompare.Previous,
  );
  assert.equal(
    analyticsFlowQuerySchema.safeParse({ bucket: "week" }).success,
    false,
  );
  assert.equal(
    analyticsFlowQuerySchema.safeParse({ compare: "next" }).success,
    false,
  );
  assert.equal(
    analyticsFlowQuerySchema.safeParse({ worker_name: "x".repeat(257) })
      .success,
    false,
  );
  assert.equal(analyticsFlowQuerySchema.safeParse({ extra: 1 }).success, false);
});

const percentiles = { count: 1, p50: 1, p90: 1, p99: 1 };
const stageWindow = {
  entered: 1,
  unobserved: 0,
  open: 0,
  exits: { stopped: { count: 1, cost_usd: 1 } },
  time: percentiles,
  signals: { leak_rate: 1 },
};
const usageTotals = {
  turn_count: 1,
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 1,
  cost_usd: 1,
  unpriced_tokens: 1,
};
const usageRow = {
  ...usageTotals,
  key: "k",
  success: 1,
  previous_same_hour: { cost_usd: 1 },
  series: { cost_usd: [1], cache_hit: [null] },
};
const costWindow = {
  total_usd: 1,
  success: 1,
  per_success_usd: 1,
  leaked_usd: 1,
  rejected_review_usd: 1,
};
const flowRead = {
  window: {
    from: 0,
    to: HOUR,
    now: HOUR,
    bucket: FlowGrain.Hour,
    buckets: [0],
  },
  previous_window: { from: -HOUR, to: 0 },
  percentile_method: "log_bins_4",
  stages: [
    {
      stage: FlowStage.Executing,
      current: stageWindow,
      previous: stageWindow,
      series: {
        entered: [1],
        open: [0],
        leaked: [1],
        loops: [0],
        time_p90: [1],
        signals: { leak_rate: [1] },
        changed_after_end: [false],
      },
      dimensions: [
        {
          by: "project_id",
          key: "p",
          entered: 1,
          leaked: 0,
          loops: 0,
          time: percentiles,
          signals: {},
        },
      ],
      previous_bucket_median: { turn_rate_limited: 0 },
    },
  ],
  cost: {
    current: costWindow,
    previous: costWindow,
    previous_same_hour: { total_usd: 1, success: 1, rejected_review_usd: 1 },
    series: {
      total_usd: [1],
      leaked_usd: [1],
      rejected_review_usd: [1],
      success: [1],
    },
  },
  causes: {
    rows: [
      {
        stage: FlowStage.Executing,
        exit: FlowExit.Stopped,
        category: "c",
        detail: "d",
        assigner: "rule",
        count: 1,
        cost_usd: 1,
      },
    ],
    previous_rows: [
      {
        stage: FlowStage.Executing,
        exit: FlowExit.Stopped,
        category: "c",
        count: 1,
      },
    ],
    previous_unattributed_share: 0.5,
    unattributed_share_series: [null],
    truncated: false,
  },
  stop_reasons: {
    order: Object.values(FlowStopReason),
    rows: Object.fromEntries(
      Object.values(FlowStopReason).map((reason) => [reason, [1]]),
    ),
    previous_totals: Object.fromEntries(
      Object.values(FlowStopReason).map((reason) => [reason, 1]),
    ),
  },
  usage: {
    current: usageTotals,
    previous: usageTotals,
    previous_same_hour: usageTotals,
    series: { total_tokens: [1], cache_hit: [null], unpriced_tokens: [1] },
    by: { model: [usageRow], worker_name: [usageRow], project_id: [usageRow] },
  },
  completeness: {
    executions: 1,
    open: 0,
    no_root: 0,
    exit_unknown: 0,
    awaiting_ingestion: [{ worker_name: "w", count: 1 }],
    late_records: 0,
  },
  rebuild: { pending_until: 1 },
};
const OBJECT_PATHS = [
  "",
  "window",
  "previous_window",
  "stages.0",
  "stages.0.current",
  "stages.0.current.exits.stopped",
  "stages.0.current.time",
  "stages.0.series",
  "stages.0.dimensions.0",
  "stages.0.dimensions.0.time",
  "cost",
  "cost.current",
  "cost.previous_same_hour",
  "cost.series",
  "causes",
  "causes.rows.0",
  "causes.previous_rows.0",
  "stop_reasons",
  "usage",
  "usage.current",
  "usage.series",
  "usage.by",
  "usage.by.model.0",
  "usage.by.model.0.previous_same_hour",
  "usage.by.model.0.series",
  "completeness",
  "completeness.awaiting_ingestion.0",
  "rebuild",
];

function withExtraField(path: string): unknown {
  const copy = structuredClone(flowRead);
  const target = path
    .split(".")
    .filter(Boolean)
    .reduce<Record<string, unknown>>(
      (node, part) => node[part] as Record<string, unknown>,
      copy as unknown as Record<string, unknown>,
    );
  target["extra_field"] = 1;
  return copy;
}

test("the sample of the answer parses", () => {
  assert.equal(flowReadSchema.safeParse(flowRead).success, true);
});

for (const path of OBJECT_PATHS) {
  test(`the answer schema refuses an extra field at "${path}"`, () => {
    assert.equal(flowReadSchema.safeParse(withExtraField(path)).success, false);
  });
}
