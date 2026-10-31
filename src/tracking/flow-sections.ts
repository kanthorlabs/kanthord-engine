import { CauseCategory } from "../kernel/cause.ts";
import {
  ANALYTICS_ITEMS_MAX,
  type CauseRow,
  type CostWindow,
  flowCauseRowAssignerSchema,
  FlowDimensionBy,
  FlowExit,
  type FlowRead,
  FlowStage,
  flowStageSchema,
  FlowStopReason,
  flowStopReasonSchema,
  type UsageRow,
  type UsageTotals,
} from "./contract.ts";
import type { FlowRow } from "./flow-stages.ts";

export interface FlowUsageRow {
  bucket_start: number;
  project_id: string;
  worker_name: string;
  model: string;
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  unpriced_tokens: number;
}

export interface WindowRows<Row> {
  current: readonly Row[];
  previous: readonly Row[] | null;
}

export interface SameHourRows {
  rows: readonly FlowRow[];
  usage: readonly FlowUsageRow[];
}

export interface CostInput {
  buckets: readonly number[];
  rows: WindowRows<FlowRow>;
  usage: WindowRows<FlowUsageRow>;
  same_hour: SameHourRows | null;
}

export interface UsageInput {
  buckets: readonly number[];
  rows: readonly FlowRow[];
  usage: WindowRows<FlowUsageRow>;
  same_hour: SameHourRows | null;
}

type CauseKeys = Pick<CauseRow, "count" | "stage" | "exit" | "category"> &
  Partial<Pick<CauseRow, "detail" | "assigner">>;
type UsageBy = keyof FlowRead["usage"]["by"];

const NO_VALUE = "";
const NO_COUNT = 0;
const STAGE_ORDER = flowStageSchema.options;
const LEAK_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Stopped,
  FlowExit.Paused,
  FlowExit.Revoked,
  FlowExit.Blocked,
]);
const SUCCESS_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Completed,
  FlowExit.External,
]);
const REJECTED_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Rework,
  FlowExit.Blocked,
]);
const EVALUATION_STAGES: ReadonlySet<string> = new Set([
  FlowStage.Evaluation,
  FlowStage.Outcome,
]);
const ATTRIBUTED_EXITS: ReadonlySet<FlowExit> = new Set([
  FlowExit.Stopped,
  FlowExit.Paused,
  FlowExit.Revoked,
  FlowExit.Rework,
  FlowExit.Blocked,
]);
const CAUSED_EXITS: ReadonlySet<FlowExit> = new Set([
  ...ATTRIBUTED_EXITS,
  FlowExit.Budget,
]);

function sumOf<Row>(
  rows: readonly Row[],
  valueOf: (row: Row) => number,
): number {
  return rows.reduce((total, row) => total + valueOf(row), NO_COUNT);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === NO_COUNT ? null : numerator / denominator;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function groupBy<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string | number,
): Map<string | number, Row[]> {
  const groups = new Map<string | number, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function perBucket<Row extends { bucket_start: number }, Value>(
  buckets: readonly number[],
  rows: readonly Row[],
  valueOf: (bucketRows: readonly Row[]) => Value,
): Value[] {
  const groups = groupBy(rows, (row) => row.bucket_start);
  return buckets.map((bucket) => valueOf(groups.get(bucket) ?? []));
}

function executionsOf(rows: readonly FlowRow[]): number {
  return sumOf(rows, (row) => row.executions);
}

function successOf(rows: readonly FlowRow[]): number {
  return executionsOf(rows.filter((row) => SUCCESS_EXITS.has(row.exit)));
}

function leakedUsdOf(rows: readonly FlowRow[]): number {
  return sumOf(
    rows.filter((row) => LEAK_EXITS.has(row.exit)),
    (row) => row.cost_usd,
  );
}

function rejectedReviewUsdOf(rows: readonly FlowRow[]): number {
  return sumOf(
    rows.filter(
      (row) => EVALUATION_STAGES.has(row.stage) && REJECTED_EXITS.has(row.exit),
    ),
    (row) => row.cost_usd,
  );
}

function usdOf(usage: readonly FlowUsageRow[]): number {
  return sumOf(usage, (row) => row.cost_usd);
}

function costWindowOf(
  rows: readonly FlowRow[],
  usage: readonly FlowUsageRow[],
): CostWindow {
  const total = usdOf(usage);
  const success = successOf(rows);
  return {
    total_usd: total,
    success,
    per_success_usd: ratio(total, success),
    leaked_usd: leakedUsdOf(rows),
    rejected_review_usd: rejectedReviewUsdOf(rows),
  };
}

export function costOf(input: CostInput): FlowRead["cost"] {
  const { rows, usage, same_hour: sameHour } = input;
  const flowByBucket = groupBy(rows.current, (row) => row.bucket_start);
  const usageByBucket = groupBy(usage.current, (row) => row.bucket_start);
  const flowOf = (bucket: number) => flowByBucket.get(bucket) ?? [];
  const usageIn = (bucket: number) => usageByBucket.get(bucket) ?? [];
  return {
    current: costWindowOf(rows.current, usage.current),
    previous:
      rows.previous === null || usage.previous === null
        ? null
        : costWindowOf(rows.previous, usage.previous),
    previous_same_hour:
      sameHour === null
        ? null
        : {
            total_usd: usdOf(sameHour.usage),
            success: successOf(sameHour.rows),
            rejected_review_usd: rejectedReviewUsdOf(sameHour.rows),
          },
    series: {
      total_usd: input.buckets.map((bucket) => usdOf(usageIn(bucket))),
      leaked_usd: input.buckets.map((bucket) => leakedUsdOf(flowOf(bucket))),
      rejected_review_usd: input.buckets.map((bucket) =>
        rejectedReviewUsdOf(flowOf(bucket)),
      ),
      success: input.buckets.map((bucket) => successOf(flowOf(bucket))),
    },
  };
}

function compareCauses(left: CauseKeys, right: CauseKeys): number {
  return (
    right.count - left.count ||
    STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage) ||
    compareText(left.exit, right.exit) ||
    compareText(left.category, right.category) ||
    compareText(left.detail ?? NO_VALUE, right.detail ?? NO_VALUE) ||
    compareText(left.assigner ?? NO_VALUE, right.assigner ?? NO_VALUE)
  );
}

function causeRowsOf(rows: readonly FlowRow[]): CauseRow[] {
  const groups = new Map<string, CauseRow>();
  for (const row of rows) {
    const stage = flowStageSchema.safeParse(row.stage);
    if (!stage.success || !CAUSED_EXITS.has(row.exit)) continue;
    const key = JSON.stringify([
      row.stage,
      row.exit,
      row.cause_category,
      row.cause_detail,
      row.cause_assigner,
    ]);
    const cause = groups.get(key) ?? {
      stage: stage.data,
      exit: row.exit,
      category: row.cause_category,
      detail: row.cause_detail,
      assigner: flowCauseRowAssignerSchema.parse(row.cause_assigner),
      count: NO_COUNT,
      cost_usd: NO_COUNT,
    };
    cause.count += row.executions;
    cause.cost_usd += row.cost_usd;
    groups.set(key, cause);
  }
  return [...groups.values()].sort(compareCauses);
}

function previousCauseRowsOf(
  rows: readonly FlowRow[],
): FlowRead["causes"]["previous_rows"] {
  const groups = new Map<
    string,
    NonNullable<FlowRead["causes"]["previous_rows"]>[number]
  >();
  for (const cause of causeRowsOf(rows)) {
    const key = JSON.stringify([cause.stage, cause.exit, cause.category]);
    const summed = groups.get(key) ?? {
      stage: cause.stage,
      exit: cause.exit,
      category: cause.category,
      count: NO_COUNT,
    };
    summed.count += cause.count;
    groups.set(key, summed);
  }
  return [...groups.values()].sort(compareCauses);
}

function unattributedShareOf(rows: readonly FlowRow[]): number | null {
  const caused = rows.filter((row) => ATTRIBUTED_EXITS.has(row.exit));
  const unattributed = caused.filter(
    (row) => row.cause_category === CauseCategory.Unattributed,
  );
  return ratio(executionsOf(unattributed), executionsOf(caused));
}

export function causesOf(
  rows: WindowRows<FlowRow>,
  buckets: readonly number[],
): FlowRead["causes"] {
  const current = causeRowsOf(rows.current);
  const previous =
    rows.previous === null ? null : previousCauseRowsOf(rows.previous);
  return {
    rows: current.slice(NO_COUNT, ANALYTICS_ITEMS_MAX),
    previous_rows: previous?.slice(NO_COUNT, ANALYTICS_ITEMS_MAX) ?? null,
    previous_unattributed_share:
      rows.previous === null ? null : unattributedShareOf(rows.previous),
    unattributed_share_series: perBucket(
      buckets,
      rows.current,
      unattributedShareOf,
    ),
    truncated:
      current.length > ANALYTICS_ITEMS_MAX ||
      (previous?.length ?? NO_COUNT) > ANALYTICS_ITEMS_MAX,
  };
}

function stopReasonOf(row: FlowRow): FlowStopReason | null {
  if (row.exit === FlowExit.Budget) return FlowStopReason.BudgetEnd;
  if (row.exit !== FlowExit.Stopped) return null;
  const reason = flowStopReasonSchema.safeParse(row.stop_reason);
  return reason.success ? reason.data : null;
}

function stopTotalsOf(
  rows: readonly FlowRow[],
): Record<FlowStopReason, number> {
  const totals = Object.fromEntries(
    Object.values(FlowStopReason).map((reason) => [reason, NO_COUNT]),
  ) as Record<FlowStopReason, number>;
  for (const row of rows) {
    const reason = stopReasonOf(row);
    if (reason !== null) totals[reason] += row.executions;
  }
  return totals;
}

export function stopReasonsOf(
  rows: WindowRows<FlowRow>,
  buckets: readonly number[],
): FlowRead["stop_reasons"] {
  const order = Object.values(FlowStopReason);
  const totals = perBucket(buckets, rows.current, stopTotalsOf);
  return {
    order,
    rows: Object.fromEntries(
      order.map((reason) => [reason, totals.map((total) => total[reason])]),
    ) as Record<FlowStopReason, number[]>,
    previous_totals:
      rows.previous === null ? null : stopTotalsOf(rows.previous),
  };
}

function totalsOf(usage: readonly FlowUsageRow[]): UsageTotals {
  return {
    turn_count: sumOf(usage, (row) => row.turn_count),
    input_tokens: sumOf(usage, (row) => row.input_tokens),
    output_tokens: sumOf(usage, (row) => row.output_tokens),
    cache_read_tokens: sumOf(usage, (row) => row.cache_read_tokens),
    cost_usd: usdOf(usage),
    unpriced_tokens: sumOf(usage, (row) => row.unpriced_tokens),
  };
}

function cacheHitOf(usage: readonly FlowUsageRow[]): number | null {
  return ratio(
    sumOf(usage, (row) => row.cache_read_tokens),
    sumOf(usage, (row) => row.input_tokens),
  );
}

function usageRowOf(
  key: string,
  by: UsageBy,
  usage: readonly FlowUsageRow[],
  input: UsageInput,
): UsageRow {
  const sameHour = input.same_hour?.usage.filter((row) => row[by] === key);
  const projectRows = input.rows.filter((row) => row.project_id === key);
  return {
    ...totalsOf(usage),
    key,
    ...(by === FlowDimensionBy.ProjectId
      ? { success: successOf(projectRows) }
      : {}),
    previous_same_hour:
      sameHour === undefined ? null : { cost_usd: usdOf(sameHour) },
    series: {
      cost_usd: perBucket(input.buckets, usage, usdOf),
      cache_hit: perBucket(input.buckets, usage, cacheHitOf),
    },
  };
}

function usageListOf(by: UsageBy, input: UsageInput): UsageRow[] {
  return [...groupBy(input.usage.current, (row) => row[by])]
    .map(([key, usage]) => usageRowOf(String(key), by, usage, input))
    .sort(
      (left, right) =>
        right.cost_usd - left.cost_usd || compareText(left.key, right.key),
    );
}

export function usageOf(input: UsageInput): FlowRead["usage"] {
  return {
    current: totalsOf(input.usage.current),
    previous:
      input.usage.previous === null ? null : totalsOf(input.usage.previous),
    previous_same_hour:
      input.same_hour === null ? null : totalsOf(input.same_hour.usage),
    series: {
      total_tokens: perBucket(input.buckets, input.usage.current, (usage) =>
        sumOf(usage, (row) => row.input_tokens + row.output_tokens),
      ),
      cache_hit: perBucket(input.buckets, input.usage.current, cacheHitOf),
      unpriced_tokens: perBucket(input.buckets, input.usage.current, (usage) =>
        sumOf(usage, (row) => row.unpriced_tokens),
      ),
    },
    by: {
      model: usageListOf("model", input),
      worker_name: usageListOf("worker_name", input),
      project_id: usageListOf("project_id", input),
    },
  };
}

export function completenessOf(
  rows: readonly FlowRow[],
): FlowRead["completeness"] {
  const rooted = rows.filter((row) => row.stage !== NO_VALUE);
  const awaiting = [...groupBy(rows, (row) => row.worker_name)]
    .map(([worker, workerRows]) => ({
      worker_name: String(worker),
      count: sumOf(workerRows, (row) => row.awaiting_ingestion),
    }))
    .filter((entry) => entry.count > NO_COUNT)
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareText(left.worker_name, right.worker_name),
    );
  return {
    executions: executionsOf(rooted),
    open: executionsOf(rooted.filter((row) => row.exit === FlowExit.Open)),
    no_root: executionsOf(rows.filter((row) => row.stage === NO_VALUE)),
    exit_unknown: executionsOf(
      rows.filter((row) => row.exit === FlowExit.Unknown),
    ),
    awaiting_ingestion: awaiting,
    late_records: sumOf(rows, (row) => row.late_records),
  };
}
