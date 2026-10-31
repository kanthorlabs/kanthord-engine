import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { bucketEnd, bucketStart } from "./analytics-bucket.ts";
import {
  ANALYTICS_RANGE_DAYS_DEFAULT,
  ANALYTICS_RANGE_DAYS_MAX,
  type AnalyticsFlowQuery,
  FlowCompare,
  FlowGrain,
  type FlowRead,
} from "./contract.ts";
import {
  FLOW_DAY_RETENTION_DAYS,
  FLOW_HOUR_RANGE_DAYS_MAX,
  FLOW_HOUR_RETENTION_DAYS,
} from "./flow-model.ts";
import { DAY_MS, retentionCutoff } from "./retention.ts";

const RANGE_INVALID_CODE = "tracking.filter.range_invalid";
const RETENTION_DAYS: Readonly<Record<FlowGrain, number>> = {
  [FlowGrain.Hour]: FLOW_HOUR_RETENTION_DAYS,
  [FlowGrain.Day]: FLOW_DAY_RETENTION_DAYS,
};

export interface FlowWindows {
  grain: FlowGrain;
  window: FlowRead["window"];
  previous_window: FlowRead["previous_window"];
  cut: number | null;
}

function rangeInvalid(message: string): never {
  throw new OperationError(HttpStatus.BadRequest, RANGE_INVALID_CODE, message);
}

function startOf(time: number, grain: FlowGrain): number {
  const start = bucketStart(time, grain);
  assert.ok(start !== null);
  return start;
}

function endOf(time: number, grain: FlowGrain): number {
  const start = startOf(time, grain);
  return start === time ? time : bucketEnd(start, grain);
}

function checkedRange(
  query: Pick<AnalyticsFlowQuery, "from" | "to">,
  now: number,
): { from: number; to: number } {
  const to = query.to ?? now;
  const from = query.from ?? to - ANALYTICS_RANGE_DAYS_DEFAULT * DAY_MS;
  if (from > to) return rangeInvalid("from is after to.");
  if (to - from > ANALYTICS_RANGE_DAYS_MAX * DAY_MS)
    return rangeInvalid(
      `The range is longer than ${ANALYTICS_RANGE_DAYS_MAX} days.`,
    );
  return { from, to };
}

function grainOf(
  bucket: FlowGrain | undefined,
  range: { from: number; to: number },
): FlowGrain {
  const hourAllowed =
    range.to - range.from <= FLOW_HOUR_RANGE_DAYS_MAX * DAY_MS;
  if (bucket === undefined) return hourAllowed ? FlowGrain.Hour : FlowGrain.Day;
  if (bucket === FlowGrain.Hour && !hourAllowed)
    return rangeInvalid(
      `The bucket hour takes a range of at most ${FLOW_HOUR_RANGE_DAYS_MAX} days.`,
    );
  return bucket;
}

function bucketListOf(from: number, to: number, grain: FlowGrain): number[] {
  const buckets: number[] = [];
  for (let start = from; start < to; start = bucketEnd(start, grain))
    buckets.push(start);
  return buckets;
}

function previousWindowOf(
  compare: FlowCompare,
  grain: FlowGrain,
  window: FlowRead["window"],
  now: number,
  coverageStart: number | null,
): FlowRead["previous_window"] {
  if (compare === FlowCompare.None || coverageStart === null) return null;
  const from = window.from - (window.to - window.from);
  const cutoff = retentionCutoff(now, RETENTION_DAYS[grain]);
  if (from < cutoff || from < coverageStart) return null;
  return { from, to: window.from };
}

function cutOf(
  grain: FlowGrain,
  window: FlowRead["window"],
  now: number,
): number | null {
  const cut = endOf(window.now, FlowGrain.Hour) - (window.to - window.from);
  if (grain === FlowGrain.Hour) return cut;
  const dayStart = startOf(cut, FlowGrain.Day);
  if (dayStart === cut) return cut;
  const hourCutoff = retentionCutoff(now, FLOW_HOUR_RETENTION_DAYS);
  return dayStart < hourCutoff ? null : cut;
}

export function flowWindowOf(
  query: Pick<AnalyticsFlowQuery, "from" | "to" | "bucket" | "compare">,
  now: number,
  coverageStart: number | null,
): FlowWindows {
  const range = checkedRange(query, now);
  const grain = grainOf(query.bucket, range);
  const from = startOf(range.from, grain);
  const to = endOf(range.to, grain);
  const window = {
    from,
    to,
    now: Math.min(range.to, now),
    bucket: grain,
    buckets: bucketListOf(from, to, grain),
  };
  const previous_window = previousWindowOf(
    query.compare,
    grain,
    window,
    now,
    coverageStart,
  );
  return {
    grain,
    window,
    previous_window,
    cut: previous_window === null ? null : cutOf(grain, window, now),
  };
}
