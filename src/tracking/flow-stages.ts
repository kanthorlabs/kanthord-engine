import {
  FlowDimensionBy,
  FlowExit,
  FlowKind,
  FlowMeasure,
  FlowStage,
  type FlowStageResult,
  flowStageSchema,
  type Percentiles,
  type StageDimension,
  type StageSeries,
  type StageWindow,
} from "./contract.ts";
import { bucketEnd } from "./analytics-bucket.ts";
import { addBins, BIN_COUNT, percentilesOf } from "./flow-bins.ts";
import {
  type FlowKey,
  FlowStageKey,
  type FlowVector,
  type FlowVectorColumn,
} from "./flow-model.ts";
import type { FlowWindows } from "./flow-window.ts";

export interface FlowRow extends FlowKey, FlowVector {
  bucket_start: number;
  changed_after_end: number;
}

export interface FlowHistogramRow {
  bucket_start: number;
  project_id: string;
  worker_name: string;
  measure: FlowMeasure;
  bins: number[];
}

type StageWindows = Pick<FlowWindows, "grain" | "window" | "previous_window">;
type Signals = Record<string, number | null>;
type Exits = StageWindow["exits"];

interface StageMeasure {
  entered: number;
  unobserved: number;
  open: number;
  exits: Exits;
  leaked: number;
  loops: number;
  time: Percentiles | null;
  signals: Signals;
}

interface SignalInput {
  reached: readonly FlowRow[];
  entered: number;
  unobserved: number;
  settled: number;
  leaked: number;
  exits: Exits;
  histograms: readonly FlowHistogramRow[];
  isHostedWorker: (workerName: string) => boolean;
}

const STAGE_ORDER: readonly FlowStageKey[] = flowStageSchema.options;
const STAGE_KIND: Readonly<Record<FlowStageKey, FlowKind>> = {
  [FlowStageKey.None]: FlowKind.None,
  [FlowStage.Queued]: FlowKind.Steps,
  [FlowStage.Executing]: FlowKind.Steps,
  [FlowStage.Verification]: FlowKind.Steps,
  [FlowStage.ReleaseGate]: FlowKind.Steps,
  [FlowStage.Evaluation]: FlowKind.Evaluation,
  [FlowStage.Outcome]: FlowKind.Evaluation,
};
const STAGE_MEASURE: Readonly<Record<FlowStage, FlowMeasure>> = {
  [FlowStage.Queued]: FlowMeasure.QueueWait,
  [FlowStage.Executing]: FlowMeasure.ExecutionTime,
  [FlowStage.Verification]: FlowMeasure.VerificationRunTime,
  [FlowStage.ReleaseGate]: FlowMeasure.GateRunTime,
  [FlowStage.Evaluation]: FlowMeasure.ReviewWait,
  [FlowStage.Outcome]: FlowMeasure.LeadTime,
};
const LEAK_EXITS: readonly FlowExit[] = [
  FlowExit.Stopped,
  FlowExit.Paused,
  FlowExit.Revoked,
  FlowExit.Blocked,
];
const LOOP_EXITS: readonly FlowExit[] = [
  FlowExit.Budget,
  FlowExit.FurtherWork,
  FlowExit.Rework,
];
const SUCCESS_EXITS: readonly FlowExit[] = [
  FlowExit.Completed,
  FlowExit.External,
];
const ASSESSED_EXITS: readonly FlowExit[] = [
  ...SUCCESS_EXITS,
  FlowExit.Rework,
  FlowExit.Blocked,
];
const REJECTED_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Rework,
  FlowExit.Blocked,
]);
const UNOBSERVED_STAGES: ReadonlySet<FlowStage> = new Set([
  FlowStage.Verification,
  FlowStage.ReleaseGate,
]);
const TURN_ERROR_COLUMNS = [
  "turn_rate_limited",
  "turn_quota_exhausted",
  "turn_unavailable",
  "turn_error_other",
] as const;
const MEDIAN_COLUMNS = [
  "turn_rate_limited",
  "turn_quota_exhausted",
  "turn_unavailable",
] as const;
const VERIFICATION_COLUMNS = [
  "gate_routed",
  "affected_runs",
  "affected_failed",
  "affected_base_red",
  "affected_flaky_runs",
  "flaky_tests",
] as const;
const GATE_COLUMNS = [
  "gate_affected_passed",
  "gate_affected_base_red",
  "gate_affected_absent",
] as const;
const EVALUATION_COLUMNS = [
  "evaluation_setup",
  "evaluation_verification",
  "evaluation_affected",
  "evaluation_judgement",
] as const;
const BLOCKED_COLUMNS = [
  "blocked_rework_limit",
  "blocked_plan_defect",
] as const;
const PAIR = 2;
const ODD = 1;
const NO_COUNT = 0;
const CHANGED = 1;

function rankOf(stage: FlowStageKey): number {
  return STAGE_ORDER.indexOf(stage);
}

function sumOf(rows: readonly FlowRow[], column: FlowVectorColumn): number {
  return rows.reduce((total, row) => total + row[column], 0);
}

function sumsOf<Column extends FlowVectorColumn>(
  rows: readonly FlowRow[],
  columns: readonly Column[],
): Record<Column, number> {
  return Object.fromEntries(
    columns.map((column) => [column, sumOf(rows, column)]),
  ) as Record<Column, number>;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === NO_COUNT ? null : numerator / denominator;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function groupBy<Item>(
  items: readonly Item[],
  keyOf: (item: Item) => string | number,
): Map<string | number, Item[]> {
  const groups = new Map<string | number, Item[]>();
  for (const item of items) {
    const group = groups.get(keyOf(item)) ?? [];
    group.push(item);
    groups.set(keyOf(item), group);
  }
  return groups;
}

function reachedRows(
  stage: FlowStage,
  rows: readonly FlowRow[],
): readonly FlowRow[] {
  return rows.filter(
    (row) =>
      STAGE_KIND[row.stage] === STAGE_KIND[stage] &&
      rankOf(row.stage) >= rankOf(stage),
  );
}

function exitsOf(stage: FlowStage, rows: readonly FlowRow[]): Exits {
  const exits: Exits = {};
  if (stage === FlowStage.Queued) return exits;
  for (const row of rows) {
    const previous = exits[row.exit] ?? { count: 0, cost_usd: 0 };
    exits[row.exit] = {
      count: previous.count + row.executions,
      cost_usd: previous.cost_usd + row.cost_usd,
    };
  }
  return exits;
}

function exitCount(exits: Exits, names: readonly FlowExit[]): number {
  return names.reduce((total, name) => total + (exits[name]?.count ?? 0), 0);
}

function timeOf(
  histograms: readonly FlowHistogramRow[],
  measure: FlowMeasure,
): Percentiles | null {
  const bins = histograms
    .filter((histogram) => histogram.measure === measure)
    .reduce(
      (merged, histogram) => addBins(merged, histogram.bins),
      Array.from({ length: BIN_COUNT }, () => 0),
    );
  const percentiles = percentilesOf(bins);
  return percentiles.count === NO_COUNT ? null : percentiles;
}

function executingSignals(input: SignalInput): Signals {
  const settledRows = input.reached.filter((row) => row.exit !== FlowExit.Open);
  return {
    turns_per_execution: ratio(
      sumOf(settledRows, "turn_count"),
      sumOf(settledRows, "executions"),
    ),
    tool_error_rate: ratio(
      sumOf(input.reached, "tool_error_count"),
      sumOf(input.reached, "tool_count"),
    ),
    ...sumsOf(input.reached, TURN_ERROR_COLUMNS),
    leak_rate: ratio(input.leaked, input.settled),
  };
}

function verificationSignals(input: SignalInput): Signals {
  const sums = sumsOf(input.reached, VERIFICATION_COLUMNS);
  const unobservedRows = input.reached.filter(
    (row) => row.unobserved > NO_COUNT,
  );
  const hosted = unobservedRows.filter((row) =>
    input.isHostedWorker(row.worker_name),
  );
  const external = unobservedRows.filter(
    (row) => !input.isHostedWorker(row.worker_name),
  );
  return {
    ...sums,
    loops_per_entry: ratio(sums.gate_routed, input.entered),
    affected_fail_rate: ratio(sums.affected_failed, sums.affected_runs),
    flaky_run_share: ratio(sums.affected_flaky_runs, sums.affected_runs),
    base_red_share: ratio(sums.affected_base_red, sums.affected_runs),
    budget: input.exits[FlowExit.Budget]?.count ?? 0,
    unobserved: input.unobserved,
    unobserved_external: sumOf(external, "unobserved"),
    unobserved_no_gate: sumOf(hosted, "unobserved"),
  };
}

function releaseGateSignals(input: SignalInput): Signals {
  return {
    ...sumsOf(input.reached, GATE_COLUMNS),
    leak_rate: ratio(input.leaked, input.settled),
  };
}

function evaluationSignals(input: SignalInput): Signals {
  const rejected = input.reached.filter((row) => REJECTED_EXITS.has(row.exit));
  return {
    evaluation_time_p90:
      timeOf(input.histograms, FlowMeasure.EvaluationTime)?.p90 ?? null,
    ...sumsOf(rejected, EVALUATION_COLUMNS),
  };
}

function outcomeSignals(input: SignalInput): Signals {
  const assessed = exitCount(input.exits, ASSESSED_EXITS);
  return {
    success: exitCount(input.exits, SUCCESS_EXITS),
    rework_rate: ratio(exitCount(input.exits, [FlowExit.Rework]), assessed),
    blocked_rate: ratio(exitCount(input.exits, [FlowExit.Blocked]), assessed),
    ...sumsOf(input.reached, BLOCKED_COLUMNS),
  };
}

const SIGNALS: Readonly<Record<FlowStage, (input: SignalInput) => Signals>> = {
  [FlowStage.Queued]: () => ({}),
  [FlowStage.Executing]: executingSignals,
  [FlowStage.Verification]: verificationSignals,
  [FlowStage.ReleaseGate]: releaseGateSignals,
  [FlowStage.Evaluation]: evaluationSignals,
  [FlowStage.Outcome]: outcomeSignals,
};

function measureStage(
  stage: FlowStage,
  rows: readonly FlowRow[],
  histograms: readonly FlowHistogramRow[],
  isHostedWorker: (workerName: string) => boolean,
): StageMeasure {
  const reached = reachedRows(stage, rows);
  const unobserved = UNOBSERVED_STAGES.has(stage)
    ? sumOf(reached, "unobserved")
    : 0;
  const entered = sumOf(reached, "executions") - unobserved;
  const exits = exitsOf(
    stage,
    rows.filter((row) => row.stage === stage),
  );
  const open = exits[FlowExit.Open]?.count ?? 0;
  const leaked = exitCount(exits, LEAK_EXITS);
  return {
    entered,
    unobserved,
    open,
    exits,
    leaked,
    loops: exitCount(exits, LOOP_EXITS),
    time: timeOf(histograms, STAGE_MEASURE[stage]),
    signals: SIGNALS[stage]({
      reached,
      entered,
      unobserved,
      settled: entered - open,
      leaked,
      exits,
      histograms,
      isHostedWorker,
    }),
  };
}

function definedSignals(signals: Signals): Record<string, number> {
  return Object.fromEntries(
    Object.entries(signals).filter(
      (entry): entry is [string, number] => entry[1] !== null,
    ),
  );
}

function windowOf(measure: StageMeasure): StageWindow {
  return {
    entered: measure.entered,
    unobserved: measure.unobserved,
    open: measure.open,
    exits: measure.exits,
    time: measure.time,
    signals: definedSignals(measure.signals),
  };
}

function seriesOf(
  stage: FlowStage,
  buckets: readonly number[],
  rows: readonly FlowRow[],
  histograms: readonly FlowHistogramRow[],
  isHostedWorker: (workerName: string) => boolean,
): StageSeries {
  const rowsByBucket = groupBy(rows, (row) => row.bucket_start);
  const histogramsByBucket = groupBy(
    histograms,
    (histogram) => histogram.bucket_start,
  );
  const measures = buckets.map((bucket) =>
    measureStage(
      stage,
      rowsByBucket.get(bucket) ?? [],
      histogramsByBucket.get(bucket) ?? [],
      isHostedWorker,
    ),
  );
  const keys = Object.keys(measureStage(stage, [], [], isHostedWorker).signals);
  return {
    entered: measures.map((measure) => measure.entered),
    open: measures.map((measure) => measure.open),
    leaked: measures.map((measure) => measure.leaked),
    loops: measures.map((measure) => measure.loops),
    time_p90: measures.map((measure) => measure.time?.p90 ?? null),
    signals: Object.fromEntries(
      keys.map((key) => [
        key,
        measures.map((measure) => measure.signals[key] ?? null),
      ]),
    ),
    changed_after_end: buckets.map((bucket) =>
      (rowsByBucket.get(bucket) ?? []).some(
        (row) => row.stage === stage && row.changed_after_end === CHANGED,
      ),
    ),
  };
}

function dimensionsOf(
  stage: FlowStage,
  rows: readonly FlowRow[],
  histograms: readonly FlowHistogramRow[],
  isHostedWorker: (workerName: string) => boolean,
): StageDimension[] {
  const items: StageDimension[] = [];
  for (const by of Object.values(FlowDimensionBy)) {
    const histogramsByKey = groupBy(histograms, (histogram) => histogram[by]);
    for (const [key, keyRows] of groupBy(rows, (row) => row[by])) {
      const measure = measureStage(
        stage,
        keyRows,
        histogramsByKey.get(key) ?? [],
        isHostedWorker,
      );
      if (!isListed(stage, by, measure)) continue;
      items.push({
        by,
        key: String(key),
        entered: measure.entered,
        leaked: measure.leaked,
        loops: measure.loops,
        time: measure.time,
        signals: definedSignals(measure.signals),
      });
    }
  }
  return items.sort(
    (left, right) =>
      right.entered - left.entered ||
      compareText(left.by, right.by) ||
      compareText(left.key, right.key),
  );
}

function isListed(
  stage: FlowStage,
  by: FlowDimensionBy,
  measure: StageMeasure,
): boolean {
  if (measure.entered > NO_COUNT) return true;
  return (
    by === FlowDimensionBy.WorkerName &&
    UNOBSERVED_STAGES.has(stage) &&
    measure.unobserved > NO_COUNT
  );
}

function medianOf(values: readonly number[]): number {
  if (values.length === NO_COUNT) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / PAIR);
  if (sorted.length % PAIR === ODD) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / PAIR;
}

function previousBucketMedian(
  stage: FlowStage,
  windows: StageWindows,
  previousRows: readonly FlowRow[],
): Record<string, number> | null {
  const previous = windows.previous_window;
  if (previous === null) return null;
  if (stage !== FlowStage.Executing) return {};
  const rowsByBucket = groupBy(previousRows, (row) => row.bucket_start);
  const perBucket: Record<(typeof MEDIAN_COLUMNS)[number], number>[] = [];
  for (
    let start = previous.from;
    start < previous.to;
    start = bucketEnd(start, windows.grain)
  )
    perBucket.push(
      sumsOf(reachedRows(stage, rowsByBucket.get(start) ?? []), MEDIAN_COLUMNS),
    );
  return Object.fromEntries(
    MEDIAN_COLUMNS.map((column) => [
      column,
      medianOf(perBucket.map((sums) => sums[column])),
    ]),
  );
}

export function stagesOf(
  rows: readonly FlowRow[],
  histograms: readonly FlowHistogramRow[],
  windows: StageWindows,
  isHostedWorker: (workerName: string) => boolean,
): FlowStageResult[] {
  const from = windows.window.from;
  const hasPrevious = windows.previous_window !== null;
  const currentRows = rows.filter((row) => row.bucket_start >= from);
  const previousRows = hasPrevious
    ? rows.filter((row) => row.bucket_start < from)
    : [];
  const currentHistograms = histograms.filter(
    (histogram) => histogram.bucket_start >= from,
  );
  const previousHistograms = hasPrevious
    ? histograms.filter((histogram) => histogram.bucket_start < from)
    : [];
  return flowStageSchema.options.map((stage) => ({
    stage,
    current: windowOf(
      measureStage(stage, currentRows, currentHistograms, isHostedWorker),
    ),
    previous: hasPrevious
      ? windowOf(
          measureStage(stage, previousRows, previousHistograms, isHostedWorker),
        )
      : null,
    series: seriesOf(
      stage,
      windows.window.buckets,
      currentRows,
      currentHistograms,
      isHostedWorker,
    ),
    dimensions: dimensionsOf(
      stage,
      currentRows,
      currentHistograms,
      isHostedWorker,
    ),
    previous_bucket_median: previousBucketMedian(stage, windows, previousRows),
  }));
}
