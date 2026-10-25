import assert from "node:assert/strict";
import { AnalyticsBucket } from "./contract.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const FIRST_MONDAY_MS = 4 * DAY_MS;
const BUCKET_SIZES: Record<Exclude<AnalyticsBucket, "none">, number> = {
  [AnalyticsBucket.Hour]: HOUR_MS,
  [AnalyticsBucket.Day]: DAY_MS,
  [AnalyticsBucket.Week]: WEEK_MS,
};
const BUCKET_ORIGINS: Record<Exclude<AnalyticsBucket, "none">, number> = {
  [AnalyticsBucket.Hour]: 0,
  [AnalyticsBucket.Day]: 0,
  [AnalyticsBucket.Week]: FIRST_MONDAY_MS,
};

export function bucketStart(
  time: number,
  bucket: AnalyticsBucket,
): number | null {
  if (bucket === AnalyticsBucket.None) return null;
  const size = BUCKET_SIZES[bucket];
  const origin = BUCKET_ORIGINS[bucket];
  return Math.floor((time - origin) / size) * size + origin;
}

export function bucketEnd(start: number, bucket: AnalyticsBucket): number {
  assert.ok(bucket !== AnalyticsBucket.None);
  return start + BUCKET_SIZES[bucket];
}
