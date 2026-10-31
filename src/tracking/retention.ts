import type { Store } from "../kernel/store.ts";
import { FlowGrain } from "./contract.ts";
import {
  FLOW_DAY_RETENTION_DAYS,
  FLOW_HOUR_RETENTION_DAYS,
} from "./flow-model.ts";

export const RETENTION_SWEEP_INTERVAL_MS = 3600000;
export const RETENTION_SWEEP_BATCH_ROWS = 20;
export const RETENTION_SWEEP_BATCHES_MAX = 50;
export const FLOW_SWEEP_BATCH_ROWS = 500;
export const DAY_MS = 86400000;

const FLOW_TABLE_KEYS: Readonly<Record<string, string>> = {
  tracking_flow_rollup:
    "grain, bucket_start, project_id, worker_name, stage, exit, stop_reason, cause_category, cause_detail, cause_assigner",
  tracking_flow_histogram:
    "grain, bucket_start, project_id, worker_name, measure",
  tracking_usage_rollup: "grain, bucket_start, project_id, worker_name, model",
};
const FLOW_GRAIN_DAYS: Readonly<Record<FlowGrain, number>> = {
  [FlowGrain.Hour]: FLOW_HOUR_RETENTION_DAYS,
  [FlowGrain.Day]: FLOW_DAY_RETENTION_DAYS,
};

export function retentionCutoff(now: number, retentionDays: number): number {
  return now - retentionDays * DAY_MS;
}

export function sweepExpiredTraces(store: Store, cutoff: number): number {
  let deleted = 0;
  for (let batch = 0; batch < RETENTION_SWEEP_BATCHES_MAX; batch++) {
    const { changes } = store.transaction((tx) =>
      tx.database
        .prepare(
          "DELETE FROM tracking_trace WHERE rowid IN (SELECT rowid FROM tracking_trace WHERE created_at < ? ORDER BY created_at LIMIT ?)",
        )
        .run(cutoff, RETENTION_SWEEP_BATCH_ROWS),
    );
    deleted += Number(changes);
    if (changes < RETENTION_SWEEP_BATCH_ROWS) break;
  }
  return deleted;
}

function sweepFlowTable(
  store: Store,
  table: string,
  grain: FlowGrain,
  cutoff: number,
): number {
  const key = FLOW_TABLE_KEYS[table];
  const sql = `DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE grain = ? AND bucket_start < ? ORDER BY ${key} LIMIT ?)`;
  let deleted = 0;
  for (let batch = 0; batch < RETENTION_SWEEP_BATCHES_MAX; batch++) {
    const { changes } = store.transaction((tx) =>
      tx.database.prepare(sql).run(grain, cutoff, FLOW_SWEEP_BATCH_ROWS),
    );
    deleted += Number(changes);
    if (changes < FLOW_SWEEP_BATCH_ROWS) break;
  }
  return deleted;
}

export function sweepExpiredFlow(store: Store, now: number): number {
  let deleted = 0;
  for (const table of Object.keys(FLOW_TABLE_KEYS))
    for (const grain of Object.values(FlowGrain))
      deleted += sweepFlowTable(
        store,
        table,
        grain,
        retentionCutoff(now, FLOW_GRAIN_DAYS[grain]),
      );
  return deleted;
}
