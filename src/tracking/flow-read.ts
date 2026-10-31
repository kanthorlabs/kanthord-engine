import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import type { Store, Transaction } from "../kernel/store.ts";
import { isNumber } from "../kernel/values.ts";
import { bucketStart } from "./analytics-bucket.ts";
import {
  type AnalyticsFlowQuery,
  FLOW_PERCENTILE_METHOD,
  flowExitSchema,
  FlowGrain,
  flowMeasureSchema,
  type FlowRead,
} from "./contract.ts";
import { decodeBins } from "./flow-bins.ts";
import {
  FLOW_VECTOR_COLUMNS,
  flowStageKeySchema,
  stopReasonKeySchema,
} from "./flow-model.ts";
import {
  causesOf,
  completenessOf,
  costOf,
  type FlowUsageRow,
  type SameHourRows,
  stopReasonsOf,
  usageOf,
  type WindowRows,
} from "./flow-sections.ts";
import {
  type FlowHistogramRow,
  type FlowRow,
  stagesOf,
} from "./flow-stages.ts";
import { flowWindowOf, type FlowWindows } from "./flow-window.ts";

export interface FlowReadOptions {
  isHostedWorker: (workerName: string) => boolean;
  rebuild: FlowRead["rebuild"];
}

interface RowRange {
  grain: FlowGrain;
  from: number;
  to: number;
}

interface RowFilter {
  sql: string;
  values: string[];
}

interface ReadRows {
  rows: FlowRow[];
  histograms: FlowHistogramRow[];
  usage: FlowUsageRow[];
}

const ROLLUP_COLUMNS = [
  "bucket_start",
  "project_id",
  "worker_name",
  "stage",
  "exit",
  "stop_reason",
  "cause_category",
  "cause_detail",
  "cause_assigner",
  ...FLOW_VECTOR_COLUMNS,
  "changed_after_end",
];
const USAGE_COLUMNS = [
  "bucket_start",
  "project_id",
  "worker_name",
  "model",
  "turn_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cost_usd",
  "unpriced_tokens",
];
const RANGE_SQL = "grain = ? AND bucket_start >= ? AND bucket_start < ?";
const COVERAGE_SQL =
  "SELECT min(bucket_start) AS coverage_start FROM tracking_flow_rollup WHERE grain = ?";

function selectOf(
  table: string,
  columns: readonly string[],
  filter: RowFilter,
) {
  return `SELECT ${columns.join(", ")} FROM ${table} WHERE ${RANGE_SQL}${filter.sql}`;
}

function filterOf(query: AnalyticsFlowQuery): RowFilter {
  const filter: RowFilter = { sql: "", values: [] };
  if (query.project_id !== undefined) {
    filter.sql += " AND project_id = ?";
    filter.values.push(query.project_id);
  }
  if (query.worker_name !== undefined) {
    filter.sql += " AND worker_name = ?";
    filter.values.push(query.worker_name);
  }
  return filter;
}

function coverageStartOf(tx: Transaction, grain: FlowGrain): number | null {
  const row = tx.database.prepare(COVERAGE_SQL).get(grain);
  const start = row?.coverage_start;
  assert.ok(start === null || isNumber(start));
  return start ?? null;
}

function selectAll(
  tx: Transaction,
  sql: string,
  range: RowRange,
  filter: RowFilter,
) {
  const values: SQLInputValue[] = [
    range.grain,
    range.from,
    range.to,
    ...filter.values,
  ];
  return tx.database.prepare(sql).all(...values);
}

function flowRowsOf(
  tx: Transaction,
  range: RowRange,
  filter: RowFilter,
): FlowRow[] {
  return selectAll(
    tx,
    selectOf("tracking_flow_rollup", ROLLUP_COLUMNS, filter),
    range,
    filter,
  ).map((row) => ({
    ...(Object.fromEntries(
      FLOW_VECTOR_COLUMNS.map((column) => [column, Number(row[column])]),
    ) as Pick<FlowRow, (typeof FLOW_VECTOR_COLUMNS)[number]>),
    bucket_start: Number(row.bucket_start),
    changed_after_end: Number(row.changed_after_end),
    project_id: String(row.project_id),
    worker_name: String(row.worker_name),
    stage: flowStageKeySchema.parse(row.stage),
    exit: flowExitSchema.parse(row.exit),
    stop_reason: stopReasonKeySchema.parse(row.stop_reason),
    cause_category: String(row.cause_category),
    cause_detail: String(row.cause_detail),
    cause_assigner: String(row.cause_assigner),
  }));
}

function histogramRowsOf(
  tx: Transaction,
  range: RowRange,
  filter: RowFilter,
): FlowHistogramRow[] {
  const columns = [
    "bucket_start",
    "project_id",
    "worker_name",
    "measure",
    "bins",
  ];
  return selectAll(
    tx,
    selectOf("tracking_flow_histogram", columns, filter),
    range,
    filter,
  ).map((row) => {
    assert.ok(row.bins instanceof Uint8Array);
    return {
      bucket_start: Number(row.bucket_start),
      project_id: String(row.project_id),
      worker_name: String(row.worker_name),
      measure: flowMeasureSchema.parse(row.measure),
      bins: decodeBins(row.bins),
    };
  });
}

function usageRowsOf(
  tx: Transaction,
  range: RowRange,
  filter: RowFilter,
): FlowUsageRow[] {
  return selectAll(
    tx,
    selectOf("tracking_usage_rollup", USAGE_COLUMNS, filter),
    range,
    filter,
  ).map((row) => ({
    bucket_start: Number(row.bucket_start),
    project_id: String(row.project_id),
    worker_name: String(row.worker_name),
    model: String(row.model),
    turn_count: Number(row.turn_count),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
    cost_usd: Number(row.cost_usd),
    unpriced_tokens: Number(row.unpriced_tokens),
  }));
}

function readRows(
  tx: Transaction,
  range: RowRange,
  filter: RowFilter,
): ReadRows {
  return {
    rows: flowRowsOf(tx, range, filter),
    histograms: histogramRowsOf(tx, range, filter),
    usage: usageRowsOf(tx, range, filter),
  };
}

function sameHourOf(
  tx: Transaction,
  windows: FlowWindows,
  filter: RowFilter,
  previous: SameHourRows,
  cut: number,
) {
  const dayStart = bucketStart(cut, FlowGrain.Day);
  assert.ok(dayStart !== null);
  if (windows.grain === FlowGrain.Hour)
    return {
      rows: previous.rows.filter((row) => row.bucket_start < cut),
      usage: previous.usage.filter((row) => row.bucket_start < cut),
    };
  const hours: RowRange = { grain: FlowGrain.Hour, from: dayStart, to: cut };
  const needsHours = dayStart < cut;
  return {
    rows: [
      ...previous.rows.filter((row) => row.bucket_start < dayStart),
      ...(needsHours ? flowRowsOf(tx, hours, filter) : []),
    ],
    usage: [
      ...previous.usage.filter((row) => row.bucket_start < dayStart),
      ...(needsHours ? usageRowsOf(tx, hours, filter) : []),
    ],
  };
}

function splitOf<Row extends { bucket_start: number }>(
  rows: readonly Row[],
  from: number,
  hasPrevious: boolean,
): WindowRows<Row> {
  return {
    current: rows.filter((row) => row.bucket_start >= from),
    previous: hasPrevious
      ? rows.filter((row) => row.bucket_start < from)
      : null,
  };
}

export function readFlow(
  store: Store,
  query: AnalyticsFlowQuery,
  now: number,
  options: FlowReadOptions,
): FlowRead {
  const { grain } = flowWindowOf(query, now, null);
  const filter = filterOf(query);
  return store.transaction((tx) => {
    const windows = flowWindowOf(query, now, coverageStartOf(tx, grain));
    const { window, previous_window: previousWindow, cut } = windows;
    const read = readRows(
      tx,
      { grain, from: previousWindow?.from ?? window.from, to: window.to },
      filter,
    );
    const hasPrevious = previousWindow !== null;
    const rows = splitOf(read.rows, window.from, hasPrevious);
    const usage = splitOf(read.usage, window.from, hasPrevious);
    const sameHour =
      cut === null
        ? null
        : sameHourOf(
            tx,
            windows,
            filter,
            { rows: rows.previous ?? [], usage: usage.previous ?? [] },
            cut,
          );
    return {
      window,
      previous_window: previousWindow,
      percentile_method: FLOW_PERCENTILE_METHOD,
      stages: stagesOf(
        read.rows,
        read.histograms,
        windows,
        options.isHostedWorker,
      ),
      cost: costOf({
        buckets: window.buckets,
        rows,
        usage,
        same_hour: sameHour,
      }),
      causes: causesOf(rows, window.buckets),
      stop_reasons: stopReasonsOf(rows, window.buckets),
      usage: usageOf({
        buckets: window.buckets,
        rows: rows.current,
        usage,
        same_hour: sameHour,
      }),
      completeness: completenessOf(rows.current),
      rebuild: options.rebuild,
    };
  });
}
