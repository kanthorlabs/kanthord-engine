import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  flowExitSchema,
  FlowGrain,
  flowGrainSchema,
  type FlowMeasure,
  flowMeasureSchema,
} from "./contract.ts";
import { BIN_COUNT, binOf, decodeBins, encodeBins } from "./flow-bins.ts";
import {
  FLOW_DAY_RETENTION_DAYS,
  FLOW_HOUR_RETENTION_DAYS,
  FLOW_VECTOR_COLUMNS,
  flowCauseAssignerSchema,
  flowCauseCategorySchema,
  flowCauseDetailSchema,
  type FlowKey,
  flowStageKeySchema,
  type FlowVector,
  stopReasonKeySchema,
} from "./flow-model.ts";
import { DAY_MS } from "./retention.ts";

const HOUR_MS = 3600000;
const KEY_COLUMNS = [
  "grain",
  "bucket_start",
  "project_id",
  "worker_name",
  "stage",
  "exit",
  "stop_reason",
  "cause_category",
  "cause_detail",
  "cause_assigner",
] as const;
const ROLLUP_COLUMNS = [
  ...KEY_COLUMNS,
  ...FLOW_VECTOR_COLUMNS,
  "changed_after_end",
];
const GRAIN_MS: Readonly<Record<FlowGrain, number>> = {
  [FlowGrain.Hour]: HOUR_MS,
  [FlowGrain.Day]: DAY_MS,
};
const RETENTION_DAYS: Readonly<Record<FlowGrain, number>> = {
  [FlowGrain.Hour]: FLOW_HOUR_RETENTION_DAYS,
  [FlowGrain.Day]: FLOW_DAY_RETENTION_DAYS,
};
const UPSERT_ROLLUP = `INSERT INTO tracking_flow_rollup (${ROLLUP_COLUMNS.join(", ")}) VALUES (${ROLLUP_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT (${KEY_COLUMNS.join(", ")}) DO UPDATE SET ${[...FLOW_VECTOR_COLUMNS].map((column) => `${column} = ${column} + excluded.${column}`).join(", ")}, changed_after_end = MAX(changed_after_end, excluded.changed_after_end)`;
const USAGE_COLUMNS = [
  "turn_count",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cost_usd",
  "unpriced_tokens",
] as const;
const UPSERT_USAGE = `INSERT INTO tracking_usage_rollup (grain, bucket_start, project_id, worker_name, model, ${USAGE_COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ${USAGE_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT (grain, bucket_start, project_id, worker_name, model) DO UPDATE SET ${USAGE_COLUMNS.map((column) => `${column} = ${column} + excluded.${column}`).join(", ")}`;
const SELECT_BINS =
  "SELECT bins FROM tracking_flow_histogram WHERE grain = ? AND bucket_start = ? AND project_id = ? AND worker_name = ? AND measure = ?";
const UPSERT_BINS =
  "INSERT INTO tracking_flow_histogram (grain, bucket_start, project_id, worker_name, measure, bins) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (grain, bucket_start, project_id, worker_name, measure) DO UPDATE SET bins = excluded.bins";
const DELETE_EMPTY_ROLLUP =
  "DELETE FROM tracking_flow_rollup WHERE grain = ? AND bucket_start = ? AND project_id = ? AND worker_name = ? AND stage = ? AND exit = ? AND stop_reason = ? AND cause_category = ? AND cause_detail = ? AND cause_assigner = ? AND executions <= 0";
const MARKED = 1;
const UNMARKED = 0;
const NO_COUNT = 0;
const ONE_COUNT = 1;

export type FlowUsageSum = Readonly<
  Record<(typeof USAGE_COLUMNS)[number], number>
>;

export interface RollupPlace {
  grain: FlowGrain;
  bucket_start: number;
  now: number;
}

function isExpired(place: RollupPlace): boolean {
  const days = RETENTION_DAYS[flowGrainSchema.parse(place.grain)];
  return place.bucket_start < place.now - days * DAY_MS;
}

function keyValues(place: RollupPlace, key: FlowKey) {
  return [
    flowGrainSchema.parse(place.grain),
    place.bucket_start,
    key.project_id,
    key.worker_name,
    flowStageKeySchema.parse(key.stage),
    flowExitSchema.parse(key.exit),
    stopReasonKeySchema.parse(key.stop_reason),
    flowCauseCategorySchema.parse(key.cause_category),
    flowCauseDetailSchema.parse(key.cause_detail),
    flowCauseAssignerSchema.parse(key.cause_assigner),
  ];
}

export function addFlowVector(
  tx: Transaction,
  place: RollupPlace,
  key: FlowKey,
  vector: FlowVector,
  late: boolean,
): void {
  if (isExpired(place)) return;
  const pastBucket = place.bucket_start + GRAIN_MS[place.grain] < place.now;
  tx.database
    .prepare(UPSERT_ROLLUP)
    .run(
      ...keyValues(place, key),
      ...FLOW_VECTOR_COLUMNS.map((column) => vector[column]),
      late && pastBucket ? MARKED : UNMARKED,
    );
}

export function deleteEmptyFlowRow(
  tx: Transaction,
  place: RollupPlace,
  key: FlowKey,
): void {
  if (isExpired(place)) return;
  tx.database.prepare(DELETE_EMPTY_ROLLUP).run(...keyValues(place, key));
}

export function addHistogramValue(
  tx: Transaction,
  place: RollupPlace,
  projectId: string,
  workerName: string,
  measure: FlowMeasure,
  value: number,
): void {
  if (isExpired(place)) return;
  const grain = flowGrainSchema.parse(place.grain);
  const parsed = flowMeasureSchema.parse(measure);
  const row = tx.database
    .prepare(SELECT_BINS)
    .get(grain, place.bucket_start, projectId, workerName, parsed);
  const stored = row?.bins;
  assert.ok(stored === undefined || stored instanceof Uint8Array);
  const bins =
    stored === undefined
      ? Array.from({ length: BIN_COUNT }, () => NO_COUNT)
      : decodeBins(stored);
  const bin = binOf(value);
  bins[bin] = (bins[bin] ?? NO_COUNT) + ONE_COUNT;
  tx.database
    .prepare(UPSERT_BINS)
    .run(
      grain,
      place.bucket_start,
      projectId,
      workerName,
      parsed,
      encodeBins(bins),
    );
}

export function addUsage(
  tx: Transaction,
  place: RollupPlace,
  projectId: string,
  workerName: string,
  model: string,
  sum: FlowUsageSum,
): void {
  if (isExpired(place)) return;
  tx.database
    .prepare(UPSERT_USAGE)
    .run(
      flowGrainSchema.parse(place.grain),
      place.bucket_start,
      projectId,
      workerName,
      model,
      ...USAGE_COLUMNS.map((column) => sum[column]),
    );
}
