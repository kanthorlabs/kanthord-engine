import type { Store } from "../kernel/store.ts";

export const RETENTION_SWEEP_INTERVAL_MS = 3600000;
export const RETENTION_SWEEP_BATCH_ROWS = 20;
export const RETENTION_SWEEP_BATCHES_MAX = 50;
export const DAY_MS = 86400000;

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
